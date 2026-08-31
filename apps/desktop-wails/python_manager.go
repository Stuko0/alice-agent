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

	// PATH lookup
	for _, name := range []string{"python3", "python"} {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}

	return "python3"
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

	// Fallback: try common versions
	for _, ver := range []string{"3.13", "3.12", "3.11", "3.10"} {
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

	// Verify the project root has alice_cli/main.py
	if _, err := os.Stat(filepath.Join(projectRoot, "alice_cli", "main.py")); err != nil {
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] WARNING: alice_cli/main.py not found in projectRoot=%s: %v\n", projectRoot, err)
		}
	}

	webDist := filepath.Join(projectRoot, "apps", "desktop", "dist")
	_ = os.MkdirAll(filepath.Join(webDist, "assets"), 0755)

	// Build environment like Electron does
	backendEnv := pm.buildBackendEnv(projectRoot)

	// Use context.Background() so the backend doesn't get killed when the startup context is cancelled
	bgCtx := context.Background()
	cmd := exec.CommandContext(bgCtx, pythonPath, "-m", "alice_cli.main", "serve", "--host", "127.0.0.1", "--port", "0")
	cmd.Dir = projectRoot

	// Merge with current env, overriding with backend-specific values
	env := os.Environ()
	envMap := make(map[string]string)
	for _, e := range env {
		if idx := bytes.IndexByte([]byte(e), '='); idx > 0 {
			envMap[string(e[:idx])] = string(e[idx+1:])
		}
	}
	for k, v := range backendEnv {
		envMap[k] = v
	}
	// Add Alice-specific env vars
	envMap["ALICE_HOME"] = pm.aliceHome
	envMap["ALICE_DESKTOP"] = "1"
	envMap["ALICE_WEB_DIST"] = webDist
	envMap["ALICE_DASHBOARD_SESSION_TOKEN"] = pm.sessionToken

	// Rebuild env slice
	env = nil
	for k, v := range envMap {
		env = append(env, k+"="+v)
	}
	cmd.Env = env

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
	cmd.Stderr = logFile

	pm.portReady = make(chan struct{})

	if debugFile != nil {
		fmt.Fprintf(debugFile, "[Wails] Spawning backend process: %s %v\n", pythonPath, cmd.Args)
	}
	if err := cmd.Start(); err != nil {
		pm.mu.Unlock()
		logFile.Close()
		if debugFile != nil {
			fmt.Fprintf(debugFile, "[Wails] Failed to start backend: %v\n", err)
		}
		return fmt.Errorf("failed to start python backend: %w", err)
	}

	activeCmdMu.Lock()
	activeCmd = cmd
	activeCmdMu.Unlock()

	pm.running = true
	pm.mu.Unlock()

	if debugFile != nil {
		fmt.Fprintf(debugFile, "[Wails] Backend started, PID=%d\n", cmd.Process.Pid)
	}

	go pm.watchPort(stdout, logFile)

	return nil
}

func (pm *PythonManager) watchPort(stdout io.ReadCloser, logFile *os.File) {
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
	defer pm.mu.Unlock()

	if !pm.running {
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
		return nil
	}

	var err error
	if runtime.GOOS == "windows" {
		err = cmd.Process.Kill()
	} else {
		err = cmd.Process.Signal(os.Interrupt)
	}

	pm.running = false
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
