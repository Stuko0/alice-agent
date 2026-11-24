package host

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Resolver answers the two questions the host needs before it can run
// anything: where Alice keeps its state (ALICE_HOME) and which Python
// interpreter owns the agent backend.
//
// Every dependency is a field so tests never touch the real machine.
type Resolver struct {
	GOOS         string
	HomeDir      string
	LocalAppData string
	AliceHomeEnv string
	PythonEnv    string

	LookPath   func(string) (string, error)
	Stat       func(string) (os.FileInfo, error)
	Executable func() (string, error)
	WorkingDir func() (string, error)
}

// DefaultResolver builds a Resolver from the real environment.
func DefaultResolver() Resolver {
	home, _ := os.UserHomeDir()
	return Resolver{
		GOOS:         runtime.GOOS,
		HomeDir:      home,
		LocalAppData: os.Getenv("LOCALAPPDATA"),
		AliceHomeEnv: os.Getenv("ALICE_HOME"),
		PythonEnv:    os.Getenv("ALICE_PYTHON"),
		LookPath:     exec.LookPath,
		Stat:         os.Stat,
		Executable:   os.Executable,
		WorkingDir:   os.Getwd,
	}
}

// Home returns the active ALICE_HOME and where the value came from.
//
// This mirrors alice_constants.get_alice_home():
//   - ALICE_HOME wins when set;
//   - Windows defaults to %LOCALAPPDATA%\alice;
//   - everything else defaults to ~/.alice.
//
// Profiles (-p/--profile) are deliberately NOT interpreted here. The Python
// entry point owns that parsing (including the `mcp add --args` passthrough
// region), and duplicating it in Go is how the two implementations drift.
func (r Resolver) Home() (string, string) {
	if v := strings.TrimSpace(r.AliceHomeEnv); v != "" {
		return filepath.Clean(v), "ALICE_HOME"
	}
	if r.GOOS == "windows" {
		base := strings.TrimSpace(r.LocalAppData)
		if base == "" {
			base = filepath.Join(r.HomeDir, "AppData", "Local")
		}
		return filepath.Join(base, "alice"), "default"
	}
	return filepath.Join(r.HomeDir, ".alice"), "default"
}

// Runtime is a resolved Python interpreter and the argv prefix that runs the
// Alice CLI module.
type Runtime struct {
	Python string
	Args   []string
	Source string
}

type candidate struct {
	path   string
	source string
}

// aliceModuleArgs runs the package entry point rather than a console script.
// Exec'ing a script named `alice` would risk recursing into this very binary
// when the Go host is the one on PATH.
func aliceModuleArgs() []string { return []string{"-m", "alice_cli.main"} }

// Python resolves the interpreter that owns the agent backend.
//
// Order (first existing file wins):
//  1. ALICE_PYTHON (explicit escape hatch, trusted as-is);
//  2. <repo>/.venv then <repo>/venv, where <repo> is inferred from the host
//     binary location (go/bin/alice -> repo root);
//  3. the same two venvs in the current working directory;
//  4. $ALICE_HOME/alice-agent/{.venv,venv} (worktrees that share a venv);
//  5. python3 then python from PATH.
func (r Resolver) Python() (Runtime, error) {
	if v := strings.TrimSpace(r.PythonEnv); v != "" {
		return Runtime{Python: v, Args: aliceModuleArgs(), Source: "ALICE_PYTHON"}, nil
	}

	var candidates []candidate

	if exe, err := r.Executable(); err == nil && exe != "" {
		// go/bin/alice -> go/bin -> go -> repo root.
		root := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
		candidates = append(candidates, r.venvCandidates(root, "checkout")...)
	}
	if wd, err := r.WorkingDir(); err == nil && wd != "" {
		candidates = append(candidates, r.venvCandidates(wd, "workdir")...)
	}
	if home, _ := r.Home(); home != "" {
		candidates = append(candidates, r.venvCandidates(filepath.Join(home, "alice-agent"), "ALICE_HOME")...)
	}
	for _, name := range []string{"python3", "python"} {
		if p, err := r.LookPath(name); err == nil && p != "" {
			candidates = append(candidates, candidate{path: p, source: "PATH"})
		}
	}

	seen := make(map[string]bool, len(candidates))
	for _, c := range candidates {
		clean := filepath.Clean(c.path)
		if seen[clean] {
			continue
		}
		seen[clean] = true
		if r.isFile(clean) {
			return Runtime{Python: clean, Args: aliceModuleArgs(), Source: c.source}, nil
		}
	}

	home, _ := r.Home()
	return Runtime{}, fmt.Errorf(
		"no Python interpreter found (looked in .venv/venv, %s/alice-agent, and PATH)",
		home,
	)
}

func (r Resolver) venvCandidates(root, source string) []candidate {
	out := make([]candidate, 0, 2)
	for _, venv := range []string{".venv", "venv"} {
		out = append(out, candidate{path: venvPython(root, venv, r.GOOS), source: source})
	}
	return out
}

func venvPython(root, venv, goos string) string {
	if goos == "windows" {
		return filepath.Join(root, venv, "Scripts", "python.exe")
	}
	return filepath.Join(root, venv, "bin", "python")
}

func (r Resolver) isFile(path string) bool {
	if r.Stat == nil {
		return false
	}
	info, err := r.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

// CheckoutRoot returns the repository root when the runtime was resolved from
// a checkout venv (<root>/{.venv,venv}/{bin,Scripts}/python), else "".
//
// The root is the working directory the child needs so `-m tui_gateway.entry`
// resolves without the package being pip-installed.
func (r Resolver) CheckoutRoot(rt Runtime) string {
	if rt.Source != "checkout" || rt.Python == "" {
		return ""
	}
	return filepath.Dir(filepath.Dir(filepath.Dir(rt.Python)))
}
