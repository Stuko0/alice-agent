package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestConnectionServiceDefaultLocal(t *testing.T) {
	home := t.TempDir()
	cs := NewConnectionService(home)
	if cs.IsRemote() {
		t.Fatal("default config should not be remote")
	}
	if cs.Get().Mode != "local" {
		t.Fatalf("default mode = %q, want local", cs.Get().Mode)
	}
}

func TestConnectionServiceSetPersists(t *testing.T) {
	home := t.TempDir()
	cs := NewConnectionService(home)
	cs.Set(ConnectionConfig{Mode: "remote", RemoteURL: "http://10.0.0.5:8080", RemoteToken: "tok"})

	// A fresh service pointing at the same home must load the persisted file.
	cs2 := NewConnectionService(home)
	got := cs2.Get()
	if got.Mode != "remote" || got.RemoteURL != "http://10.0.0.5:8080" || got.RemoteToken != "tok" {
		t.Fatalf("persisted config not reloaded: %+v", got)
	}
	if !cs2.IsRemote() {
		t.Fatal("IsRemote() should be true after load")
	}

	// File is valid JSON and lives at the expected path.
	data, err := os.ReadFile(filepath.Join(home, "desktop-connection.json"))
	if err != nil {
		t.Fatal(err)
	}
	var parsed ConnectionConfig
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("persisted file is not valid JSON: %v", err)
	}
}

func TestConnectionServiceEmptyModeDefaultsToLocal(t *testing.T) {
	home := t.TempDir()
	cs := NewConnectionService(home)
	out := cs.Set(ConnectionConfig{RemoteURL: "http://x:1"})
	if out.Mode != "local" {
		t.Fatalf("empty mode should coerce to local, got %q", out.Mode)
	}
	if cs.IsRemote() {
		t.Fatal("should not be remote without an explicit mode=remote")
	}
}

func TestConnectionServiceIsRemoteRequiresURL(t *testing.T) {
	home := t.TempDir()
	cs := NewConnectionService(home)
	cs.Set(ConnectionConfig{Mode: "remote"}) // no URL
	if cs.IsRemote() {
		t.Fatal("remote mode without URL should not count as remote")
	}
}

func TestProbeRemoteReachable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/status" {
			w.WriteHeader(404)
			return
		}
		if r.Header.Get("X-Alice-Session-Token") != "s3cr3t" {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(200)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	cs := NewConnectionService(t.TempDir())
	res := cs.ProbeRemote(srv.URL, "s3cr3t")
	if !res.Reachable {
		t.Fatalf("expected reachable, got %+v", res)
	}
	if res.AuthMode != "token" {
		t.Fatalf("authMode = %q, want token", res.AuthMode)
	}
	if !strings.Contains(res.Version, "ok") {
		t.Fatalf("version/body = %q, expected the /api/status body", res.Version)
	}
}

func TestProbeRemoteUnreachable(t *testing.T) {
	cs := NewConnectionService(t.TempDir())
	res := cs.ProbeRemote("http://127.0.0.1:1", "tok") // port 1: nothing listens
	if res.Reachable {
		t.Fatal("expected unreachable for closed port")
	}
	if res.Error == "" {
		t.Fatal("expected an error message for unreachable probe")
	}
}

func TestProbeRemoteNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(502)
	}))
	defer srv.Close()
	cs := NewConnectionService(t.TempDir())
	res := cs.ProbeRemote(srv.URL, "")
	if res.Reachable {
		t.Fatal("expected unreachable for 502")
	}
	if !strings.Contains(res.Error, "502") {
		t.Fatalf("error should mention HTTP status, got %q", res.Error)
	}
}

func TestProbeRemoteTrailingSlash(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/status" {
			w.WriteHeader(404)
			return
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()
	cs := NewConnectionService(t.TempDir())
	// Trailing slash on the URL must not break the probe path.
	res := cs.ProbeRemote(srv.URL+"/", "")
	if !res.Reachable {
		t.Fatalf("trailing slash broke the probe: %+v", res)
	}
}