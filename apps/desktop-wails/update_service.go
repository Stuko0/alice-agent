package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// UpdateService implements the desktop self-update flow for the Wails shell:
// check distance from the configured branch, apply via `alice update` +
// `alice desktop --build-only` (which rebuilds THIS binary by default), then
// relaunch through a detached watcher that re-execs the fresh binary once the
// old process has exited. Mirrors Electron's applyUpdatesPosixInApp
// (apps/desktop/electron/main.cjs) so the frontend contract is identical.
type UpdateService struct {
	ctx         context.Context
	aliceHome   string
	projectRoot string
	// backendPID returns the live backend PID(s) to spare from `alice update`'s
	// stale-backend reaper (ALICE_DESKTOP_CHILD_PID).
	backendPID func() []int
}

const defaultUpdateBranch = "main"

// UpdateStatus mirrors Electron's checkUpdates() result shape.
type UpdateStatus struct {
	Supported       bool   `json:"supported"`
	Branch          string `json:"branch"`
	CurrentBranch   string `json:"currentBranch,omitempty"`
	Behind          int    `json:"behind"`
	CurrentSHA      string `json:"currentSha,omitempty"`
	TargetSHA       string `json:"targetSha,omitempty"`
	Commits         []any  `json:"commits"`
	Dirty           bool   `json:"dirty"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Error           string `json:"error,omitempty"`
	Reason          string `json:"reason,omitempty"`
	Message         string `json:"message,omitempty"`
	AliceRoot       string `json:"aliceRoot,omitempty"`
	FetchedAt       int64  `json:"fetchedAt"`
}

// UpdateApplyOptions mirrors Electron's apply payload.
type UpdateApplyOptions struct {
	Branch string `json:"branch"`
}

// UpdateApplyResult mirrors Electron's applyUpdates() result shape.
type UpdateApplyResult struct {
	OK            bool   `json:"ok"`
	Manual        bool   `json:"manual,omitempty"`
	Command       string `json:"command,omitempty"`
	GUISkew       bool   `json:"guiSkew,omitempty"`
	ManualRestart bool   `json:"manualRestart,omitempty"`
	HandedOff     bool   `json:"handedOff,omitempty"`
	Error         string `json:"error,omitempty"`
	Message       string `json:"message,omitempty"`
}

// DesktopVersionInfo mirrors the frontend's DesktopVersionInfo.
type DesktopVersionInfo struct {
	AppVersion      string `json:"appVersion"`
	ElectronVersion string `json:"electronVersion"`
	NodeVersion     string `json:"nodeVersion"`
	Platform        string `json:"platform"`
	AliceRoot       string `json:"aliceRoot"`
}

type updateConfig struct {
	Branch string `json:"branch"`
}

var _versionRe = regexp.MustCompile(`__version__\s*=\s*"([^"]+)"`)

// SetContext stores the Wails app context (for EventsEmit) and resolves the
// project root. Called from OnStartup.
func (us *UpdateService) SetContext(ctx context.Context, projectRoot string) {
	us.ctx = ctx
	us.projectRoot = projectRoot
}

func (us *UpdateService) configPath() string {
	return filepath.Join(us.aliceHome, "desktop-update-config.json")
}

func (us *UpdateService) readConfig() updateConfig {
	cfg := updateConfig{}
	if data, err := os.ReadFile(us.configPath()); err == nil {
		_ = json.Unmarshal(data, &cfg)
	}
	return cfg
}

func (us *UpdateService) writeConfig(cfg updateConfig) error {
	data, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(us.configPath(), data, 0o644)
}

func (us *UpdateService) emitProgress(stage, message string, percent *int) {
	if us.ctx == nil {
		return
	}
	payload := map[string]any{"stage": stage, "message": message}
	if percent != nil {
		payload["percent"] = *percent
	}
	wailsruntime.EventsEmit(us.ctx, "alice:updates:progress", payload)
}

func (us *UpdateService) runGit(args ...string) (string, int, error) {
	if us.projectRoot == "" {
		return "", 1, fmt.Errorf("project root not resolved")
	}
	cmd := exec.Command("git", args...)
	cmd.Dir = us.projectRoot
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			code = ee.ExitCode()
		} else {
			return string(out), 1, err
		}
	}
	return string(out), code, nil
}

