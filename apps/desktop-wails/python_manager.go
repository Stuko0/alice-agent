package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

var portRe = regexp.MustCompile(`\bport[=:]\s*(\d{4,5})\b`)

const (
	defaultPortAnnounceTimeoutMs = 90_000
	minPortAnnounceTimeoutMs     = 45_000
)

type ConnectionInfo struct {
	BaseURL            string `json:"baseUrl"`
	WSURL              string `json:"wsUrl"`
	Token              string `json:"token"`
	AuthMode           string `json:"authMode"`
	Mode               string `json:"mode"`
	IsFullscreen       bool   `json:"isFullscreen"`
	NativeOverlayWidth int    `json:"nativeOverlayWidth"`
}

type PythonManager struct {
	running      bool
	started      bool
	mu           sync.Mutex
	aliceHome    string
	port         int
	sessionToken string
	portReady    chan struct{}
	// Wails app context for runtime event emission (nil until SetContext).
	// Events are best-effort: a nil ctx (headless tests, early startup) just
	// skips the emit, the state is still observable via GetBootProgress.
	ctx context.Context
	// Current boot snapshot, mirrored to the renderer as `alice:boot-progress`
	// events + polled via GetBootProgress.
	bootPhase    string
	bootMessage  string
	bootProgress int
	// Terminal boot failure (no usable python, backend died pre-announce…).
	// Read by GetBootProgress so a renderer that mounts AFTER the failure —
	// or one that missed the `alice:backend:exit` event race — still sees it
	// on its first poll instead of an idle 100% loader.
	bootError string
	// Set by StopGateway so the stdout watcher does not emit a spurious
	// `alice:backend:exit` for an intentional shutdown.
	stopping bool
	// Ring buffer tail of the backend's stderr for error reporting.
	stderrMu    sync.Mutex
	stderrTail  []byte
}

// BootProgress mirrors the renderer's DesktopBootProgress contract
// (apps/desktop/src/global.d.ts). Timestamp is epoch milliseconds.
type BootProgress struct {
	Error     string `json:"error"`
	FakeMode  bool   `json:"fakeMode"`
	Message   string `json:"message"`
	Phase     string `json:"phase"`
	Progress  int    `json:"progress"`
	Running   bool   `json:"running"`
	Timestamp int64  `json:"timestamp"`
}

// activeCmd stores the running backend process (package-level to avoid Wails serialization issues)
var (
	activeCmd   *exec.Cmd
	activeCmdMu sync.Mutex
)

func generateToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("token_%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// SetContext stores the Wails runtime context for event emission. Call from
// OnStartup before StartGateway so boot-progress events reach the renderer.
func (pm *PythonManager) SetContext(ctx context.Context) {
	pm.mu.Lock()
	pm.ctx = ctx
	pm.mu.Unlock()
}

// setBootStep updates the boot snapshot under the lock and best-effort emits
// `alice:boot-progress` to the renderer. Monotonic: the progress value only
// moves forward while running (the renderer also clamps).
func (pm *PythonManager) setBootStep(phase, message string, progress int, running bool, errMsg string) {
	pm.mu.Lock()
	if progress < pm.bootProgress && running && errMsg == "" {
		progress = pm.bootProgress
	}
	pm.bootPhase = phase
	pm.bootMessage = message
	pm.bootProgress = progress
	ctx := pm.ctx
	pm.mu.Unlock()

	if ctx == nil {
		return
	}

	payload := BootProgress{
		Error:     errMsg,
		FakeMode:  false,
		Message:   message,
		Phase:     phase,
		Progress:  progress,
		Running:   running,
		Timestamp: time.Now().UnixMilli(),
	}

	wailsruntime.EventsEmit(ctx, "alice:boot-progress", payload)
}

// GetBootProgress returns the current boot snapshot for the renderer's
// initial poll (before any event lands).
func (pm *PythonManager) GetBootProgress() BootProgress {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	return BootProgress{
		Error:     pm.bootError,
		FakeMode:  false,
		Message:   pm.bootMessage,
		Phase:     pm.bootPhase,
		Progress:  pm.bootProgress,
		Running:   pm.running && pm.port == 0,
		Timestamp: time.Now().UnixMilli(),
	}
}

// recordBootError stores a terminal boot failure in the snapshot under the
// lock and best-effort emits it to the renderer. Safe to call from any
// goroutine; mirrors setBootStep's monotonic rule (an error always wins).
func (pm *PythonManager) recordBootError(reason string) {
	pm.mu.Lock()
	pm.bootError = reason
	pm.bootPhase = "backend.failed"
	pm.bootMessage = reason
	pm.bootProgress = 100
	pm.running = false
	ctx := pm.ctx
	pm.mu.Unlock()

	if ctx != nil {
		wailsruntime.EventsEmit(ctx, "alice:boot-progress", BootProgress{
			Error:     reason,
			FakeMode:  false,
			Message:   reason,
			Phase:     "backend.failed",
			Progress:  100,
			Running:   false,
			Timestamp: time.Now().UnixMilli(),
		})
	}
}

// emitBackendExit reports an unexpected backend death to the renderer and
// stores the failure in the boot snapshot. Intentional StopGateway shutdowns
// set `stopping` first and do not reach here.
func (pm *PythonManager) emitBackendExit(reason string) {
	pm.mu.Lock()
	stopping := pm.stopping
	pm.mu.Unlock()

	if stopping {
		return
	}

	tail := pm.stderrTailText()

	message := reason
	if tail != "" {
		message = fmt.Sprintf("%s — stderr tail: %s", reason, tail)
	}

	wailsruntime.EventsEmit(contextWithCtx(pm), "alice:backend:exit", map[string]interface{}{
		"reason": message,
	})

	// Persist the failure: a renderer that mounts after this (or misses the
	// event race entirely) must still see the error on its first
	// GetBootProgress poll instead of an idle "Starting Alice" loader.
	pm.mu.Lock()
	if pm.bootError == "" {
		pm.bootError = message
	}
	pm.mu.Unlock()

	pm.setBootStep("backend.exited", message, 100, false, message)
}

// stderrTailText returns up to the last 2 KB of captured stderr, lock-guarded.
func (pm *PythonManager) stderrTailText() string {
	pm.stderrMu.Lock()
	defer pm.stderrMu.Unlock()

	const max = 2048

	if len(pm.stderrTail) > max {
		return string(pm.stderrTail[len(pm.stderrTail)-max:])
	}

	return string(pm.stderrTail)
}

// appendStderrLine adds one stderr line to the bounded tail ring.
func (pm *PythonManager) appendStderrLine(line string) {
	pm.stderrMu.Lock()
	defer pm.stderrMu.Unlock()

	pm.stderrTail = append(pm.stderrTail, []byte(line)...)
	if len(pm.stderrTail) > 16*1024 {
		pm.stderrTail = pm.stderrTail[len(pm.stderrTail)-8*1024:]
	}
}

// contextWithCtx returns the stored Wails context or nil.
func contextWithCtx(pm *PythonManager) context.Context {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	return pm.ctx
}

func NewPythonManager() *PythonManager {
	homeDir, _ := os.UserHomeDir()
	aliceHome := os.Getenv("ALICE_HOME")
	if aliceHome == "" {
		aliceHome = filepath.Join(homeDir, ".alice")
	}
	return &PythonManager{
		aliceHome:    aliceHome,
		port:         0,
		sessionToken: generateToken(),
		portReady:    make(chan struct{}),
	}
}

func (pm *PythonManager) GetAliceHome() string {
	return pm.aliceHome
}

// ResolveProjectRoot finds the alice-agent project root by looking for alice_cli/main.py
func (pm *PythonManager) ResolveProjectRoot() string {
	// 1. Check explicit override
	if root := os.Getenv("ALICE_DESKTOP_ALICE_ROOT"); root != "" {
		if _, err := os.Stat(filepath.Join(root, "alice_cli", "main.py")); err == nil {
			return root
		}
	}

	// 2. Walk up from current directory
	execDir, err := os.Getwd()
	if err == nil {
		curr := execDir
		for i := 0; i < 10; i++ {
			if _, err := os.Stat(filepath.Join(curr, "alice_cli", "main.py")); err == nil {
				return curr
			}
			parent := filepath.Dir(curr)
			if parent == curr {
				break
			}
			curr = parent
		}
	}

	// 2.5 Managed-install layout on Windows: %LOCALAPPDATA%\alice\alice-agent
	// (what `alice update`/the installer maintains). A double-clicked exe has
	// no alice cwd, so without this the walk falls through to C:\ and every
	// python resolution below goes sideways.
	if runtime.GOOS == "windows" {
		if la := os.Getenv("LOCALAPPDATA"); la != "" {
			candidate := filepath.Join(la, "alice", "alice-agent")
			if _, err := os.Stat(filepath.Join(candidate, "alice_cli", "main.py")); err == nil {
				return candidate
			}
			// Older layout without the inner alice-agent dir
			candidate = filepath.Join(la, "alice")
			if _, err := os.Stat(filepath.Join(candidate, "alice_cli", "main.py")); err == nil {
				return candidate
			}
		}
		// The exe beside an alice checkout (the documented source layout):
		// C:\alice\alice-desktop.exe -> C:\alice
		if exe, err := os.Executable(); err == nil {
			exeDir := filepath.Dir(exe)
			if _, err := os.Stat(filepath.Join(exeDir, "alice_cli", "main.py")); err == nil {
				return exeDir
			}
		}
	}

	// 3. Fallback: assume we're in apps/desktop-wails and go up two levels
	return filepath.Clean(filepath.Join(execDir, "..", ".."))
}

// findPythonForRoot finds the Python executable for the given project root
// Mirrors Electron's findPythonForRoot()
func (pm *PythonManager) findPythonForRoot(root string) string {
	// Check override
	if override := os.Getenv("ALICE_DESKTOP_PYTHON"); override != "" {
		if _, err := os.Stat(override); err == nil {
			return override
		}
	}

	// Check venv in project root
	relativePaths := []string{filepath.Join(".venv", "bin", "python"), filepath.Join("venv", "bin", "python")}
	if runtime.GOOS == "windows" {
		relativePaths = []string{filepath.Join(".venv", "Scripts", "python.exe"), filepath.Join("venv", "Scripts", "python.exe")}
	}

	for _, relPath := range relativePaths {
		candidate := filepath.Join(root, relPath)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}

	// Check ~/.alice/venv
	aliceVenv := filepath.Join(pm.aliceHome, "venv", "bin", "python")
	if runtime.GOOS == "windows" {
		aliceVenv = filepath.Join(pm.aliceHome, "venv", "Scripts", "python.exe")
	}
	if _, err := os.Stat(aliceVenv); err == nil {
		return aliceVenv
	}

	// Check common venv locations relative to home
	homeDir, _ := os.UserHomeDir()
	commonVenvs := []string{
		filepath.Join(homeDir, "Projects", "venv-alice", "bin", "python"),
		filepath.Join(homeDir, "venv-alice", "bin", "python"),
		filepath.Join(homeDir, ".alice", "venv", "bin", "python"),
	}
	if runtime.GOOS == "windows" {
		commonVenvs = []string{
			filepath.Join(homeDir, "Projects", "venv-alice", "Scripts", "python.exe"),
			filepath.Join(homeDir, "venv-alice", "Scripts", "python.exe"),
			filepath.Join(homeDir, ".alice", "venv", "Scripts", "python.exe"),
		}
		// Alice managed-install layout: %LOCALAPPDATA%\alice\venv
		if la := os.Getenv("LOCALAPPDATA"); la != "" {
			commonVenvs = append(commonVenvs, filepath.Join(la, "alice", "venv", "Scripts", "python.exe"))
		}
		// Bundled python embed shipped beside the executable (resources/python)
		if exe, err := os.Executable(); err == nil {
			commonVenvs = append(commonVenvs, filepath.Join(filepath.Dir(exe), "resources", "python", "python.exe"))
		}
	}
	for _, venv := range commonVenvs {
		if _, err := os.Stat(venv); err == nil {
			return venv
		}
	}

	// Bundled Python embed shipped beside the executable (POSIX layout:
	// resources/python/bin/python3). Windows already handles the
	// resources/python/python.exe layout in the branches above.
	if runtime.GOOS != "windows" {
		if exe, err := os.Executable(); err == nil {
			bundled := filepath.Join(filepath.Dir(exe), "resources", "python", "bin", "python3")
			if _, err := os.Stat(bundled); err == nil {
				return bundled
			}
		}
	}

	// PATH lookup — but only when the project root actually carries the CLI.
	// Without this guard a bare `LookPath("python3")` on a stock Windows box
	// resolves to the Microsoft Store alias stub
	// (%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe) — a zero-byte
	// reparse-point executable that prints "Python was not found" and exits.
	// Spawning it as the backend produces the eternal "Starting Alice 100%"
	// boot hang: the stub dies before announcing a port, so the renderer
	// connects to ws://127.0.0.1:0 forever.
	rootHasCli, _ := os.Stat(filepath.Join(root, "alice_cli", "main.py"))
	if rootHasCli == nil {
		return "" // no credible python — caller must surface an actionable error
	}
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil && !isStorePythonStub(path) {
			return path
		}
	}

	return ""
}

