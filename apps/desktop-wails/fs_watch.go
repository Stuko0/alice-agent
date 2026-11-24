package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Preview live-reload, ported from the Electron shell.
//
// Electron watched the previewed file in the main process
// (apps/desktop/electron/main.cjs: watchPreviewFile → fs.watch + debounce →
// IPC "alice:preview:file-changed"). The Wails port shipped a renderer stub
// that resolved immediately and never fired, so editing a file while its
// preview was open no longer refreshed the pane — a silent regression that
// only showed up as "the preview is stale until I reopen it".
//
// This restores the behavior on the Go side: one fsnotify watcher per
// previewed file, debounced, emitting `alice:preview:file-changed`, which
// the bridge forwards to the renderer's existing subscription. The payload
// keeps Electron's shape ({id, path, url}) so preview-pane.tsx needs no
// change at all.

const previewFileChangedEvent = "alice:preview:file-changed"
const previewWatchDebounce = 200 * time.Millisecond

type previewWatch struct {
	id      string
	path    string
	watcher *fsnotify.Watcher
	timerMu sync.Mutex
	timer   *time.Timer
}

// FileWatchService owns every active preview watch. Separate from FSService
// so the file-reading service stays a plain, easy-to-test surface; both are
// bound through App, exactly like the rest of the desktop services.
type FileWatchService struct {
	ctx     context.Context
	mu      sync.Mutex
	watches map[string]*previewWatch
	seq     int
	// emit delivers an event to the renderer. Overridable so tests can
	// observe emissions without a running Wails app instance.
	emit func(event string, payload interface{})
}

func NewFileWatchService() *FileWatchService {
	fw := &FileWatchService{watches: map[string]*previewWatch{}}
	fw.emit = func(event string, payload interface{}) {
		if fw.ctx == nil {
			return
		}
		wailsruntime.EventsEmit(fw.ctx, event, payload)
	}
	return fw
}

func (fw *FileWatchService) SetContext(ctx context.Context) {
	fw.ctx = ctx
}

// previewPathFromTarget accepts the two shapes the renderer can hand over:
// a `file://` URL (what Electron received) or a plain filesystem path.
func previewPathFromTarget(target string) (string, error) {
	raw := strings.TrimSpace(target)
	if raw == "" {
		return "", fmt.Errorf("empty preview target")
	}
	if strings.HasPrefix(raw, "file://") {
		parsed, err := url.Parse(raw)
		if err != nil {
			return "", fmt.Errorf("invalid preview url: %w", err)
		}
		decoded, err := url.PathUnescape(parsed.Path)
		if err != nil {
			return "", fmt.Errorf("invalid preview url path: %w", err)
		}
		return decoded, nil
	}
	return raw, nil
}

// StartFileWatch watches the previewed file for changes and emits
// previewFileChangedEvent on the Wails event bus. Returns the watch id plus
// the resolved path (the renderer keeps the id to stop the watch later).
func (fw *FileWatchService) StartFileWatch(target string) (map[string]string, error) {
	filePath, err := previewPathFromTarget(target)
	if err != nil {
		return nil, err
	}
	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve preview path: %w", err)
	}
	if _, err := os.Stat(absPath); err != nil {
		return nil, fmt.Errorf("preview file is not readable: %w", err)
	}

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("failed to create file watcher: %w", err)
	}
	// Watch the directory, not the file: editors commonly save by
	// write-temp-then-rename, which makes the original inode disappear and
	// silently kills a file-level watch.
	if err := watcher.Add(filepath.Dir(absPath)); err != nil {
		watcher.Close()
		return nil, fmt.Errorf("failed to watch preview directory: %w", err)
	}

	fw.mu.Lock()
	fw.seq++
	id := fmt.Sprintf("preview-%d-%d", time.Now().UnixNano(), fw.seq)
	watch := &previewWatch{id: id, path: absPath, watcher: watcher}
	fw.watches[id] = watch
	fw.mu.Unlock()

	go fw.pump(watch)

	return map[string]string{"id": id, "path": absPath}, nil
}

func (fw *FileWatchService) pump(watch *previewWatch) {
	targetBase := filepath.Base(watch.path)
	for {
		select {
		case event, ok := <-watch.watcher.Events:
			if !ok {
				return
			}
			if filepath.Base(event.Name) != targetBase {
				continue
			}
			if event.Op&(fsnotify.Write|fsnotify.Create|fsnotify.Rename|fsnotify.Chmod) == 0 {
				continue
			}
			fw.scheduleEmit(watch)
		case _, ok := <-watch.watcher.Errors:
			if !ok {
				return
			}
			// A watch error is not fatal for the pane; the next manual
			// reload still works, so swallow and keep the loop alive.
		}
	}
}

// scheduleEmit coalesces the burst of events a single save produces
// (truncate + write + rename + chmod) into one renderer reload, matching
// the Electron debounce the renderer also applies on its side.
func (fw *FileWatchService) scheduleEmit(watch *previewWatch) {
	watch.timerMu.Lock()
	defer watch.timerMu.Unlock()
	if watch.timer != nil {
		watch.timer.Stop()
	}
	watch.timer = time.AfterFunc(previewWatchDebounce, func() {
		if _, err := os.Stat(watch.path); err != nil {
			// File vanished mid-save (atomic replace in progress); the next
			// event carries the reload.
			return
		}
		fw.emit(previewFileChangedEvent, map[string]string{
			"id":   watch.id,
			"path": watch.path,
			"url":  "file://" + watch.path,
		})
	})
}

// StopFileWatch releases the watcher for an id. Idempotent: an unknown or
// already-stopped id reports false without error, because the renderer also
// calls it from a cleanup path that can race an earlier stop.
func (fw *FileWatchService) StopFileWatch(id string) (bool, error) {
	fw.mu.Lock()
	watch, ok := fw.watches[id]
	if ok {
		delete(fw.watches, id)
	}
	fw.mu.Unlock()
	if !ok {
		return false, nil
	}
	watch.timerMu.Lock()
	if watch.timer != nil {
		watch.timer.Stop()
		watch.timer = nil
	}
	watch.timerMu.Unlock()
	if err := watch.watcher.Close(); err != nil {
		return false, fmt.Errorf("failed to close preview watcher: %w", err)
	}
	return true, nil
}

// Shutdown releases every watch; called from OnShutdown so a desktop quit
// never leaks a directory watcher.
func (fw *FileWatchService) Shutdown() {
	fw.mu.Lock()
	ids := make([]string, 0, len(fw.watches))
	for id := range fw.watches {
		ids = append(ids, id)
	}
	fw.mu.Unlock()
	for _, id := range ids {
		_, _ = fw.StopFileWatch(id)
	}
}
