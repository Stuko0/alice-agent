package main

import (
	"bytes"
	"image"
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

func previewTestClient() *http.Client {
	return &http.Client{Timeout: 3 * time.Second}
}

func previewTestGet(t *testing.T, rawURL string) (*http.Response, string) {
	t.Helper()
	resp, err := previewTestClient().Get(rawURL)
	if err != nil {
		t.Fatalf("GET %s: %v", rawURL, err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatalf("read body %s: %v", rawURL, err)
	}
	return resp, string(body)
}

func writePreviewFixture(t *testing.T, dir string) {
	t.Helper()
	files := map[string]string{
		"index.html": `<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head>` +
			`<body><h1>Preview</h1><img src="./a.png"><script type="module" src="./app.js"></script></body></html>`,
		"style.css": "h1 { color: rgb(1, 2, 3); }",
		"app.js":    "export const answer = 42",
		"data.json": `{"ok":true}`,
		".env":      "SECRET=top-secret",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	// 1x1 PNG so the img tag resolves like a real asset.
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, image.White)
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.png"), buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write a.png: %v", err)
	}
}

func TestPreviewServerServesFileAndRelativeAssets(t *testing.T) {
	dir := t.TempDir()
	writePreviewFixture(t, dir)

	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)

	started, err := svc.StartForFile(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatalf("StartForFile: %v", err)
	}
	base := started["url"]

	resp, body := previewTestGet(t, base)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("index status = %d, want 200", resp.StatusCode)
	}
	if !strings.Contains(body, "type=\"module\"") {
		t.Fatalf("index body missing module script: %q", body)
	}
	if got := resp.Header.Get("Content-Type"); !strings.Contains(got, "text/html") {
		t.Fatalf("index content-type = %q", got)
	}

	cases := map[string]string{
		"style.css": "text/css",
		"app.js":    "text/javascript",
		"data.json": "application/json",
		"a.png":     "image/png",
	}
	for name, wantType := range cases {
		resp, _ := previewTestGet(t, base+name)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", name, resp.StatusCode)
		}
		if got := resp.Header.Get("Content-Type"); !strings.Contains(got, wantType) {
			t.Fatalf("%s content-type = %q, want %q", name, got, wantType)
		}
	}
}

func TestPreviewServerRejectsTraversal(t *testing.T) {
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
	t.Cleanup(svc.Shutdown)
	started, err := svc.StartForFile(filepath.Join(inside, "index.html"))
	if err != nil {
		t.Fatalf("StartForFile: %v", err)
	}

	resp, _ := previewTestGet(t, started["url"]+"escape.txt")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("symlink escape status = %d, want 403", resp.StatusCode)
	}

	// Dotfile / secret material is refused even when it lives inside the mount.
	resp, _ = previewTestGet(t, started["url"]+".env")
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("dotfile status = %d, want 403", resp.StatusCode)
	}

	// A URL-encoded traversal collapses to the mount root, never the parent.
	resp, _ = previewTestGet(t, started["url"]+"%2e%2e%2foutside%2fsecret.txt")
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("encoded traversal unexpectedly served content")
	}

	// Windows separators smuggled through the URL must not traverse either.
	resp, _ = previewTestGet(t, started["url"]+"..%5Coutside%5Csecret.txt")
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("backslash traversal unexpectedly served content")
	}
}

func TestPreviewServerTokenRequired(t *testing.T) {
	dir := t.TempDir()
	writePreviewFixture(t, dir)

	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)
	started, err := svc.StartForFile(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatalf("StartForFile: %v", err)
	}

	parsed, err := url.Parse(started["url"])
	if err != nil {
		t.Fatal(err)
	}
	wrong := "http://" + parsed.Host + previewMountPrefix + "deadbeef/"
	resp, _ := previewTestGet(t, wrong)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("wrong token status = %d, want 404", resp.StatusCode)
	}
}

func TestPreviewServerLoopbackOnly(t *testing.T) {
	dir := t.TempDir()
	writePreviewFixture(t, dir)

	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)
	started, err := svc.StartForFile(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatalf("StartForFile: %v", err)
	}

	parsed, err := url.Parse(started["url"])
	if err != nil {
		t.Fatal(err)
	}
	host, _, err := net.SplitHostPort(parsed.Host)
	if err != nil {
		t.Fatal(err)
	}
	if host != "127.0.0.1" {
		t.Fatalf("preview bound to %q, want 127.0.0.1", host)
	}
}

