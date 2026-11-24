package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"gopkg.in/yaml.v3"
)

// Opt-in per-version parity against Python's migrate_config:
//
//	ALICE_CONFIG_MIGRATION_PARITY=1 go test ./internal/config -run MigrationParity -v
//
// Each fixture is migrated twice (Python and Go) from identical homes; the
// parsed YAML must match. Interactive prompts are disabled on the Python side
// and none of these versions introduce new env vars.
func TestMigrationParity(t *testing.T) {
	if os.Getenv("ALICE_CONFIG_MIGRATION_PARITY") != "1" {
		t.Skip("set ALICE_CONFIG_MIGRATION_PARITY=1 to diff migrations against Python")
	}

	repoRoot, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	python := parityPython(t, repoRoot)

	fixtures := map[string]string{
		"v28": `_config_version: 28
memory:
  write_mode: approve
skills:
  write_mode: off
agent:
  verify_on_stop: auto
`,
		"v29": `_config_version: 29
memory:
  write_approval: true
agent:
  verify_on_stop: auto
`,
		"v30": `_config_version: 30
agent:
  verify_on_stop: true
`,
		"v31_false": `_config_version: 31
agent:
  verify_on_stop: false
`,
		"v31_true": `_config_version: 31
agent:
  verify_on_stop: true
`,
	}

	for name, fixture := range fixtures {
		t.Run(name, func(t *testing.T) {
			pyHome := t.TempDir()
			goHome := t.TempDir()
			for _, home := range []string{pyHome, goHome} {
				if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte(fixture), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(home, ".env"), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}

			script := "from alice_cli.config import migrate_config; migrate_config(interactive=False, quiet=True)"
			cmd := exec.Command(python, "-c", script)
			cmd.Dir = repoRoot
			cmd.Env = append(os.Environ(), "ALICE_HOME="+pyHome)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("python migrate: %v\n%s", err, out)
			}

			doc, err := Load(filepath.Join(goHome, "config.yaml"))
			if err != nil {
				t.Fatal(err)
			}
			if _, handled, err := doc.MigrateToLatest(); err != nil || !handled {
				t.Fatalf("go migrate: handled=%v err=%v", handled, err)
			}

			pyDoc := readYAMLMap(t, filepath.Join(pyHome, "config.yaml"))
			goDoc := readYAMLMap(t, filepath.Join(goHome, "config.yaml"))
			if !reflect.DeepEqual(pyDoc, goDoc) {
				t.Fatalf("migration mismatch\npython: %#v\ngo:     %#v", pyDoc, goDoc)
			}

			pyEnv, _ := os.ReadFile(filepath.Join(pyHome, ".env"))
			goEnv, _ := os.ReadFile(filepath.Join(goHome, ".env"))
			if string(pyEnv) != string(goEnv) {
				t.Fatalf(".env mismatch\npython: %q\ngo:     %q", pyEnv, goEnv)
			}
		})
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