// isStorePythonStub reports whether the given path is the Microsoft Store
// "app execution alias" — a reparse point that opens the Store instead of
// running Python. Detected by path (WindowsApps dir) because running it to
// probe would pop the Store UI on the user's desktop. No-op off Windows:
// the alias only exists there.
func isStorePythonStub(path string) bool {
	if runtime.GOOS != "windows" {
		return false
	}
	return isStorePythonStubPath(path)
}

// isStorePythonStubPath is the pure path-shape check (case-insensitive,
// slash-agnostic — handles both `\` and `/` separators so tests can pin the
// Windows shape from any OS).
func isStorePythonStubPath(path string) bool {
	p := strings.ToLower(path)
	p = strings.ReplaceAll(p, "/", `\`)
	return strings.Contains(p, `\microsoft\windowsapps\`)
}

// getVenvSitePackages returns the site-packages path for a venv
func (pm *PythonManager) getVenvSitePackages(venvRoot string) []string {
	if venvRoot == "" {
		return nil
	}

	if runtime.GOOS == "windows" {
		sitePackages := filepath.Join(venvRoot, "Lib", "site-packages")
		if info, err := os.Stat(sitePackages); err == nil && info.IsDir() {
			return []string{sitePackages}
		}
		return nil
	}

	// Try to read version from pyvenv.cfg
	pyvenvCfg := filepath.Join(venvRoot, "pyvenv.cfg")
	if data, err := os.ReadFile(pyvenvCfg); err == nil {
		content := string(data)
		// Look for version_info = X.Y
		re := regexp.MustCompile(`(?m)^version_info\s*=\s*(\d+\.\d+)`)
		if m := re.FindStringSubmatch(content); m != nil {
			sitePackages := filepath.Join(venvRoot, "lib", "python"+m[1], "site-packages")
			if info, err := os.Stat(sitePackages); err == nil && info.IsDir() {
				return []string{sitePackages}
			}
		}
	}

	// Fallback: try common versions (keep newer majors ahead of older ones so a
	// current standalone bundle without pyvenv.cfg still resolves).
	for _, ver := range []string{"3.15", "3.14", "3.13", "3.12", "3.11", "3.10"} {
		sitePackages := filepath.Join(venvRoot, "lib", "python"+ver, "site-packages")
		if info, err := os.Stat(sitePackages); err == nil && info.IsDir() {
			return []string{sitePackages}
		}
	}

	return nil
}

// buildBackendEnv builds environment variables for the backend process
// Mirrors Electron's buildDesktopBackendEnv()
func (pm *PythonManager) buildBackendEnv(projectRoot string) map[string]string {
	venvRoot := pm.findVenvRoot(projectRoot)

	// Build PYTHONPATH with site-packages
	var pythonPathEntries []string
	if venvRoot != "" {
		pythonPathEntries = append(pythonPathEntries, pm.getVenvSitePackages(venvRoot)...)
	}
	// Add project root
	pythonPathEntries = append(pythonPathEntries, projectRoot)

	currentPythonPath := os.Getenv("PYTHONPATH")
	if currentPythonPath != "" {
		pythonPathEntries = append(pythonPathEntries, currentPythonPath)
	}

	// Build PATH with venv bin
	currentPath := os.Getenv("PATH")
	var pathEntries []string
	if venvRoot != "" {
		venvBin := filepath.Join(venvRoot, "bin")
		if runtime.GOOS == "windows" {
			venvBin = filepath.Join(venvRoot, "Scripts")
		}
		pathEntries = append(pathEntries, venvBin)
	}
	pathEntries = append(pathEntries, currentPath)

	return map[string]string{
		"PYTHONPATH": joinPaths(pythonPathEntries),
		"PATH":       joinPaths(pathEntries),
	}
}

// findVenvRoot finds the venv root directory for the given project root
func (pm *PythonManager) findVenvRoot(projectRoot string) string {
	// Check project root venv
	for _, venvName := range []string{".venv", "venv"} {
		venvRoot := filepath.Join(projectRoot, venvName)
		if _, err := os.Stat(venvRoot); err == nil {
			return venvRoot
		}
	}

	// Check ~/.alice/venv
	aliceVenv := filepath.Join(pm.aliceHome, "venv")
	if _, err := os.Stat(aliceVenv); err == nil {
		return aliceVenv
	}

	// Check common locations
	homeDir, _ := os.UserHomeDir()
	commonVenvs := []string{
		filepath.Join(homeDir, "Projects", "venv-alice"),
		filepath.Join(homeDir, "venv-alice"),
	}
	if runtime.GOOS == "windows" {
		// Alice managed-install layout: %LOCALAPPDATA%\alice\venv
		if la := os.Getenv("LOCALAPPDATA"); la != "" {
			commonVenvs = append(commonVenvs, filepath.Join(la, "alice", "venv"))
		}
		// Bundled python embed shipped beside the executable (resources/python)
		if exe, err := os.Executable(); err == nil {
			commonVenvs = append(commonVenvs, filepath.Join(filepath.Dir(exe), "resources", "python"))
		}
	}
	for _, venv := range commonVenvs {
		if _, err := os.Stat(venv); err == nil {
			return venv
		}
	}

	// Bundled Python embed beside the executable (POSIX dir layout). Windows
	// already handles resources/python in the branch above.
	if runtime.GOOS != "windows" {
		if exe, err := os.Executable(); err == nil {
			bundled := filepath.Join(filepath.Dir(exe), "resources", "python")
			if _, err := os.Stat(bundled); err == nil {
				return bundled
			}
		}
	}

	return ""
}

func joinPaths(paths []string) string {
	seen := make(map[string]bool)
	var result []string
	for _, p := range paths {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		result = append(result, p)
	}
	return strings.Join(result, string(os.PathListSeparator))
}

func (pm *PythonManager) getPortAnnounceTimeoutMs() int {
	if v := os.Getenv("ALICE_DESKTOP_PORT_ANNOUNCE_TIMEOUT_MS"); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
			if parsed < minPortAnnounceTimeoutMs {
				return minPortAnnounceTimeoutMs
			}
			return parsed
		}
	}
	return defaultPortAnnounceTimeoutMs
}

// wailsDebugLogPath returns the path of the Wails debug log, always under the
// OS temp dir (POSIX /tmp does not exist on Windows).
func wailsDebugLogPath() string {
	return filepath.Join(os.TempDir(), "wails-debug.log")
}

// cmdEnvForBackend builds the backend process environment: the current env
// overridden with the venv-aware PYTHONPATH/PATH plus Alice desktop vars.
// PYTHONUNBUFFERED=1 is load-bearing on Windows: stdout to a pipe is
// fully-buffered by default, so the `port=NNNN` announcement line can sit in
// the buffer past every deadline and the GUI stays on "Starting Alice".
func cmdEnvForBackend(pm *PythonManager, projectRoot string, backendEnv map[string]string) []string {
	return cmdEnvForBackendWithDist(pm, projectRoot, backendEnv, filepath.Join(projectRoot, "apps", "desktop", "dist"))
}

// cmdEnvForBackendWithDist is cmdEnvForBackend with an explicit web-dist path.
// An empty webDist omits ALICE_WEB_DIST entirely (the backend then falls back
// to its bundled web_dist — or fail-fasts with its own actionable message).
func cmdEnvForBackendWithDist(pm *PythonManager, projectRoot string, backendEnv map[string]string, webDist string) []string {
	envMap := make(map[string]string)
	for _, e := range os.Environ() {
		if idx := bytes.IndexByte([]byte(e), '='); idx > 0 {
			envMap[string(e[:idx])] = string(e[idx+1:])
		}
	}
	for k, v := range backendEnv {
		envMap[k] = v
	}

	envMap["ALICE_HOME"] = pm.aliceHome
	envMap["ALICE_DESKTOP"] = "1"
	if webDist != "" {
		envMap["ALICE_WEB_DIST"] = webDist
	} else {
		delete(envMap, "ALICE_WEB_DIST")
	}
	envMap["ALICE_DASHBOARD_SESSION_TOKEN"] = pm.sessionToken
	envMap["PYTHONUNBUFFERED"] = "1"
	envMap["PYTHONDONTWRITEBYTECODE"] = "1"

	env := make([]string, 0, len(envMap))
	for k, v := range envMap {
		env = append(env, k+"="+v)
	}
	return env
}

func (pm *PythonManager) StartGateway() error {
	// Write to a debug file to trace execution
	debugFile, _ := os.OpenFile(wailsDebugLogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if debugFile != nil {
		defer debugFile.Close()
		fmt.Fprintf(debugFile, "[Wails] StartGateway called\n")
	}

	pm.mu.Lock()

	// Already started (in progress or done)? Return immediately.
	if pm.started {
		pm.mu.Unlock()
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] StartGateway already called, returning early\n")
		}
		return nil
	}
	pm.started = true
	pm.running = true

	// Check WITHOUT calling IsHealthy() to avoid deadlock (IsHealthy also locks pm.mu)
	if pm.port != 0 {
		pm.mu.Unlock()
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] Port already set (%d), returning early\n", pm.port)
		}
		return nil
	}

	projectRoot := pm.ResolveProjectRoot()
	pythonPath := pm.findPythonForRoot(projectRoot)

	if debugFile != nil {
		fmt.Fprintf(debugFile, "[Wails] pythonPath=%s, projectRoot=%s\n", pythonPath, projectRoot)
	}

	// No credible Python runtime → fail the boot loudly instead of spawning a
	// broken interpreter that dies silently before announcing a port (the
	// Microsoft Store python3.exe stub being the canonical case: it prints
	// "Python was not found" and exits, leaving the GUI on "Starting Alice
	// 100%" connected to ws://127.0.0.1:0 forever). Store an actionable
	// message in the boot snapshot; the renderer's error screen shows it.
	if pythonPath == "" {
		pm.mu.Unlock()
		reason := "No usable Python runtime was found for the Alice backend. " +
			"Install Python 3.10+ from python.org (or create a venv with it), " +
			"then set ALICE_DESKTOP_PYTHON or run `alice desktop-setup`. " +
			"(Windows note: the Microsoft Store 'python3.exe' alias does not count.)"
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] %s\n", reason)
		}
		log.Printf("[Wails] %s", reason)
		pm.recordBootError(reason)
		return fmt.Errorf("%s", reason)
	}

	// Verify the project root has alice_cli/main.py
	if _, err := os.Stat(filepath.Join(projectRoot, "alice_cli", "main.py")); err != nil {
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] WARNING: alice_cli/main.py not found in projectRoot=%s: %v\n", projectRoot, err)
		}
	}

	// ALICE_WEB_DIST must point at a REAL built frontend: the backend
	// (web_server.py) fail-fasts when index.html is missing, and a source
	// checkout without `npm run build` has none. The Wails binary embeds the
	// entire frontend (go:embed frontend/dist) — extract it to the expected
	// path so the desktop works on fresh checkouts/managed installs without a
	// Node toolchain. Best-effort: on failure leave the env unset and let the
	// backend's own error surface.
	webDist := filepath.Join(projectRoot, "apps", "desktop", "dist")
	if _, err := os.Stat(filepath.Join(webDist, "index.html")); err != nil {
		if err := extractEmbeddedFrontend(webDist); err != nil {
			if debugFile != nil {
				fmt.Fprintf(debugFile, "[Wails] could not extract embedded frontend to %s: %v\n", webDist, err)
			}
			webDist = "" // don't pass a dead ALICE_WEB_DIST
		} else if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] extracted embedded frontend to %s\n", webDist)
		}
	}

	// Build environment like Electron does
	backendEnv := pm.buildBackendEnv(projectRoot)

	// backendSupportsServe probes whether the resolved runtime registers the
	// `serve` subcommand. `serve` is newer than `dashboard`; a managed install
	// or PATH `alice` that predates it makes argparse exit(2) instantly
	// ("unrecognized arguments"), the backend dies before announcing a port,
	// and the old GUI just sat on "Starting Alice" forever. Mirrors the
	// Electron shell's backendSupportsServe guard.
	backendSupportsServe := func(python, root string) bool {
		// Bounded context: 15s for a cold interpreter on a spinning disk /
		// AV-scanned Windows install to import alice_cli. Without the bound,
		// a broken runtime that ignores `--help` and starts serving (e.g. a
		// stub python) makes probe.Run() block forever — exactly the hang
		// TestStartGatewayBootE2E caught.
		probeCtx, cancelProbe := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancelProbe()
		probe := exec.CommandContext(probeCtx, python, "-m", "alice_cli.main", "serve", "--help")
		probe.Dir = root
		probe.Env = cmdEnvForBackendWithDist(pm, projectRoot, backendEnv, webDist)
		probe.Stdout = io.Discard
		probe.Stderr = io.Discard
		return probe.Run() == nil
	}

	serveArgs := []string{"-m", "alice_cli.main", "serve", "--host", "127.0.0.1", "--port", "0"}
	if !backendSupportsServe(pythonPath, projectRoot) {
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] runtime has no `serve`; falling back to legacy `dashboard --no-open`\n")
		}
		log.Printf("[Wails] runtime has no `serve`; falling back to legacy `dashboard --no-open`")
		serveArgs = []string{"-m", "alice_cli.main", "dashboard", "--no-open", "--host", "127.0.0.1", "--port", "0"}
	}

	// Boot snapshot update — inline under the already-held pm.mu. setBootStep()
	// takes pm.mu itself, so calling it mid-critical-section would self-deadlock
	// (StartGateway holds the lock from the started-flag check through spawn).
	// Mirror its monotonic clamp; the event emission happens after Unlock below.
	pm.bootPhase = "backend.spawn"
	pm.bootMessage = "Starting Alice backend"
	pm.bootProgress = 20
	spawnCtx := pm.ctx

	// Use context.Background() so the backend doesn't get killed when the startup context is cancelled
	bgCtx := context.Background()
	cmd := exec.CommandContext(bgCtx, pythonPath, serveArgs...)
	cmd.Dir = projectRoot

	// Backend env: current env + venv PYTHONPATH/PATH + Alice desktop vars
	// (incl. PYTHONUNBUFFERED=1 so the port announcement is never buffered).
	cmd.Env = cmdEnvForBackendWithDist(pm, projectRoot, backendEnv, webDist)

	// Hide the child's console window on Windows (see setChildHiddenWindow —
	// without it the backend python spawns a NEW maximized console covering
	// the GUI). No-op on POSIX.
	setChildHiddenWindow(cmd)

	logsDir := filepath.Join(pm.aliceHome, "logs")
	_ = os.MkdirAll(logsDir, 0755)

	logFile, err := os.OpenFile(filepath.Join(logsDir, "agent.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		pm.mu.Unlock()
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] Failed to open log file: %v\n", err)
		}
		return fmt.Errorf("failed to open log file: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		pm.mu.Unlock()
		logFile.Close()
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] Failed to create stdout pipe: %v\n", err)
		}
		return fmt.Errorf("failed to create stdout pipe: %w", err)
	}
	// Tee stderr to the log file AND an in-memory tail so a dead backend's
	// last words reach the boot-error UI instead of being buried in agent.log.
	stderrWriter := io.MultiWriter(logFile, &stderrTailWriter{pm: pm})
	cmd.Stderr = stderrWriter

	pm.portReady = make(chan struct{})
	pm.mu.Unlock()

	// Boot-progress event for the spawn step — emitted after Unlock because
	// EventsEmit dispatches to the renderer and must never run under pm.mu.
	if spawnCtx != nil {
		wailsruntime.EventsEmit(spawnCtx, "alice:boot-progress", BootProgress{
			FakeMode:  false,
			Message:   "Starting Alice backend",
			Phase:     "backend.spawn",
			Progress: 20,
			Running:   true,
			Timestamp: time.Now().UnixMilli(),
		})
	}

	if debugFile != nil {
		fmt.Fprintf(debugFile, "[Wails] Spawning backend process: %s %v\n", pythonPath, cmd.Args)
	}
	if err := cmd.Start(); err != nil {
		pm.mu.Lock()
		pm.running = false
		pm.mu.Unlock()
		logFile.Close()
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] Failed to start backend: %v\n", err)
		}
		pm.setBootStep("backend.spawn_failed", fmt.Sprintf("Failed to start backend: %v", err), 100, false, err.Error())
		return fmt.Errorf("failed to start python backend: %w", err)
	}

	activeCmdMu.Lock()
	activeCmd = cmd
	activeCmdMu.Unlock()

	pm.mu.Lock()
	pm.running = true
	pm.mu.Unlock()

	if debugFile != nil {
		fmt.Fprintf(debugFile, "[Wails] Backend started, PID=%d\n", cmd.Process.Pid)
	}

	go pm.watchPort(stdout, logFile, cmd)

	return nil
}

// stderrTailWriter is an io.Writer that appends complete lines to the
// PythonManager's bounded stderr tail (rendered on a backend-exit error).
type stderrTailWriter struct {
	pm *PythonManager
}

func (w *stderrTailWriter) Write(p []byte) (int, error) {
	if len(p) > 0 {
		w.pm.appendStderrLine(string(p))
	}
	return len(p), nil
}

func (pm *PythonManager) watchPort(stdout io.ReadCloser, logFile *os.File, cmd *exec.Cmd) {
	defer stdout.Close()
	defer logFile.Close()

	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for {
		n, err := stdout.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			for {
				idx := bytes.IndexByte(buf, '\n')
				if idx == -1 {
					break
				}
				line := string(buf[:idx])
				buf = buf[idx+1:]
				logFile.WriteString(line + "\n")
				log.Printf("[Wails] Backend stdout: %s", line)
				pm.tryParsePort(line)
			}
		}
		if err != nil {
			log.Printf("[Wails] Backend stdout read error: %v", err)

			// EOF means the backend exited. If it never announced a port,
			// that's the "Starting Alice" forever bug: surface it.
			pm.mu.Lock()
			neverAnnounced := pm.port == 0
			stopping := pm.stopping
			pm.mu.Unlock()

			if neverAnnounced && !stopping {
				exitCode := -1
				if err == io.EOF {
					// Reap the process to get its real exit code. Safe here:
					// reads from the StdoutPipe are complete (EOF reached).
					_ = cmd.Wait()
					if cmd.ProcessState != nil {
						exitCode = cmd.ProcessState.ExitCode()
					}
				}

				reason := fmt.Sprintf(
					"Alice backend exited before announcing its port (exit code %d)",
					exitCode,
				)
				log.Printf("[Wails] %s", reason)
				pm.emitBackendExit(reason)
			}

			return
		}
	}
}

func (pm *PythonManager) tryParsePort(line string) {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	if pm.port != 0 {
		return
	}
	m := portRe.FindStringSubmatch(line)
	if m == nil {
		return
	}
	p, err := strconv.Atoi(m[1])
	if err != nil || p < 1024 || p > 65535 {
		return
	}
	pm.port = p
	log.Printf("[Wails] Backend announced port=%d", p)
	close(pm.portReady)
	// Move the boot bar to "connecting" once the port lands; the renderer's
	// gateway.connect + handshake steps take it the rest of the way.
	go pm.setBootStep("backend.ready", fmt.Sprintf("Backend ready on port %d", p), 60, true, "")
}

// GetBackendPIDs returns the PIDs of the live backend process(es) managed by
// this desktop instance. Used for ALICE_DESKTOP_CHILD_PID so `alice update`'s
// stale-backend reaper spares them mid-update.
func (pm *PythonManager) GetBackendPIDs() []int {
	activeCmdMu.Lock()
	defer activeCmdMu.Unlock()
	if activeCmd != nil && activeCmd.Process != nil {
		return []int{activeCmd.Process.Pid}
	}
	return nil
}

func (pm *PythonManager) StopGateway() error {
	pm.mu.Lock()
	pm.stopping = true

	if !pm.running {
		pm.mu.Unlock()
		return nil
	}

	pm.port = 0
	pm.portReady = make(chan struct{})

	activeCmdMu.Lock()
	cmd := activeCmd
	activeCmd = nil
	activeCmdMu.Unlock()

	if cmd == nil || cmd.Process == nil {
		pm.running = false
		pm.mu.Unlock()
		return nil
	}

	var err error
	if runtime.GOOS == "windows" {
		err = cmd.Process.Kill()
	} else {
		err = cmd.Process.Signal(os.Interrupt)
	}

	pm.running = false
	pm.mu.Unlock()
	return err
}

func (pm *PythonManager) IsHealthy() bool {
	pm.mu.Lock()
	port := pm.port
	pm.mu.Unlock()

	if port == 0 {
		return false
	}
	client := http.Client{Timeout: 2 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/api/status", port)
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (pm *PythonManager) GetSessionToken() string {
	return pm.sessionToken
}

func (pm *PythonManager) GetConnectionInfo() ConnectionInfo {
	log.Printf("[Wails] GetConnectionInfo called")
	pm.mu.Lock()
	port := pm.port
	pm.mu.Unlock()

	info := ConnectionInfo{
		BaseURL:            fmt.Sprintf("http://127.0.0.1:%d", port),
		WSURL:              fmt.Sprintf("ws://127.0.0.1:%d/api/ws?token=%s", port, pm.sessionToken),
		Token:              pm.sessionToken,
		AuthMode:           "token",
		Mode:               "local",
		IsFullscreen:       false,
		NativeOverlayWidth: 0,
	}
	log.Printf("[Wails] GetConnectionInfo returning: baseUrl=%s wsUrl=%s", info.BaseURL, info.WSURL)
	return info
}

func (pm *PythonManager) WaitForHealthy(timeoutSeconds int) bool {
	log.Printf("[Wails] WaitForHealthy called (timeout=%ds)", timeoutSeconds)
	timeout := time.Duration(timeoutSeconds) * time.Second
	deadline := time.Now().Add(timeout)

	select {
	case <-pm.portReady:
		log.Printf("[Wails] Port announcement received")
	case <-time.After(timeout):
		log.Printf("[Wails] Timeout waiting for port announcement")
		return false
	}

	for time.Now().Before(deadline) {
		if pm.IsHealthy() {
			log.Printf("[Wails] Backend is healthy")
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	log.Printf("[Wails] Backend did not become healthy within timeout")
	return false
}

// WriteFrontendLog writes a message from the frontend to the debug log file
func (pm *PythonManager) WriteFrontendLog(msg string) {
	f, err := os.OpenFile(wailsDebugLogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "[Frontend] %s\n", msg)
}
