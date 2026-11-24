package host

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"gopkg.in/yaml.v3"
)

// Opt-in parity check against the Python implementation:
//
//	ALICE_CONFIG_PARITY=1 go test ./internal/host -run ConfigSetParity -v
//
// Runs the same `config set` operations through Python and through the native
// Go path on identical fixtures, then compares the parsed YAML. Comments are
// intentionally not compared: Python's ruamel write drops them, the Go path
// keeps them.
func TestConfigSetParityWithPython(t *testing.T) {
	if os.Getenv("ALICE_CONFIG_PARITY") != "1" {
		t.Skip("set ALICE_CONFIG_PARITY=1 to diff against the Python implementation")
	}

	repoRoot, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	python := parityPython(t, repoRoot)

	fixture := "model:\n  provider: openrouter\ncustom_providers:\n  - name: a\n    api_key: old\n"
	pyHome := t.TempDir()
	goHome := t.TempDir()
	for _, home := range []string{pyHome, goHome} {
		if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte(fixture), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("ALICE_MANAGED_DIR", filepath.Join(t.TempDir(), "absent"))

	cases := [][2]string{
		{"model.default", "test/model"},
		{"agent.max_turns", "42"},
		{"display.mouse", "true"},
		{"custom_providers.0.api_key", "new-key"},
	}

	for _, tc := range cases {
		cmd := exec.Command(python, "-m", "alice_cli.main", "config", "set", tc[0], tc[1])
		cmd.Dir = repoRoot
		cmd.Env = append(os.Environ(), "ALICE_HOME="+pyHome)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("python config set %v: %v\n%s", tc, err, out)
		}

		var stdout, stderr bytes.Buffer
		opts := Options{
			Stdout:   &stdout,
			Stderr:   &stderr,
			Resolver: Resolver{GOOS: "linux", HomeDir: goHome, AliceHomeEnv: goHome, Stat: os.Stat},
		}
		handled, code := runConfigNative(opts, []string{"set", tc[0], tc[1]})
		if !handled || code != 0 {
			t.Fatalf("go config set %v: handled=%v code=%d stderr=%s", tc, handled, code, stderr.String())
		}
	}

	pyDoc := readYAMLMap(t, filepath.Join(pyHome, "config.yaml"))
	goDoc := readYAMLMap(t, filepath.Join(goHome, "config.yaml"))

	if !reflect.DeepEqual(pyDoc, goDoc) {
		t.Fatalf("semantic mismatch\npython: %#v\ngo:     %#v", pyDoc, goDoc)
	}

	raw, err := os.ReadFile(filepath.Join(goHome, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("api_key: new-key")) {
		t.Fatalf("nested list edit missing:\n%s", raw)
	}
}

func parityPython(t *testing.T, repoRoot string) string {
	t.Helper()
	if explicit := os.Getenv("ALICE_PYTHON"); explicit != "" {
		return explicit
	}
	name := filepath.Join(".venv", "bin", "python")
	if runtime.GOOS == "windows" {
		name = filepath.Join(".venv", "Scripts", "python.exe")
	}
	candidate := filepath.Join(repoRoot, name)
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	t.Skipf("no .venv Python under %s", repoRoot)
	return ""
}

func readYAMLMap(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return parsed
}
