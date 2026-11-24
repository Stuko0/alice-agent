package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Ops mirror the enum in browser_gtk.h. Keep them in sync.
const (
	browserOpInit = iota + 1
	browserOpMount
	browserOpBounds
	browserOpVisible
	browserOpNavigate
	browserOpBack
	browserOpForward
	browserOpReload
	browserOpStop
	browserOpZoom
	browserOpInspect
	browserOpFocus
	browserOpClose
	browserOpBlur
)

// browserDispatchEvent is the sink the cgo callback pushes into. It is a
// package var (not a method) because the //export shim cannot reach a receiver.
var browserDispatchEvent = func(kind, value string) {}

// BrowserStatus is what the renderer paints in the chrome and uses to decide
// whether the native view is usable at all.
type BrowserStatus struct {
	Available bool   `json:"available"`
	DevTools  bool   `json:"devTools"`
	Loading   bool   `json:"loading"`
	Ready     bool   `json:"ready"`
	Title     string `json:"title"`
	URL       string `json:"url"`
}

// BrowserConsoleError is one console.error / uncaught exception forwarded by
// the page's document-start shim.
type BrowserConsoleError struct {
	Level   string `json:"level"`
	Line    int    `json:"line"`
	Message string `json:"message"`
	Source  string `json:"source"`
}

// BrowserService owns the embedded WebKitGTK surface. One instance per app:
// the view is a singleton widget overlayed on the Wails window.
type BrowserService struct {
	ctx      context.Context
	dataDir  string
	devTools bool

	mu           sync.Mutex
	status       BrowserStatus
	lastError    *BrowserConsoleError
	errorCount   int
	lastShortcut string
}

// NewBrowserService stores the browser profile under
// `<ALICE_HOME>/browser/webkit` so cookies and localStorage survive restarts
// (and stay profile-scoped: each ALICE_HOME gets its own session).
func NewBrowserService(aliceHome string) *BrowserService {
	home := aliceHome

	if home == "" {
		if env := os.Getenv("ALICE_HOME"); env != "" {
			home = env
		} else {
			userHome, _ := os.UserHomeDir()
			home = filepath.Join(userHome, ".alice")
		}
	}

	devTools := browserDevtoolsEnabled()

	return &BrowserService{
		dataDir:  filepath.Join(home, "browser", "webkit"),
		devTools: devTools,
		status:   BrowserStatus{Available: true, DevTools: devTools},
	}
}

// DataDir is the on-disk WebKit profile (tests + diagnostics).
func (b *BrowserService) DataDir() string { return b.dataDir }

// startup wires the event sink and waits for the Wails window to exist before
// creating the widget. The GTK calls themselves are marshalled onto the main
// loop by the C layer; this loop only paces the retries.
func (b *BrowserService) startup(ctx context.Context) {
	b.ctx = ctx
	browserDispatchEvent = b.handleEvent

	go func() {
		for attempt := 0; attempt < 150; attempt++ {
			if gtkBrowserReady() {
				break
			}

			gtkBrowserPost(browserOpInit, boolToInt(b.devTools), 0, 0, 0, b.dataDir)
			time.Sleep(100 * time.Millisecond)
		}

		ready := gtkBrowserReady()

		b.mu.Lock()
		b.status.Ready = ready
		b.mu.Unlock()
		b.emit()
	}()
}

func (b *BrowserService) handleEvent(kind, value string) {
	b.mu.Lock()

	switch kind {
	case "url":
		b.status.URL = value
	case "title":
		b.status.Title = value
	case "load":
		b.status.Loading = value != "finished"
	case "ready":
		b.status.Ready = value == "1"
	case "shortcut":
		// The page owns the keyboard while it has focus; the GTK layer forwards
		// only the shortcuts that must reach React (Escape, mod+K).
		b.lastShortcut = value
		shortcut := value
		b.mu.Unlock()

		if b.ctx != nil {
			wailsruntime.EventsEmit(b.ctx, "browser:shortcut", shortcut)
		}

		return
	case "console-error":
		var payload BrowserConsoleError

		if err := json.Unmarshal([]byte(value), &payload); err == nil {
			b.errorCount++
			b.lastError = &payload
			b.mu.Unlock()

			if b.ctx != nil {
				wailsruntime.EventsEmit(b.ctx, "browser:console-error", payload)
			}

			return
		}
	}

	status := b.status
	b.mu.Unlock()

	if b.ctx != nil {
		wailsruntime.EventsEmit(b.ctx, "browser:state", status)
	}

	if kind == "new-window" && b.ctx != nil {
		wailsruntime.EventsEmit(b.ctx, "browser:new-window", value)
	}
}

func (b *BrowserService) emit() {
	b.mu.Lock()
	status := b.status
	b.mu.Unlock()

	if b.ctx != nil {
		wailsruntime.EventsEmit(b.ctx, "browser:state", status)
	}
}

// Status returns the last known state without touching GTK.
func (b *BrowserService) Status() BrowserStatus {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.status
}

