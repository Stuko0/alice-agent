package main

import (
	"bytes"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// End-to-end check against the committed preview fixtures. The unit tests
// cover the mechanics (traversal, tokens, headers); this asserts the actual
// shape of a real page — the exact set of requests a browser makes for the
// relative-asset fixture that used to fail under file://.
func TestPreviewServerServesCommittedFixtures(t *testing.T) {
	fixtures := filepath.Join("..", "desktop", "preview-fixtures")

	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)

	started, err := svc.StartForFile(filepath.Join(fixtures, "html-rel-assets", "index.html"))
	if err != nil {
		t.Fatalf("StartForFile: %v", err)
	}
	base := started["url"]

	resp, body := previewTestGet(t, base)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("index status = %d", resp.StatusCode)
	}
	for _, want := range []string{"./styles.css", "./logo.svg", `type="module"`, "./app.js"} {
		if !strings.Contains(body, want) {
			t.Fatalf("index is missing %q", want)
		}
	}

	cases := []struct {
		path     string
		wantType string
	}{
		{"styles.css", "text/css"},
		{"app.js", "text/javascript"},
		{"data.json", "application/json"},
		{"logo.svg", "image/svg+xml"},
	}

	for _, tc := range cases {
		resp, body := previewTestGet(t, base+tc.path)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%s status = %d", tc.path, resp.StatusCode)
		}
		if got := resp.Header.Get("Content-Type"); !strings.Contains(got, tc.wantType) {
			t.Fatalf("%s content-type = %q, want %q", tc.path, got, tc.wantType)
		}
		if body == "" {
			t.Fatalf("%s served an empty body", tc.path)
		}
	}

	// Unknown assets must 404, not leak the directory listing.
	if resp, _ := previewTestGet(t, base+"missing.css"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("missing asset status = %d, want 404", resp.StatusCode)
	}
}

func TestPreviewServerThumbnailsGeneratedFixture(t *testing.T) {
	path := filepath.Join("..", "desktop", "preview-fixtures", "large", "img-huge.png")
	if _, err := os.Stat(path); err != nil {
		t.Skip("run `node apps/desktop/scripts/gen-preview-fixtures.mjs` to generate large fixtures")
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
	if decoded.Bounds().Dx() > previewImageThumbTargetDim || decoded.Bounds().Dy() > previewImageThumbTargetDim {
		t.Fatalf("thumbnail bounds = %v, want both axes <= %d", decoded.Bounds(), previewImageThumbTargetDim)
	}
	if len(raw) >= int(mustFileSize(t, path)) {
		t.Fatalf("thumbnail (%d bytes) is not smaller than the source", len(raw))
	}
}

func mustFileSize(t *testing.T, path string) int64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

func TestPreviewServerServesInteractionFixture(t *testing.T) {
	fixtures := filepath.Join("..", "desktop", "preview-fixtures")

	svc := NewPreviewServerService()
	t.Cleanup(svc.Shutdown)

	started, err := svc.StartForFile(filepath.Join(fixtures, "html-form-demo.html"))
	if err != nil {
		t.Fatalf("StartForFile: %v", err)
	}

	resp, body := previewTestGet(t, started["url"])
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("form fixture status = %d", resp.StatusCode)
	}
	for _, want := range []string{"<form", "showModal", "download=", `target="_blank"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("form fixture is missing %q", want)
		}
	}
}