// Check reports how far the checkout is from the configured branch. Passive:
// no fetch, no mutation. Mirrors Electron's checkUpdates().
func (us *UpdateService) Check() UpdateStatus {
	root := us.projectRoot
	if root == "" {
		root = pmRootFallback()
	}
	cfg := us.readConfig()
	branch := cfg.Branch

	now := time.Now().UnixMilli()
	status := UpdateStatus{
		Supported: true,
		Branch:    branch,
		Commits:   []any{},
		AliceRoot: root,
		FetchedAt: now,
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); err != nil {
		status.Supported = false
		status.Reason = "not-a-git-checkout"
		status.Message = root + " isn't a git checkout — desktop self-update only runs against a source install."
		return status
	}

	// Resolve the branch to pin: configured → current HEAD branch → main.
	if branch == "" {
		if out, code, _ := us.runGit("rev-parse", "--abbrev-ref", "HEAD"); code == 0 {
			branch = strings.TrimSpace(out)
			if branch == "HEAD" || branch == "" {
				branch = defaultUpdateBranch
			}
		} else {
			branch = defaultUpdateBranch
		}
	}
	status.Branch = branch

	currentSha, code, _ := us.runGit("rev-parse", "HEAD")
	if code != 0 {
		status.Error = "check-failed"
		status.Message = "git rev-parse HEAD failed."
		return status
	}
	currentSha = strings.TrimSpace(currentSha)
	status.CurrentSHA = currentSha

	dirtyOut, code, _ := us.runGit("status", "--porcelain")
	if code == 0 && strings.TrimSpace(dirtyOut) != "" {
		status.Dirty = true
	}

	target, code, _ := us.runGit("ls-remote", "origin", "refs/heads/"+branch)
	if code != 0 || strings.TrimSpace(target) == "" {
		status.Error = "fetch-failed"
		status.Message = "git ls-remote origin failed."
		return status
	}
	targetSha := strings.TrimSpace(strings.Fields(target)[0])
	status.TargetSHA = targetSha
	status.Behind = 0
	if currentSha != targetSha {
		status.Behind = 1
	}
	status.UpdateAvailable = currentSha != targetSha
	return status
}

// GetBranch returns the configured update branch (may be empty = follow HEAD).
func (us *UpdateService) GetBranch() map[string]string {
	return map[string]string{"branch": us.readConfig().Branch}
}

// SetBranch persists the update branch pin.
func (us *UpdateService) SetBranch(name string) map[string]string {
	branch := strings.TrimSpace(name)
	if err := us.writeConfig(updateConfig{Branch: branch}); err != nil {
		return map[string]string{"branch": branch, "error": err.Error()}
	}
	return map[string]string{"branch": branch}
}

// GetVersion reports runtime/version info for the About panel.
func (us *UpdateService) GetVersion() DesktopVersionInfo {
	root := us.projectRoot
	if root == "" {
		root = pmRootFallback()
	}
	appVersion := "0.0.0"
	if data, err := os.ReadFile(filepath.Join(root, "alice_cli", "__init__.py")); err == nil {
		if m := _versionRe.FindSubmatch(data); m != nil {
			appVersion = string(m[1])
		}
	}
	return DesktopVersionInfo{
		AppVersion:      appVersion,
		ElectronVersion: "wails-v2",
		NodeVersion:     runtime.Version(),
		Platform:        runtime.GOOS,
		AliceRoot:       root,
	}
}

// Apply runs the full update: alice update (branch-pinned, backend spared) →
// alice desktop --build-only (rebuilds THIS Wails binary) → detached watcher
// that re-execs the fresh binary once we exit. Returns handedOff=true when the
// relaunch watcher took over.
func (us *UpdateService) Apply(opts UpdateApplyOptions) UpdateApplyResult {
	root := us.projectRoot
	if root == "" {
		root = pmRootFallback()
	}
	cfg := us.readConfig()
	branch := opts.Branch
	if branch == "" {
		branch = cfg.Branch
	}
	if branch == "" {
		if out, code, _ := us.runGit("rev-parse", "--abbrev-ref", "HEAD"); code == 0 {
			branch = strings.TrimSpace(out)
			if branch == "HEAD" || branch == "" {
				branch = defaultUpdateBranch
			}
		} else {
			branch = defaultUpdateBranch
		}
	}

	alice := resolveAliceCliBinary(root)
	if alice == "" {
		us.emitProgress("manual", "alice update", nil)
		return UpdateApplyResult{OK: true, Manual: true, Command: "alice update"}
	}

	env := map[string]string{
		"ALICE_HOME": us.aliceHome,
		"PATH":       venvBinOnPath(root),
	}
	if pids := us.backendPID(); len(pids) > 0 {
		var parts []string
		for _, p := range pids {
			parts = append(parts, strconv.Itoa(p))
		}
		env["ALICE_DESKTOP_CHILD_PID"] = strings.Join(parts, ",")
	}

	// Stage 1: `alice update --yes --branch <branch>`
	p10 := 10
	us.emitProgress("update", "Updating Alice (git + dependencies)…", &p10)
	if code, msg := us.runStreamed(alice, []string{"update", "--yes", "--branch", branch}, root, env, "update"); code != 0 {
		us.emitProgress("error", "alice update failed.", nil)
		return UpdateApplyResult{OK: false, Error: "update-failed", Message: msg}
	}

	// Stage 2: rebuild this binary (`alice desktop --build-only` defaults to
	// Wails now; no --electron pin needed).
	p60 := 60
	us.emitProgress("rebuild", "Rebuilding the desktop app…", &p60)
	code, msg := us.runStreamed(alice, []string{"desktop", "--build-only"}, root, env, "rebuild")
	if code != 0 {
		// Retry once — the first rebuild can fail on a still-settling tree.
		us.emitProgress("rebuild", "Retrying the desktop rebuild…", &p60)
		code, msg = us.runStreamed(alice, []string{"desktop", "--build-only"}, root, env, "rebuild")
	}
	if code != 0 {
		us.emitProgress("error", "Backend updated, but the desktop rebuild failed. Restart Alice to retry.", nil)
		return UpdateApplyResult{OK: false, Error: "rebuild-failed", Message: msg}
	}

	// Stage 3: detached watcher — wait for us to exit, then re-exec the fresh
	// binary with the same argv/env/cwd.
	p100 := 100
	us.emitProgress("restart", "Restarting Alice…", &p100)
	exe, err := os.Executable()
	if err != nil {
		us.emitProgress("error", "Could not resolve the app executable for relaunch.", nil)
		return UpdateApplyResult{OK: true, ManualRestart: true, Message: "Restart Alice to load the update."}
	}
	scriptPath, err := writeRelaunchWatcher(os.Getpid(), exe, os.Args[1:], root)
	if err != nil {
		us.emitProgress("error", "Could not prepare the relaunch script.", nil)
		return UpdateApplyResult{OK: true, ManualRestart: true, Message: "Restart Alice to load the update."}
	}
	if err := spawnDetached(scriptPath); err != nil {
		us.emitProgress("error", "Could not start the relaunch watcher.", nil)
		return UpdateApplyResult{OK: true, ManualRestart: true, Message: "Restart Alice to load the update."}
	}
	return UpdateApplyResult{OK: true, HandedOff: true}
}