// Mount creates the native view (if needed), positions it and shows it.
func (b *BrowserService) Mount(x, y, width, height int) BrowserStatus {
	x, y, width, height = clampBrowserBounds(x, y, width, height)
	gtkBrowserPost(browserOpMount, x, y, width, height, "")

	b.mu.Lock()
	b.status.Ready = gtkBrowserReady()
	status := b.status
	b.mu.Unlock()

	return status
}

// SetBounds keeps the native surface glued to the pane while it resizes.
func (b *BrowserService) SetBounds(x, y, width, height int) {
	x, y, width, height = clampBrowserBounds(x, y, width, height)
	gtkBrowserPost(browserOpBounds, x, y, width, height, "")
}

// SetVisible hides the native view while a React overlay owns the window: a
// GTK overlay child always paints above the WebView content.
func (b *BrowserService) SetVisible(visible bool) {
	flag := 0

	if visible {
		flag = 1
	}

	gtkBrowserPost(browserOpVisible, flag, 0, 0, 0, "")
}

// Navigate loads an http(s) URL. Anything else is rejected rather than handed
// to the engine.
func (b *BrowserService) Navigate(raw string) error {
	target, err := normalizeBrowserURL(raw)

	if err != nil {
		return err
	}

	gtkBrowserPost(browserOpNavigate, 0, 0, 0, 0, target)

	return nil
}

func (b *BrowserService) Back()    { gtkBrowserPost(browserOpBack, 0, 0, 0, 0, "") }
func (b *BrowserService) Forward() { gtkBrowserPost(browserOpForward, 0, 0, 0, 0, "") }
func (b *BrowserService) Reload()  { gtkBrowserPost(browserOpReload, 0, 0, 0, 0, "") }
func (b *BrowserService) Stop()    { gtkBrowserPost(browserOpStop, 0, 0, 0, 0, "") }
func (b *BrowserService) Focus()   { gtkBrowserPost(browserOpFocus, 0, 0, 0, 0, "") }

// Blur hands keyboard focus back to the app shell (Escape from the page).
func (b *BrowserService) Blur() { gtkBrowserPost(browserOpBlur, 0, 0, 0, 0, "") }

// Close stops the current load, clears the page and hides the native surface.
// Used when the pane is torn down (or by future tab management); it never
// touches the persistent profile, so cookies/localStorage survive.
func (b *BrowserService) Close() {
	gtkBrowserPost(browserOpClose, 0, 0, 0, 0, "")

	b.mu.Lock()
	b.status.Loading = false
	b.status.URL = "about:blank"
	b.status.Title = ""
	b.mu.Unlock()
	b.emit()
}

// LastConsoleError returns the most recent console error, if any.
func (b *BrowserService) LastConsoleError() *BrowserConsoleError {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.lastError == nil {
		return nil
	}

	copy := *b.lastError

	return &copy
}

// LastShortcut is the last keyboard shortcut forwarded from the page surface
// ("escape" / "palette"). Exposed for diagnostics and tests.
func (b *BrowserService) LastShortcut() string {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.lastShortcut
}

// ConsoleErrorCount is the number of console errors seen this session.
func (b *BrowserService) ConsoleErrorCount() int {
	b.mu.Lock()
	defer b.mu.Unlock()

	return b.errorCount
}

// SetZoom clamps to a sane range so a bad value can't render the page blank.
func (b *BrowserService) SetZoom(zoom float64) {
	if zoom < 0.25 {
		zoom = 0.25
	}

	if zoom > 5 {
		zoom = 5
	}

	gtkBrowserPostZoom(zoom)
}

// Inspect opens WebKit's inspector (dev builds only by convention).
func (b *BrowserService) Inspect() {
	gtkBrowserPost(browserOpInspect, 0, 0, 0, 0, "")
}

func boolToInt(value bool) int {
	if value {
		return 1
	}

	return 0
}

func clampBrowserBounds(x, y, width, height int) (int, int, int, int) {
	if x < 0 {
		x = 0
	}

	if y < 0 {
		y = 0
	}

	if width < 1 {
		width = 1
	}

	if height < 1 {
		height = 1
	}

	return x, y, width, height
}

// normalizeBrowserURL accepts what a human types ("localhost:5173"), resolves
// it to https unless a scheme is given, and refuses anything but http(s).
func normalizeBrowserURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)

	if trimmed == "" {
		return "", errors.New("empty url")
	}

	if trimmed == "about:blank" {
		return trimmed, nil
	}

	if !strings.Contains(trimmed, "://") {
		trimmed = "https://" + trimmed
	}

	parsed, err := url.Parse(trimmed)

	if err != nil {
		return "", fmt.Errorf("invalid url: %w", err)
	}

	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("unsupported scheme %q", parsed.Scheme)
	}

	if parsed.Host == "" {
		return "", errors.New("missing host")
	}

	return parsed.String(), nil
}
