package host

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

	// Profile is an explicitly selected profile (`-p name`). Empty means
	// "whatever ALICE_HOME / active_profile says".
	Profile string
	// HomeOverride, when set, wins over every other rule. The dispatcher
	// fills it after validating an explicit profile.
	HomeOverride       string
	HomeOverrideSource string
	// SupervisedChild mirrors ALICE_S6_SUPERVISED_CHILD: a supervised slot
	// must not follow the sticky active_profile.
	SupervisedChild bool

	LookPath   func(string) (string, error)
	Stat       func(string) (os.FileInfo, error)
	ReadFile   func(string) ([]byte, error)
	Executable func() (string, error)
	WorkingDir func() (string, error)
}

// DefaultResolver builds a Resolver from the real environment.
func DefaultResolver() Resolver {
	home, _ := os.UserHomeDir()
	return Resolver{
		GOOS:            runtime.GOOS,
		HomeDir:         home,
		LocalAppData:    os.Getenv("LOCALAPPDATA"),
		AliceHomeEnv:    os.Getenv("ALICE_HOME"),
		PythonEnv:       os.Getenv("ALICE_PYTHON"),
		SupervisedChild: os.Getenv("ALICE_S6_SUPERVISED_CHILD") != "",
		LookPath:        exec.LookPath,
		Stat:            os.Stat,
		ReadFile:        os.ReadFile,
		Executable:      os.Executable,
		WorkingDir:      os.Getwd,
	}
}

// Home returns the active ALICE_HOME and where the value came from.
//
// Precedence (mirrors alice_cli.main._apply_profile_override +
// alice_constants.get_alice_home):
//  1. an explicit profile validated by the dispatcher (HomeOverride);
//  2. a sticky `active_profile` file under the default root, unless disabled;
//  3. ALICE_HOME;
//  4. the platform default (%LOCALAPPDATA%\alice on Windows, ~/.alice elsewhere).
func (r Resolver) Home() (string, string) {
	if r.HomeOverride != "" {
		return r.HomeOverride, r.HomeOverrideSource
	}
	if p := r.activeProfile(); p != "" {
		return filepath.Join(r.ProfilesRoot(), p), "profile:" + p
	}
	if v := strings.TrimSpace(r.AliceHomeEnv); v != "" {
		return filepath.Clean(v), "ALICE_HOME"
	}
	return r.NativeHome(), "default"
}

// NativeHome is the platform default install root, ignoring ALICE_HOME.
func (r Resolver) NativeHome() string {
	if r.GOOS == "windows" {
		base := strings.TrimSpace(r.LocalAppData)
		if base == "" {
			base = filepath.Join(r.HomeDir, "AppData", "Local")
		}
		return filepath.Join(base, "alice")
	}
	return filepath.Join(r.HomeDir, ".alice")
}

// DefaultRoot is the pre-profile root: the native home, or ALICE_HOME when it
// points outside it (Docker/custom deployments), with `<root>/profiles/<name>`
// collapsed back to `<root>`.
func (r Resolver) DefaultRoot() string {
	native := r.NativeHome()
	env := strings.TrimSpace(r.AliceHomeEnv)
	if env == "" {
		return native
	}
	env = filepath.Clean(env)
	if isUnder(env, native) {
		return native
	}
	if filepath.Base(filepath.Dir(env)) == "profiles" && filepath.Base(env) != "profiles" {
		return filepath.Dir(filepath.Dir(env))
	}
	return env
}

// ProfilesRoot is where named profiles live.
func (r Resolver) ProfilesRoot() string {
	return filepath.Join(r.DefaultRoot(), "profiles")
}

// activeProfile returns the sticky profile to use, if any. An ALICE_HOME that
// already points at a profile wins (same heuristic as Python: the immediate
// parent directory is named "profiles").
func (r Resolver) activeProfile() string {
	if r.Profile != "" {
		return r.Profile
	}
	env := strings.TrimSpace(r.AliceHomeEnv)
	if env != "" && filepath.Base(filepath.Dir(filepath.Clean(env))) == "profiles" {
		return ""
	}
	if r.SupervisedChild || r.ReadFile == nil {
		return ""
	}
	data, err := r.ReadFile(filepath.Join(r.DefaultRoot(), "active_profile"))
	if err != nil {
		return ""
	}
	name := strings.TrimSpace(string(data))
	if name == "" || name == "default" {
		return ""
	}
	return name
}

var profileIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// ValidateProfileName mirrors alice_cli.profiles._PROFILE_ID_RE. Python also
// accepts "default" case-insensitively as an alias.
func ValidateProfileName(name string) error {
	canon := strings.ToLower(strings.TrimSpace(name))
	if canon == "default" {
		return nil
	}
	if !profileIDRe.MatchString(canon) {
		return fmt.Errorf("invalid profile name %q", name)
	}
	return nil
}

// ResolveProfile maps a profile name to its ALICE_HOME directory. It does not
// check existence for "default".
func (r Resolver) ResolveProfile(name string) (string, error) {
	canon := strings.ToLower(strings.TrimSpace(name))
	if err := ValidateProfileName(canon); err != nil {
		return "", err
	}
	if canon == "default" {
		return r.DefaultRoot(), nil
	}
	dir := filepath.Join(r.ProfilesRoot(), canon)
	if !r.isDir(dir) {
		return "", fmt.Errorf(
			"profile %q does not exist (create it with: alice profile create %s)",
			canon, canon,
		)
	}
	return dir, nil
}

func isUnder(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (r Resolver) isDir(path string) bool {
	if r.Stat == nil {
		return false
	}
	info, err := r.Stat(path)
	return err == nil && info.IsDir()
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

	if r.Executable != nil {
		if exe, err := r.Executable(); err == nil && exe != "" {
			// go/bin/alice -> go/bin -> go -> repo root.
			root := filepath.Dir(filepath.Dir(filepath.Dir(exe)))
			candidates = append(candidates, r.venvCandidates(root, "checkout")...)
		}
	}
	if r.WorkingDir != nil {
		if wd, err := r.WorkingDir(); err == nil && wd != "" {
			candidates = append(candidates, r.venvCandidates(wd, "workdir")...)
		}
	}
	if home, _ := r.Home(); home != "" {
		candidates = append(candidates, r.venvCandidates(filepath.Join(home, "alice-agent"), "ALICE_HOME")...)
	}
	if r.LookPath != nil {
		for _, name := range []string{"python3", "python"} {
			if p, err := r.LookPath(name); err == nil && p != "" {
				candidates = append(candidates, candidate{path: p, source: "PATH"})
			}
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
