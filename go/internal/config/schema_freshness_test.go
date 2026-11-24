package config

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

// Opt-in: proves the embedded snapshot matches the Python config module.
//
//	ALICE_CONFIG_SCHEMA_FRESHNESS=1 go test ./internal/config -run SchemaFreshness -v
//
// Run `python scripts/gen_go_config_schema.py` when it fails.
func TestSchemaFreshness(t *testing.T) {
	if os.Getenv("ALICE_CONFIG_SCHEMA_FRESHNESS") != "1" {
		t.Skip("set ALICE_CONFIG_SCHEMA_FRESHNESS=1 to compare against Python")
	}

	repoRoot, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(schemaPython(t, repoRoot), "scripts/gen_go_config_schema.py", "--stdout")
	cmd.Dir = repoRoot
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("generator failed: %v", err)
	}

	generated := decodeJSON(t, out)
	embedded := decodeJSON(t, schemaJSON)

	if !reflect.DeepEqual(generated, embedded) {
		t.Fatal("internal/config/schema.json is stale; run: python scripts/gen_go_config_schema.py")
	}
}

func schemaPython(t *testing.T, repoRoot string) string {
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

func decodeJSON(t *testing.T, data []byte) any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
	return value
}
