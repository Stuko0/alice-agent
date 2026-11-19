package main

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestNormalizePreviewTargetHTTP(t *testing.T) {
	target, err := NewFSService().NormalizePreviewTarget("https://example.com/docs/guide.html", "")
	if err != nil {
		t.Fatalf("NormalizePreviewTarget: %v", err)
	}
	if target.Kind != "url" {
		t.Fatalf("Kind = %q, want url", target.Kind)
	}
	if target.URL != "https://example.com/docs/guide.html" {
		t.Fatalf("URL = %q", target.URL)
	}
	if target.Label != "guide.html" {
		t.Fatalf("Label = %q, want guide.html", target.Label)
	}
}

func TestNormalizePreviewTargetRelativeAndKinds(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, body []byte) string {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, body, 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	write("page.html", []byte("<!doctype html>"))
	write("pic.png", []byte{0x89, 0x50, 0x4e, 0x47})
	write("notes.md", []byte("# hi"))
	write("blob.bin", []byte{0x00, 0x01})

	svc := NewFSService()
	cases := []struct {
		name        string
		raw         string
		wantKind    string
		wantPreview string
		wantLang    string
	}{
		{"html", "page.html", "file", "html", "html"},
		{"image", "pic.png", "file", "image", "text"},
		{"markdown", "notes.md", "file", "text", "markdown"},
		{"binary", "blob.bin", "file", "text", "text"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			target, err := svc.NormalizePreviewTarget(tc.raw, dir)
			if err != nil {
				t.Fatalf("NormalizePreviewTarget(%q): %v", tc.raw, err)
			}
			if target.Kind != tc.wantKind {
				t.Fatalf("Kind = %q, want %q", target.Kind, tc.wantKind)
			}
			if target.PreviewKind != tc.wantPreview {
				t.Fatalf("PreviewKind = %q, want %q", target.PreviewKind, tc.wantPreview)
			}
			if target.Language != tc.wantLang {
				t.Fatalf("Language = %q, want %q", target.Language, tc.wantLang)
			}
			if !filepath.IsAbs(target.Path) {
				t.Fatalf("Path = %q, want absolute", target.Path)
			}
			if !strings.HasPrefix(target.URL, "file://") {
				t.Fatalf("URL = %q, want file://", target.URL)
			}
		})
	}

	binaryTarget, err := svc.NormalizePreviewTarget("blob.bin", dir)
	if err != nil {
		t.Fatal(err)
	}
	if !binaryTarget.Binary {
		t.Fatal("blob.bin should be flagged binary")
	}
}

func TestNormalizePreviewTargetFileURLWithSpaces(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "my notes.md")
	if err := os.WriteFile(path, []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Build a proper file URL: "file://" + "C:\\dir" is not one on Windows
	// (it needs file:///C:/...), and this test is about the normalizer, not
	// about how a caller stitches the string together.
	raw := (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()

	target, err := NewFSService().NormalizePreviewTarget(raw, "")
	if err != nil {
		t.Fatalf("NormalizePreviewTarget(%q): %v", raw, err)
	}
	if target.Path != path {
		t.Fatalf("Path = %q, want %q", target.Path, path)
	}

	parsed, err := url.Parse(target.URL)
	if err != nil {
		t.Fatalf("URL %q unparseable: %v", target.URL, err)
	}

	decoded, err := url.PathUnescape(parsed.Path)
	if err != nil {
		t.Fatalf("PathUnescape(%q): %v", parsed.Path, err)
	}

	// On Windows the URL path keeps the drive letter's leading slash.
	if runtime.GOOS == "windows" && strings.HasPrefix(decoded, "/") && len(decoded) > 2 && decoded[2] == ':' {
		decoded = decoded[1:]
	}

	if filepath.FromSlash(decoded) != path {
		t.Fatalf("URL round trip = %q, want %q", decoded, path)
	}
}

func TestNormalizePreviewTargetUppercaseExtension(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "README.MD")
	if err := os.WriteFile(path, []byte("# hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	target, err := NewFSService().NormalizePreviewTarget("README.MD", dir)
	if err != nil {
		t.Fatal(err)
	}
	if target.Language != "markdown" {
		t.Fatalf("Language = %q, want markdown (extension matching is case-insensitive)", target.Language)
	}
}

func TestNormalizePreviewTargetRejectsEmpty(t *testing.T) {
	if _, err := NewFSService().NormalizePreviewTarget("   ", ""); err == nil {
		t.Fatal("NormalizePreviewTarget accepted an empty target")
	}
}

func TestPathFromFileURL(t *testing.T) {
	cases := []struct {
		raw  string
		want string
	}{
		{"file:///tmp/my%20notes.md", filepath.FromSlash("/tmp/my notes.md")},
		{"file:///C:/Users/Stuko/my%20notes.md", filepath.FromSlash("C:/Users/Stuko/my notes.md")},
		{"file://server/share/dir/file.txt", filepath.FromSlash("//server/share/dir/file.txt")},
	}

	for _, tc := range cases {
		if got := pathFromFileURL(tc.raw); got != tc.want {
			t.Fatalf("pathFromFileURL(%q) = %q, want %q", tc.raw, got, tc.want)
		}
	}
}
