package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestGenerateTokenFormat(t *testing.T) {
	tok := generateToken()
	// 16 random bytes hex-encoded = 32 hex chars
	if len(tok) != 32 {
		t.Fatalf("expected 32-char hex token, got %q (len=%d)", tok, len(tok))
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(tok) {
		t.Fatalf("token %q is not hex", tok)
	}
	// Two calls must not collide.
	if tok == generateToken() {
		t.Fatalf("tokens should be unique, both %q", tok)
	}
}

func TestResolveProjectRootOverride(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alice_cli"), 0o755); err != nil {
		t.Fatal(err)
	}
	mainPy := filepath.Join(root, "alice_cli", "main.py")
	if err := os.WriteFile(mainPy, []byte("# marker"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ALICE_DESKTOP_ALICE_ROOT", root)
	pm := &PythonManager{}
	if got := pm.ResolveProjectRoot(); got != root {
		t.Fatalf("ResolveProjectRoot() = %q, want %q", got, root)
	}
}

func TestResolveProjectRootIgnoredWhenInvalid(t *testing.T) {
	// Override points at a dir without alice_cli/main.py -> must be ignored,
	// falling through to the walk-up (non-empty).
	t.Setenv("ALICE_DESKTOP_ALICE_ROOT", t.TempDir())
	pm := &PythonManager{}
	if got := pm.ResolveProjectRoot(); got == "" {
		t.Fatal("ResolveProjectRoot() returned empty; expected a walk-up fallback")
	}
}

func testPythonPath(t *testing.T) string {
	f := filepath.Join(t.TempDir(), "py")
	if err := os.WriteFile(f, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestFindPythonForRootOverride(t *testing.T) {
	py := testPythonPath(t)
	t.Setenv("ALICE_DESKTOP_PYTHON", py)
	pm := &PythonManager{}
	if got := pm.findPythonForRoot(t.TempDir()); got != py {
		t.Fatalf("findPythonForRoot() = %q, want override %q", got, py)
	}
}

func TestFindPythonForRootDefault(t *testing.T) {
	t.Setenv("ALICE_DESKTOP_PYTHON", "")
	pm := &PythonManager{aliceHome: filepath.Join(t.TempDir(), ".alice")}
	got := pm.findPythonForRoot(t.TempDir())
	if got == "" {
		t.Fatal("findPythonForRoot() returned empty; expected PATH fallback")
	}
	// The last-resort default is "python3"; PATH resolution usually finds a
	// real python3, but either way it must be non-empty.
	if !strings.HasSuffix(got, "python3") && !strings.HasSuffix(got, "python") {
		t.Fatalf("unexpected default python %q", got)
	}
}

func TestJoinPathsDedupes(t *testing.T) {
	a := t.TempDir()
	got := joinPaths([]string{a, "", a, filepath.Join(a, "x"), a})
	if strings.Count(got, string(os.PathListSeparator)) != 1 {
		t.Fatalf("expected 2 unique entries joined by 1 separator, got %q", got)
	}
	if !strings.HasPrefix(got, a) {
		t.Fatalf("expected first entry %q at start, got %q", a, got)
	}
}

func TestBuildBackendEnv(t *testing.T) {
	root := t.TempDir()
	venv := filepath.Join(root, ".venv")
	sp := filepath.Join(venv, "lib", "python3.12", "site-packages")
	if err := os.MkdirAll(sp, 0o755); err != nil {
		t.Fatal(err)
	}
	// Confirm the venv is detected and site-packages is computed.
	pm := &PythonManager{aliceHome: filepath.Join(t.TempDir(), ".alice")}
	root2 := pm.findVenvRoot(root)
	if root2 != venv {
		t.Fatalf("findVenvRoot() = %q, want %q", root2, venv)
	}
	spGot := pm.getVenvSitePackages(venv)
	if len(spGot) != 1 || spGot[0] != sp {
		t.Fatalf("getVenvSitePackages() = %v, want [%q]", spGot, sp)
	}
	env := pm.buildBackendEnv(root)

	pyPath, ok := env["PYTHONPATH"]
	if !ok {
		t.Fatal("buildBackendEnv missing PYTHONPATH")
	}
	entries := strings.Split(pyPath, string(os.PathListSeparator))
	if entries[0] != sp {
		t.Fatalf("PYTHONPATH[0] = %q, want site-packages %q (got %q)", entries[0], sp, pyPath)
	}
	if len(entries) < 2 {
		t.Fatalf("PYTHONPATH should also contain the project root: %q", pyPath)
	}

	path := env["PATH"]
	if !strings.HasPrefix(path, filepath.Join(venv, "bin")) {
		t.Fatalf("PATH should start with venv bin, got %q", path)
	}
}

func TestBuildBackendEnvEmptyVenv(t *testing.T) {
	root := t.TempDir() // no .venv anywhere
	pm := &PythonManager{aliceHome: filepath.Join(t.TempDir(), ".alice")}
	env := pm.buildBackendEnv(root)
	pyPath := env["PYTHONPATH"]
	entries := strings.Split(pyPath, string(os.PathListSeparator))
	if entries[0] != root {
		t.Fatalf("PYTHONPATH[0] = %q, want project root %q", entries[0], root)
	}
}

func TestGetVenvSitePackagesReturnsNilOutsideVenv(t *testing.T) {
	pm := &PythonManager{}
	if got := pm.getVenvSitePackages(t.TempDir()); got != nil {
		t.Fatalf("expected nil site-packages for non-venv dir, got %v", got)
	}
	if got := pm.getVenvSitePackages(""); got != nil {
		t.Fatalf("expected nil site-packages for empty root, got %v", got)
	}
}

func TestGetPortAnnounceTimeoutMs(t *testing.T) {
	if got := getPortAnnounceTimeoutMsTest(t); got != defaultPortAnnounceTimeoutMs {
		t.Fatalf("default = %d, want %d", got, defaultPortAnnounceTimeoutMs)
	}
}

// Helper because getPortAnnounceTimeoutMs is a method needing its own env scoping.
func getPortAnnounceTimeoutMsTest(t *testing.T) int {
	pm := &PythonManager{}
	return pm.getPortAnnounceTimeoutMs()
}

func TestGetPortAnnounceTimeoutMsOverride(t *testing.T) {
	t.Setenv("ALICE_DESKTOP_PORT_ANNOUNCE_TIMEOUT_MS", "60000")
	pm := &PythonManager{}
	if got := pm.getPortAnnounceTimeoutMs(); got != 60000 {
		t.Fatalf("override = %d, want 60000", got)
	}
}

func TestGetPortAnnounceTimeoutMsClamped(t *testing.T) {
	t.Setenv("ALICE_DESKTOP_PORT_ANNOUNCE_TIMEOUT_MS", "1000")
	pm := &PythonManager{}
	if got := pm.getPortAnnounceTimeoutMs(); got != minPortAnnounceTimeoutMs {
		t.Fatalf("clamped = %d, want %d", got, minPortAnnounceTimeoutMs)
	}
	// Invalid values fall back to the default too.
	t.Setenv("ALICE_DESKTOP_PORT_ANNOUNCE_TIMEOUT_MS", "abc")
	if got := pm.getPortAnnounceTimeoutMs(); got != defaultPortAnnounceTimeoutMs {
		t.Fatalf("invalid = %d, want default %d", got, defaultPortAnnounceTimeoutMs)
	}
}

func TestTryParsePort(t *testing.T) {
	pm := &PythonManager{portReady: make(chan struct{})}
	pm.tryParsePort("  Running on http://127.0.0.1 (Press CTRL+C to quit) port=17896\n")
	if pm.port != 17896 {
		t.Fatalf("port = %d, want 17896", pm.port)
	}
	// "port:" form also matches.
	pm2 := &PythonManager{portReady: make(chan struct{})}
	pm2.tryParsePort("listening port: 25000 on 127.0.0.1")
	if pm2.port != 25000 {
		t.Fatalf("port = %d, want 25000", pm2.port)
	}
	// Ports below 1024 are rejected.
	pm3 := &PythonManager{portReady: make(chan struct{})}
	pm3.tryParsePort("port=80")
	if pm3.port != 0 {
		t.Fatalf("low port should be rejected, got %d", pm3.port)
	}
}

func TestTryParsePortOnlyOnce(t *testing.T) {
	pm := &PythonManager{portReady: make(chan struct{})}
	pm.tryParsePort("port=12345 first")
	pm.tryParsePort("port=60000 second")
	if pm.port != 12345 {
		t.Fatalf("first announcement should win, got %d", pm.port)
	}
}

// fakeBackendScript returns an executable python script that ignores the
// `-m alice_cli.main serve ...` args the manager passes, binds an ephemeral
// port, announces it as `port=NNNN`, and serves /api/status with 200.
func fakeBackendScript(t *testing.T) string {
	t.Helper()
	script := `#!/usr/bin/env python3
import http.server, socketserver, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
with socketserver.TCPServer(("127.0.0.1", 0), H) as s:
    print("port=%d" % s.server_address[1], flush=True)
    s.serve_forever()
`
	p := filepath.Join(t.TempDir(), "fake-backend.py")
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// TestStartGatewayBootE2E drives the real backend-spawn path end to end: a
// fake python announces its port on stdout, the manager's watchPort parses it,
// IsHealthy probes the live HTTP server, and StopGateway tears it down.
func TestStartGatewayBootE2E(t *testing.T) {
	// Fresh process-level state.
	activeCmdMu.Lock()
	activeCmd = nil
	activeCmdMu.Unlock()

	home := t.TempDir()
	t.Setenv("ALICE_HOME", home)
	t.Setenv("ALICE_DESKTOP_PYTHON", fakeBackendScript(t))

	pm := NewPythonManager()
	if err := pm.StartGateway(); err != nil {
		t.Fatalf("StartGateway: %v", err)
	}
	defer func() {
		_ = pm.StopGateway()
		activeCmdMu.Lock()
		activeCmd = nil
		activeCmdMu.Unlock()
	}()

	// The port must be announced and the backend must become healthy.
	deadline := time.Now().Add(15 * time.Second)
	healthy := false
	for time.Now().Before(deadline) {
		if pm.IsHealthy() {
			healthy = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !healthy {
		t.Fatal("backend never became healthy via IsHealthy")
	}
	if pm.port == 0 {
		t.Fatal("port was not populated by the announcement parser")
	}

	// WaitForHealthy must now return immediately (portReady already closed).
	if !pm.WaitForHealthy(2) {
		t.Fatal("WaitForHealthy should succeed once the backend is up")
	}

	// GetBackendPIDs must report a live process (ALICE_DESKTOP_CHILD_PID).
	pids := pm.GetBackendPIDs()
	if len(pids) != 1 || pids[0] <= 0 {
		t.Fatalf("GetBackendPIDs() = %v, want one live PID", pids)
	}

	// StopGateway must tear it down: port reset + no longer healthy.
	if err := pm.StopGateway(); err != nil {
		t.Fatalf("StopGateway: %v", err)
	}
	if pm.port != 0 {
		t.Fatalf("port should be reset after stop, got %d", pm.port)
	}
}

// TestStartGatewayIdempotent: calling StartGateway twice must not spawn a second
// backend (guarded by the started flag).
func TestStartGatewayIdempotent(t *testing.T) {
	activeCmdMu.Lock()
	activeCmd = nil
	activeCmdMu.Unlock()

	home := t.TempDir()
	t.Setenv("ALICE_HOME", home)
	t.Setenv("ALICE_DESKTOP_PYTHON", fakeBackendScript(t))
	pm := NewPythonManager()

	if err := pm.StartGateway(); err != nil {
		t.Fatalf("first StartGateway: %v", err)
	}
	pid := pm.GetBackendPIDs()
	if len(pid) != 1 {
		t.Fatalf("expected one backend PID, got %v", pid)
	}
	// Second call must return early without spawning.
	if err := pm.StartGateway(); err != nil {
		t.Fatalf("second StartGateway should return nil, got %v", err)
	}
	if got := pm.GetBackendPIDs(); len(got) != 1 || got[0] != pid[0] {
		t.Fatalf("second StartGateway spawned a new backend: was %v now %v", pid, got)
	}
	_ = pm.StopGateway()
	activeCmdMu.Lock()
	activeCmd = nil
	activeCmdMu.Unlock()
}

// TestWaitForHealthyTimeout ensures an absent backend reports false without
// hanging forever.
func TestWaitForHealthyTimeout(t *testing.T) {
	// port 0 and portReady open -> WaitForHealthy polls IsHealthy=false until
	// the deadline and returns false.
	activeCmdMu.Lock()
	activeCmd = nil
	activeCmdMu.Unlock()
	home := t.TempDir()
	t.Setenv("ALICE_HOME", home)
	pm := NewPythonManager()
	start := time.Now()
	if pm.WaitForHealthy(1) {
		t.Fatal("WaitForHealthy should be false with no backend running")
	}
	if elapsed := time.Since(start); elapsed > 4*time.Second {
		t.Fatalf("WaitForHealthy timeout took too long: %v", elapsed)
	}
}

func TestIsHealthyFalseNoPort(t *testing.T) {
	pm := &PythonManager{}
	if pm.IsHealthy() {
		t.Fatal("IsHealthy() should be false when no port is set")
	}
}

func TestGetSessionTokenNonEmpty(t *testing.T) {
	pm := NewPythonManager()
	if pm.GetSessionToken() == "" {
		t.Fatal("session token should be non-empty")
	}
}

func TestGetConnectionInfoLocal(t *testing.T) {
	pm := &PythonManager{port: 17896, sessionToken: "tok", portReady: make(chan struct{})}
	info := pm.GetConnectionInfo()
	if info.Mode != "local" || info.BaseURL != "http://127.0.0.1:17896" {
		t.Fatalf("unexpected ConnectionInfo: %+v", info)
	}
	if !strings.HasPrefix(info.WSURL, "ws://127.0.0.1:17896/api/ws?token=tok") {
		t.Fatalf("unexpected WSURL: %q", info.WSURL)
	}
	if info.AuthMode != "token" {
		t.Fatalf("authMode = %q, want token", info.AuthMode)
	}
}