// runStreamed runs a command, streaming each output line to the progress
// channel under the given stage. Returns (exitCode, lastErrorLine).
func (us *UpdateService) runStreamed(command string, args []string, cwd string, env map[string]string, stage string) (int, string) {
	cmd := exec.Command(command, args...)
	cmd.Dir = cwd
	cmd.Env = append(os.Environ(), envToSlice(env)...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return 1, err.Error()
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return 1, err.Error()
	}
	last := ""
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		last = line
		us.emitProgress(stage, line, nil)
	}
	_ = cmd.Wait()
	return cmd.ProcessState.ExitCode(), last
}

// venvBinOnPath prepends the venv bin dir (and keeps the rest of PATH) so the
// update/rebuild subprocess finds the alice CLI and node on a machine with no
// system Node.
func venvBinOnPath(root string) string {
	binDir := filepath.Join(root, "venv", "bin")
	if runtime.GOOS == "windows" {
		binDir = filepath.Join(root, "venv", "Scripts")
	}
	return binDir + string(os.PathListSeparator) + os.Getenv("PATH")
}

func envToSlice(env map[string]string) []string {
	var out []string
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

// resolveAliceCliBinary finds the alice CLI: venv-managed first, then PATH.
func resolveAliceCliBinary(root string) string {
	name := "alice"
	if runtime.GOOS == "windows" {
		name = "alice.exe"
	}
	venvAlice := filepath.Join(root, "venv", "bin", name)
	if runtime.GOOS == "windows" {
		venvAlice = filepath.Join(root, "venv", "Scripts", name)
	}
	if _, err := os.Stat(venvAlice); err == nil {
		return venvAlice
	}
	if path, err := exec.LookPath("alice"); err == nil {
		return path
	}
	return ""
}

// pmRootFallback resolves the project root through the PythonManager (the
// shared resolver used by StartGateway) when SetContext hasn't run yet.
func pmRootFallback() string {
	pm := NewPythonManager()
	return pm.ResolveProjectRoot()
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// writeRelaunchWatcher writes a detached watcher script that polls the old
// PID and re-execs the (freshly rebuilt) binary with the same args/cwd once
// the old process exits.
func writeRelaunchWatcher(pid int, exe string, args []string, cwd string) (string, error) {
	argStr := ""
	for _, a := range args {
		argStr += " " + shellQuote(a)
	}
	dir := os.TempDir()
	if runtime.GOOS == "windows" {
		// PowerShell watcher: poll the PID, then Start-Process the new binary.
		script := fmt.Sprintf(`while (Get-Process -Id %d -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }
Start-Process -FilePath %s -WorkingDirectory %s -ArgumentList @(%s)`, pid, shellQuote(exe), shellQuote(cwd), argStr)
		path := filepath.Join(dir, fmt.Sprintf("alice-desktop-update-%d.ps1", time.Now().UnixNano()))
		if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
			return "", err
		}
		return path, nil
	}
	script := fmt.Sprintf(`#!/bin/bash
while kill -0 %d 2>/dev/null; do sleep 0.5; done
cd %s
exec %s%s
`, pid, shellQuote(cwd), shellQuote(exe), argStr)
	path := filepath.Join(dir, fmt.Sprintf("alice-desktop-update-%d.sh", time.Now().UnixNano()))
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		return "", err
	}
	return path, nil
}

// spawnDetached launches the watcher fully detached from this process so it
// survives our exit. Platform-specific (Setsid on POSIX, CREATE_NO_WINDOW on
// Windows) — see relaunch_posix.go / relaunch_windows.go.
