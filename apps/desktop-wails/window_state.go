package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// windowStatePath returns the per-profile window-state JSON path under
// $ALICE_HOME (desktop-window.json).
func windowStatePath(aliceHome string) string {
	return filepath.Join(aliceHome, "desktop-window.json")
}

type windowState struct {
	Width     int  `json:"width"`
	Height    int  `json:"height"`
	X         int  `json:"x"`
	Y         int  `json:"y"`
	Maximised bool `json:"maximised"`
}

// restoreWindowState applies the persisted window geometry on startup. Best
// effort: any missing/invalid state is ignored (the OS default layout is used).
func restoreWindowState(ctx context.Context, aliceHome string) {
	data, err := os.ReadFile(windowStatePath(aliceHome))
	if err != nil {
		return
	}
	var st windowState
	if err := json.Unmarshal(data, &st); err != nil {
		return
	}
	if st.Maximised {
		wailsruntime.WindowMaximise(ctx)
		return
	}
	if st.Width > 0 && st.Height > 0 {
		wailsruntime.WindowSetSize(ctx, st.Width, st.Height)
	}
	// Getting the (then-default) position before restoring lets us avoid
	// snapping an 0,0-restored window if the prior X/Y were never captured.
	if st.X != 0 || st.Y != 0 {
		wailsruntime.WindowSetPosition(ctx, st.X, st.Y)
	}
}

// saveWindowState persists the current window geometry on shutdown.
func saveWindowState(ctx context.Context, aliceHome string) {
	st := windowState{}
	if wailsruntime.WindowIsMaximised(ctx) {
		st.Maximised = true
	} else {
		st.Width, st.Height = wailsruntime.WindowGetSize(ctx)
		st.X, st.Y = wailsruntime.WindowGetPosition(ctx)
	}
	if st.Maximised || (st.Width > 0 && st.Height > 0) {
		if err := os.MkdirAll(aliceHome, 0o755); err == nil {
			if data, err := json.MarshalIndent(st, "", "  "); err == nil {
				_ = os.WriteFile(windowStatePath(aliceHome), data, 0o644)
			}
		}
	}
}