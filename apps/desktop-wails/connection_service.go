package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// ConnectionConfig mirrors Electron's persisted connection.json: it points the
// desktop at either the local backend or a remote `alice serve` (lite client).
// The bridge reads/writes it via ConnectionService.
type ConnectionConfig struct {
	Mode           string `json:"mode"`            // "local" | "remote"
	RemoteURL      string `json:"remoteUrl"`
	RemoteToken    string `json:"remoteToken"`
	RemoteAuthMode string `json:"remoteAuthMode"` // "token" | "oauth"
	Profile        string `json:"profile"`
}

// ConnectionService persists the local/remote connection config and probes
// remote backends server-side (a renderer fetch to the remote would hit CORS
// and misreport reachability).
type ConnectionService struct {
	aliceHome string
	mu        sync.Mutex
	cfg       ConnectionConfig
	ctx       context.Context
}

func NewConnectionService(aliceHome string) *ConnectionService {
	cs := &ConnectionService{aliceHome: aliceHome, cfg: ConnectionConfig{Mode: "local"}}
	cs.load()
	return cs
}

func (cs *ConnectionService) configPath() string {
	return filepath.Join(cs.aliceHome, "desktop-connection.json")
}

func (cs *ConnectionService) load() {
	if data, err := os.ReadFile(cs.configPath()); err == nil {
		var cfg ConnectionConfig
		if json.Unmarshal(data, &cfg) == nil {
			cs.cfg = cfg
		}
	}
}

// SetContext stores the Wails app context for relaying config-changed events.
func (cs *ConnectionService) SetContext(ctx context.Context) {
	cs.ctx = ctx
}

// Get returns the current connection config.
func (cs *ConnectionService) Get() ConnectionConfig {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.cfg
}

// Set persists a new connection config.
func (cs *ConnectionService) Set(cfg ConnectionConfig) ConnectionConfig {
	cs.mu.Lock()
	if cfg.Mode == "" {
		cfg.Mode = "local"
	}
	cs.cfg = cfg
	out := cs.cfg
	cs.mu.Unlock()
	_ = os.MkdirAll(cs.aliceHome, 0o755)
	if data, err := json.MarshalIndent(cfg, "", "  "); err == nil {
		_ = os.WriteFile(cs.configPath(), data, 0o644)
	}
	// Emit the SQLite-less signal so the renderer connection store can react.
	if cs.ctx != nil {
		wailsruntime.EventsEmit(cs.ctx, "alice:connection:changed", cfg.Mode)
	}
	return out
}

// ProbeResult is the server-side reachability report for a remote backend.
type ProbeResult struct {
	Reachable bool   `json:"reachable"`
	AuthMode  string `json:"authMode"`
	Version   string `json:"version"`
	Error     string `json:"error,omitempty"`
}

// ProbeRemote checks that a remote `alice serve` is reachable and reports its
// auth contract. Runs in Go so the renderer never issues a cross-origin fetch.
func (cs *ConnectionService) ProbeRemote(url, token string) ProbeResult {
	base := strings.TrimRight(url, "/")
	req, err := http.NewRequest(http.MethodGet, base+"/api/status", nil)
	if err != nil {
		return ProbeResult{Reachable: false, Error: err.Error()}
	}
	if token != "" {
		req.Header.Set("X-Alice-Session-Token", token)
	}
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return ProbeResult{Reachable: false, Error: err.Error()}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return ProbeResult{Reachable: false, Error: "HTTP " + resp.Status}
	}
	return ProbeResult{Reachable: true, AuthMode: "token", Version: string(body)}
}

// IsRemote reports whether the desktop is in remote (lite client) mode.
func (cs *ConnectionService) IsRemote() bool {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.cfg.Mode == "remote" && cs.cfg.RemoteURL != ""
}