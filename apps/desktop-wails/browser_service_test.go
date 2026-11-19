package main

import (
	"path/filepath"
	"testing"
)

func TestNormalizeBrowserURL(t *testing.T) {
	cases := []struct {
		in      string
		out     string
		wantErr bool
	}{
		{in: "https://example.com", out: "https://example.com"},
		{in: "http://127.0.0.1:5173/app", out: "http://127.0.0.1:5173/app"},
		{in: "  example.com  ", out: "https://example.com"},
		{in: "localhost:3000", out: "https://localhost:3000"},
		{in: "about:blank", out: "about:blank"},
		{in: "file:///etc/passwd", wantErr: true},
		{in: "javascript:alert(1)", wantErr: true},
		{in: "", wantErr: true},
		{in: "https://", wantErr: true},
	}

	for _, tc := range cases {
		got, err := normalizeBrowserURL(tc.in)

		if tc.wantErr {
			if err == nil {
				t.Errorf("normalizeBrowserURL(%q) = %q, want error", tc.in, got)
			}

			continue
		}

		if err != nil {
			t.Errorf("normalizeBrowserURL(%q) error: %v", tc.in, err)
			continue
		}

		if got != tc.out {
			t.Errorf("normalizeBrowserURL(%q) = %q, want %q", tc.in, got, tc.out)
		}
	}
}

func TestClampBrowserBounds(t *testing.T) {
	x, y, w, h := clampBrowserBounds(-10, -2, 0, 0)

	if x != 0 || y != 0 || w != 1 || h != 1 {
		t.Fatalf("clampBrowserBounds = %d,%d,%d,%d; want 0,0,1,1", x, y, w, h)
	}

	x, y, w, h = clampBrowserBounds(72, 40, 800, 600)

	if x != 72 || y != 40 || w != 800 || h != 600 {
		t.Fatalf("clampBrowserBounds changed valid bounds: %d,%d,%d,%d", x, y, w, h)
	}
}

func TestBrowserServiceKeepsProfileUnderAliceHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), "alice-profile")
	want := filepath.Join(home, "browser", "webkit")
	service := NewBrowserService(home)

	if got := service.DataDir(); got != want {
		t.Fatalf("DataDir = %q, want %q", got, want)
	}
}

func TestBrowserDevtoolsOffByDefault(t *testing.T) {
	if browserDevtoolsDefault {
		t.Skip("dev build: inspector is expected on")
	}

	t.Setenv("ALICE_BROWSER_DEVTOOLS", "")

	if browserDevtoolsEnabled() {
		t.Fatal("developer extras must stay off in a release build")
	}

	t.Setenv("ALICE_BROWSER_DEVTOOLS", "1")

	if !browserDevtoolsEnabled() {
		t.Fatal("the env override must enable developer extras")
	}
}

func TestBrowserServiceCloseResetsStatus(t *testing.T) {
	service := NewBrowserService("/tmp/alice-close")
	service.handleEvent("url", "https://example.com/page")
	service.handleEvent("load", "started")

	service.Close()

	status := service.Status()

	if status.URL != "about:blank" {
		t.Fatalf("URL after Close = %q, want about:blank", status.URL)
	}

	if status.Loading {
		t.Fatal("Close must clear the loading flag")
	}
}

func TestBrowserServiceRecordsConsoleErrors(t *testing.T) {
	service := NewBrowserService("/tmp/alice-console")

	if service.LastConsoleError() != nil {
		t.Fatal("no console errors expected before any event")
	}

	service.handleEvent("console-error", `{"level":"error","message":"boom","source":"console","line":3}`)
	service.handleEvent("console-error", `{"level":"error","message":"kaboom","source":"promise","line":0}`)

	if got := service.ConsoleErrorCount(); got != 2 {
		t.Fatalf("ConsoleErrorCount = %d, want 2", got)
	}

	last := service.LastConsoleError()

	if last == nil || last.Message != "kaboom" || last.Line != 0 {
		t.Fatalf("LastConsoleError = %#v", last)
	}

	// Malformed payloads must not corrupt the counters.
	service.handleEvent("console-error", "{not json")

	if got := service.ConsoleErrorCount(); got != 2 {
		t.Fatalf("ConsoleErrorCount after bad payload = %d, want 2", got)
	}
}

func TestBrowserServiceRecordsForwardedShortcuts(t *testing.T) {
	service := NewBrowserService("/tmp/alice-shortcuts")

	if service.LastShortcut() != "" {
		t.Fatalf("LastShortcut = %q, want empty before any event", service.LastShortcut())
	}

	service.handleEvent("shortcut", "palette")

	if got := service.LastShortcut(); got != "palette" {
		t.Fatalf("LastShortcut = %q, want palette", got)
	}

	service.handleEvent("shortcut", "escape")

	if got := service.LastShortcut(); got != "escape" {
		t.Fatalf("LastShortcut = %q, want escape", got)
	}
}

func TestBrowserServiceReportsUnavailableOffGTK(t *testing.T) {
	// The stub build reports ready=false; the GTK build only becomes ready once
	// a window exists. Either way Status() must never block or panic.
	service := NewBrowserService("/tmp/alice-test")

	if !service.Status().Available {
		t.Fatal("browser service must report itself available so the UI can try")
	}
}
