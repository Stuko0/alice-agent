package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestStatFileSizeMtime(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "notes.md")
	if err := os.WriteFile(path, []byte("# hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	stat, err := NewFSService().StatFile(path)
	if err != nil {
		t.Fatalf("StatFile: %v", err)
	}
	if stat.ByteSize != 8 {
		t.Fatalf("ByteSize = %d, want 8", stat.ByteSize)
	}
	if stat.MtimeMs == 0 {
		t.Fatal("MtimeMs = 0, want a real timestamp")
	}
	if stat.Binary {
		t.Fatal("markdown flagged as binary")
	}
	if stat.Language != "markdown" {
		t.Fatalf("Language = %q, want markdown", stat.Language)
	}
	// Windows resolves extensions from the registry and commonly has no entry
	// for .md, so the generic type is legitimate there; the assertion is about
	// a MIME type being reported at all (plus markdown detection above), not
	// about the host's mime database.
	if stat.MimeType == "" {
		t.Fatal("MimeType = \"\", want a content type")
	}

	if runtime.GOOS != "windows" && !strings.Contains(stat.MimeType, "markdown") && !strings.Contains(stat.MimeType, "text/plain") {
		t.Fatalf("MimeType = %q", stat.MimeType)
	}
}

func TestStatFileBinarySniff(t *testing.T) {
	dir := t.TempDir()
	textPath := filepath.Join(dir, "accented.txt")
	if err := os.WriteFile(textPath, []byte("café, señor, acción\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	binPath := filepath.Join(dir, "blob.bin")
	if err := os.WriteFile(binPath, []byte{0x00, 0x01, 0x02, 0x03}, 0o644); err != nil {
		t.Fatal(err)
	}

	svc := NewFSService()

	textStat, err := svc.StatFile(textPath)
	if err != nil {
		t.Fatal(err)
	}
	if textStat.Binary {
		t.Fatal("accented UTF-8 flagged as binary")
	}

	binStat, err := svc.StatFile(binPath)
	if err != nil {
		t.Fatal(err)
	}
	if !binStat.Binary {
		t.Fatal("NUL-byte file not flagged as binary")
	}
}

func TestReadFileTextLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.log")
	content := strings.Repeat("x", 4096)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	svc := NewFSService()

	limited, err := svc.ReadFileTextLimited(path, 1024)
	if err != nil {
		t.Fatalf("ReadFileTextLimited: %v", err)
	}
	if len(limited.Text) != 1024 {
		t.Fatalf("read %d bytes, want 1024", len(limited.Text))
	}
	if !limited.Truncated {
		t.Fatal("Truncated = false, want true")
	}
	if limited.ByteSize != int64(len(content)) {
		t.Fatalf("ByteSize = %d, want %d", limited.ByteSize, len(content))
	}

	full, err := svc.ReadFileTextLimited(path, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(full.Text) != len(content) || full.Truncated {
		t.Fatalf("default-limit read: len=%d truncated=%v (file is 4KB)", len(full.Text), full.Truncated)
	}
}

func TestReadFileTextDefaultLimitIs512KB(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "huge.txt")
	content := strings.Repeat("a", defaultPreviewTextLimit+1024)
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := NewFSService().ReadFileText(path)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Truncated {
		t.Fatal("default read of a >512KB file was not truncated")
	}
	if len(result.Text) != defaultPreviewTextLimit {
		t.Fatalf("read %d bytes, want %d", len(result.Text), defaultPreviewTextLimit)
	}
}

func TestReadFileDataUrlLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "huge.bin")
	if err := os.WriteFile(path, make([]byte, defaultPreviewImageLimit+1), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := NewFSService().ReadFileDataUrl(path); err == nil {
		t.Fatal("ReadFileDataUrl accepted an oversized file")
	}
}

func TestWriteTextFileSizeCap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.txt")
	payload := strings.Repeat("a", maxWriteBytes+1)

	if err := NewFSService().WriteTextFile(path, payload); err == nil {
		t.Fatal("WriteTextFile accepted an oversized payload")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("oversized write left a partial file on disk")
	}
}