func TestPreviewServerStopReleasesPort(t *testing.T) {
	dir := t.TempDir()
	writePreviewFixture(t, dir)

	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)
	started, err := svc.StartForFile(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatalf("StartForFile: %v", err)
	}

	stopped, err := svc.Stop(started["id"])
	if err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if !stopped {
		t.Fatal("Stop returned false for a live session")
	}

	client := &http.Client{Timeout: 500 * time.Millisecond}
	if resp, err := client.Get(started["url"]); err == nil {
		resp.Body.Close()
		t.Fatal("preview server still answering after Stop")
	}

	// Idempotent: stopping twice is a no-op, not an error.
	if again, err := svc.Stop(started["id"]); err != nil || again {
		t.Fatalf("second Stop = (%v, %v), want (false, nil)", again, err)
	}
}

func TestPreviewServerHeaders(t *testing.T) {
	dir := t.TempDir()
	writePreviewFixture(t, dir)

	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)
	started, err := svc.StartForFile(filepath.Join(dir, "index.html"))
	if err != nil {
		t.Fatalf("StartForFile: %v", err)
	}

	resp, _ := previewTestGet(t, started["url"])
	if got := resp.Header.Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want no-store", got)
	}
	if got := resp.Header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
	}
	csp := resp.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "connect-src 'self'") {
		t.Fatalf("CSP = %q, want connect-src 'self'", csp)
	}
}

func TestPreviewServerRejectsDirectoryTarget(t *testing.T) {
	dir := t.TempDir()
	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)

	if _, err := svc.StartForFile(dir); err == nil {
		t.Fatal("StartForFile accepted a directory")
	}
}

func TestPreviewServerImageThumbnailAndCache(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "huge.png")

	// Wide instead of tall: exercises the axis-max branch without paying for
	// a 3000x3000 encode in the test.
	img := image.NewRGBA(image.Rect(0, 0, 3000, 20))
	for x := 0; x < 3000; x++ {
		img.Set(x, 0, image.Black)
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)

	started, err := svc.StartForImage(path)
	if err != nil {
		t.Fatalf("StartForImage: %v", err)
	}

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
	if decoded.Bounds().Dx() > previewImageThumbTargetDim {
		t.Fatalf("thumbnail width = %d, want <= %d", decoded.Bounds().Dx(), previewImageThumbTargetDim)
	}

	svc.mu.Lock()
	generations := svc.imgGen
	svc.mu.Unlock()
	if generations != 1 {
		t.Fatalf("thumbnail generations = %d, want 1", generations)
	}

	// A second preview of the same file reuses the cached thumbnail.
	if _, err := svc.StartForImage(path); err != nil {
		t.Fatalf("second StartForImage: %v", err)
	}
	svc.mu.Lock()
	generations = svc.imgGen
	svc.mu.Unlock()
	if generations != 1 {
		t.Fatalf("thumbnail regenerated on cache hit (generations = %d)", generations)
	}
}

func TestPreviewServerImagePassthroughGIF(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "anim.gif")

	// Minimal 1x1 GIF89a. Passthrough is by extension, so the bytes only need
	// to survive the round trip untouched.
	gifBytes := []byte{
		0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
		0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
		0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
		0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
	}
	if err := os.WriteFile(path, gifBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)
	started, err := svc.StartForImage(path)
	if err != nil {
		t.Fatalf("StartForImage: %v", err)
	}

	resp, err := previewTestClient().Get(started["url"])
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	if !bytes.Equal(raw, gifBytes) {
		t.Fatal("GIF preview was re-encoded; animated GIFs must pass through")
	}
	if got := resp.Header.Get("Content-Type"); !strings.Contains(got, "image/gif") {
		t.Fatalf("content-type = %q, want image/gif", got)
	}
}

func TestPreviewPathDenied(t *testing.T) {
	denied := []string{
		".env", ".git/config", "sub/.ssh/id_rsa", "server.pem", "id_rsa", "app.sqlite",
		"certs/client.key", "bin/tool.exe", "lib/libfoo.so", "pkg/app.dylib",
	}
	for _, rel := range denied {
		if !previewPathDenied(rel) {
			t.Errorf("previewPathDenied(%q) = false, want true", rel)
		}
	}

	allowed := []string{"index.html", "assets/app.js", "img/logo.png", "docs/readme.md"}
	for _, rel := range allowed {
		if previewPathDenied(rel) {
			t.Errorf("previewPathDenied(%q) = true, want false", rel)
		}
	}
}
