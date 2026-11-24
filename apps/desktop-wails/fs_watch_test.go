package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type emittedEvent struct {
	name    string
	payload map[string]string
}

// captureEmit replaces the renderer emit with a channel-backed recorder so
// the watch→debounce→event chain is observable without a Wails app instance.
func captureEmit(t *testing.T, fw *FileWatchService) chan emittedEvent {
	t.Helper()
	events := make(chan emittedEvent, 8)
	fw.emit = func(event string, payload interface{}) {
		fields, _ := payload.(map[string]string)
		select {
		case events <- emittedEvent{name: event, payload: fields}:
		default:
		}
	}
	return events
}

func TestPreviewPathFromTarget(t *testing.T) {
	cases := []struct {
		name    string
		in      string
		want    string
		wantErr bool
	}{
		{name: "plain path", in: "/tmp/notes.md", want: "/tmp/notes.md"},
		{name: "file url", in: "file:///tmp/notes.md", want: "/tmp/notes.md"},
		{name: "file url with escaped space", in: "file:///tmp/my%20notes.md", want: "/tmp/my notes.md"},
		{name: "empty", in: "   ", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := previewPathFromTarget(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q, got %q", tc.in, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestStartFileWatchEmitsOnChange(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "preview.html")
	if err := os.WriteFile(target, []byte("<h1>v1</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}

	fw := NewFileWatchService()
	events := captureEmit(t, fw)

	watch, err := fw.StartFileWatch(target)
	if err != nil {
		t.Fatalf("StartFileWatch: %v", err)
	}
	if watch["id"] == "" {
		t.Fatal("expected a non-empty watch id")
	}
	if watch["path"] != target {
		t.Fatalf("path = %q, want %q", watch["path"], target)
	}

	if err := os.WriteFile(target, []byte("<h1>v2</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}

	select {
	case ev := <-events:
		if ev.name != previewFileChangedEvent {
			t.Fatalf("event = %q, want %q", ev.name, previewFileChangedEvent)
		}
		if ev.payload["id"] != watch["id"] {
			t.Fatalf("payload id = %q, want %q", ev.payload["id"], watch["id"])
		}
		if ev.payload["url"] != "file://"+target {
			t.Fatalf("payload url = %q, want %q", ev.payload["url"], "file://"+target)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no preview change event within 5s — the pane would stay stale")
	}

	if stopped, err := fw.StopFileWatch(watch["id"]); err != nil || !stopped {
		t.Fatalf("StopFileWatch = (%v, %v), want (true, nil)", stopped, err)
	}
	// Idempotent: a second stop (renderer cleanup racing ours) is not an error.
	if stopped, err := fw.StopFileWatch(watch["id"]); err != nil || stopped {
		t.Fatalf("second StopFileWatch = (%v, %v), want (false, nil)", stopped, err)
	}
}

func TestStartFileWatchCoalescesBurst(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "page.md")
	if err := os.WriteFile(target, []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}

	fw := NewFileWatchService()
	events := captureEmit(t, fw)
	if _, err := fw.StartFileWatch(target); err != nil {
		t.Fatal(err)
	}

	// One editor save is a burst (truncate + write + chmod); the pane must
	// reload once, not once per syscall.
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			_ = os.WriteFile(target, []byte("rev"), 0o644)
		}(i)
	}
	wg.Wait()

	count := 0
	deadline := time.After(3 * time.Second)
	for {
		select {
		case <-events:
			count++
			continue
		case <-deadline:
		}
		break
	}
	if count == 0 {
		t.Fatal("no event after writes")
	}
	if count > 2 {
		t.Fatalf("burst produced %d reloads; expected coalescing to 1-2", count)
	}
}

func TestStartFileWatchRejectsMissingFile(t *testing.T) {
	fw := NewFileWatchService()
	if _, err := fw.StartFileWatch(filepath.Join(t.TempDir(), "nope.md")); err == nil {
		t.Fatal("expected an error for a missing file")
	}
}

func TestStopFileWatchUnknownIDIsSafe(t *testing.T) {
	fw := NewFileWatchService()
	if stopped, err := fw.StopFileWatch("nope"); err != nil || stopped {
		t.Fatalf("got (%v, %v), want (false, nil)", stopped, err)
	}
}

func TestShutdownReleasesEveryWatch(t *testing.T) {
	dir := t.TempDir()
	fw := NewFileWatchService()
	captureEmit(t, fw)

	var ids []string
	for _, name := range []string{"a.md", "b.md"} {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		watch, err := fw.StartFileWatch(path)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, watch["id"])
	}

	fw.Shutdown()

	fw.mu.Lock()
	remaining := len(fw.watches)
	fw.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("Shutdown left %d watches open", remaining)
	}
	for _, id := range ids {
		if stopped, _ := fw.StopFileWatch(id); stopped {
			t.Fatalf("watch %s survived Shutdown", id)
		}
	}
}
