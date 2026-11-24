package main

// End-to-end preview harness.
//
// This is the automatable half of the P3.2 WebKit matrix: it drives the real
// loopback origin over HTTP and asserts the browser-visible contract (status,
// MIME, headers, sandbox-relevant refusals, thumbnail dimensions, port
// release). The GUI half (CSS/JS actually painting inside WebKitGTK) is
// documented as manual in apps/desktop/preview-fixtures/README.md.
//
// `apps/desktop/scripts/e2e-preview-wails.mjs` generates the large fixtures and
// runs this test with `-json`, turning each subtest into a report row.

import (
	"bytes"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func e2eFixturesDir() string {
	return filepath.Join("..", "desktop", "preview-fixtures")
}

func e2eStartFile(t *testing.T, svc *PreviewServerService, path string) map[string]string {
	t.Helper()
	started, err := svc.StartForFile(path)
	if err != nil {
		t.Fatalf("StartForFile(%s): %v", path, err)
	}
	t.Cleanup(svc.Shutdown)
	return started
}

func e2eExpectStatus(t *testing.T, url string, want int) (*http.Response, string) {
	t.Helper()
	resp, body := previewTestGet(t, url)
	if resp.StatusCode != want {
		t.Fatalf("%s status = %d, want %d", url, resp.StatusCode, want)
	}
	return resp, body
}

func e2eExpectMIME(t *testing.T, resp *http.Response, want string) {
	t.Helper()
	if got := resp.Header.Get("Content-Type"); !strings.Contains(got, want) {
		t.Fatalf("content-type = %q, want %q", got, want)
	}
}

func TestPreviewE2E(t *testing.T) {
	site := filepath.Join(e2eFixturesDir(), "html-rel-assets")

	t.Run("serve_index_html", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		resp, body := e2eExpectStatus(t, started["url"], http.StatusOK)
		e2eExpectMIME(t, resp, "text/html")

		for _, want := range []string{"./styles.css", "./logo.svg", `type="module"`, "./app.js"} {
			if !strings.Contains(body, want) {
				t.Fatalf("index missing %q", want)
			}
		}
	})

	t.Run("serve_relative_css", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		resp, body := e2eExpectStatus(t, started["url"]+"styles.css", http.StatusOK)
		e2eExpectMIME(t, resp, "text/css")
		if !strings.Contains(body, "rgb(180, 24, 96)") {
			t.Fatalf("css body unexpected: %q", body)
		}
	})

	t.Run("serve_es_module_mime", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		resp, body := e2eExpectStatus(t, started["url"]+"app.js", http.StatusOK)
		e2eExpectMIME(t, resp, "text/javascript")
		if !strings.Contains(body, "fixtureResult") {
			t.Fatalf("module body unexpected: %q", body)
		}
	})

	t.Run("serve_json_for_fetch", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		resp, body := e2eExpectStatus(t, started["url"]+"data.json", http.StatusOK)
		e2eExpectMIME(t, resp, "application/json")
		if !strings.Contains(body, `"module": true`) {
			t.Fatalf("json body unexpected: %q", body)
		}
	})

	t.Run("serve_svg_image", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		resp, _ := e2eExpectStatus(t, started["url"]+"logo.svg", http.StatusOK)
		e2eExpectMIME(t, resp, "image/svg+xml")
	})

	t.Run("missing_asset_is_404", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		e2eExpectStatus(t, started["url"]+"missing.css", http.StatusNotFound)
	})

	t.Run("dotfile_is_403", func(t *testing.T) {
		dir := t.TempDir()
		writePreviewFixture(t, dir)

		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(dir, "index.html"))

		e2eExpectStatus(t, started["url"]+".env", http.StatusForbidden)
	})

	t.Run("symlink_escape_is_403", func(t *testing.T) {
		root := t.TempDir()
		inside := filepath.Join(root, "site")
		outside := filepath.Join(root, "outside")
		if err := os.MkdirAll(inside, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(outside, 0o755); err != nil {
			t.Fatal(err)
		}
		writePreviewFixture(t, inside)
		if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(inside, "escape.txt")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}

		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(inside, "index.html"))

		e2eExpectStatus(t, started["url"]+"escape.txt", http.StatusForbidden)
		e2eExpectStatus(t, started["url"]+"..%5Coutside%5Csecret.txt", http.StatusNotFound)
	})

	t.Run("invalid_token_is_404", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		parsed, err := url.Parse(started["url"])
		if err != nil {
			t.Fatal(err)
		}
		e2eExpectStatus(t, "http://"+parsed.Host+previewMountPrefix+"deadbeef/", http.StatusNotFound)
	})

	t.Run("loopback_only_bind", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		parsed, err := url.Parse(started["url"])
		if err != nil {
			t.Fatal(err)
		}
		host, _, err := net.SplitHostPort(parsed.Host)
		if err != nil {
			t.Fatal(err)
		}
		if host != "127.0.0.1" {
			t.Fatalf("bound to %q, want 127.0.0.1", host)
		}
	})

	t.Run("csp_and_nosniff_headers", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		resp, _ := e2eExpectStatus(t, started["url"], http.StatusOK)
		if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Fatalf("X-Content-Type-Options = %q", got)
		}
		if got := resp.Header.Get("Cache-Control"); !strings.Contains(got, "no-store") {
			t.Fatalf("Cache-Control = %q", got)
		}
		if got := resp.Header.Get("Content-Security-Policy"); !strings.Contains(got, "connect-src 'self'") {
			t.Fatalf("CSP = %q", got)
		}
	})

	t.Run("form_fixture_served", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(e2eFixturesDir(), "html-form-demo.html"))

		_, body := e2eExpectStatus(t, started["url"], http.StatusOK)
		for _, want := range []string{"<form", "showModal", "download=", `target="_blank"`} {
			if !strings.Contains(body, want) {
				t.Fatalf("form fixture missing %q", want)
			}
		}
	})

	t.Run("thumbnail_dimensions", func(t *testing.T) {
		path := filepath.Join(e2eFixturesDir(), "large", "img-huge.png")
		if _, err := os.Stat(path); err != nil {
			t.Skip("run `node apps/desktop/scripts/gen-preview-fixtures.mjs` first")
		}

		svc := NewPreviewServerService()
		started, err := svc.StartForImage(path)
		if err != nil {
			t.Fatalf("StartForImage: %v", err)
		}
		t.Cleanup(svc.Shutdown)

		resp, err := previewTestClient().Get(started["url"])
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}

		decoded, err := png.Decode(bytes.NewReader(raw))
		if err != nil {
			t.Fatalf("thumbnail is not a png: %v", err)
		}
		bounds := decoded.Bounds()
		if bounds.Dx() > previewImageThumbTargetDim || bounds.Dy() > previewImageThumbTargetDim {
			t.Fatalf("thumbnail bounds = %v, want both axes <= %d", bounds, previewImageThumbTargetDim)
		}
	})

	t.Run("gif_passthrough", func(t *testing.T) {
		path := filepath.Join(e2eFixturesDir(), "large", "gif-anim.gif")
		if _, err := os.Stat(path); err != nil {
			t.Skip("run `node apps/desktop/scripts/gen-preview-fixtures.mjs` first")
		}

		svc := NewPreviewServerService()
		started, err := svc.StartForImage(path)
		if err != nil {
			t.Fatalf("StartForImage: %v", err)
		}
		t.Cleanup(svc.Shutdown)

		resp, err := previewTestClient().Get(started["url"])
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		original, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(raw, original) {
			t.Fatal("gif was re-encoded; animation frames would be lost")
		}
	})

	t.Run("port_released_on_stop", func(t *testing.T) {
		svc := NewPreviewServerService()
		started := e2eStartFile(t, svc, filepath.Join(site, "index.html"))

		parsed, err := url.Parse(started["url"])
		if err != nil {
			t.Fatal(err)
		}

		if stopped, err := svc.Stop(started["id"]); err != nil || !stopped {
			t.Fatalf("Stop = (%v, %v)", stopped, err)
		}

		// http.Server.Close() closes the listener synchronously, but the kernel
		// can still complete a handshake that was already in flight. Poll until
		// the origin stops answering (bounded, and a failure here means it never
		// does).
		client := &http.Client{Timeout: 250 * time.Millisecond}
		deadline := time.Now().Add(2 * time.Second)

		for {
			resp, err := client.Get(started["url"])
			if err != nil {
				return
			}
			resp.Body.Close()

			if time.Now().After(deadline) {
				t.Fatalf("preview origin at %s still answering after Stop", parsed.Host)
			}
			time.Sleep(20 * time.Millisecond)
		}
	})
}
