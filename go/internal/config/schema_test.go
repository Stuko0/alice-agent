package config

import (
	"os"
	"reflect"
	"testing"
)

func TestSchemaLoads(t *testing.T) {
	version, err := LatestVersion()
	if err != nil {
		t.Fatal(err)
	}
	if version < 1 {
		t.Fatalf("version = %d", version)
	}

	defaults, err := Defaults()
	if err != nil {
		t.Fatal(err)
	}
	agent, ok := defaults["agent"].(map[string]any)
	if !ok {
		t.Fatalf("agent defaults = %T", defaults["agent"])
	}
	if _, ok := agent["max_turns"].(int); !ok {
		t.Fatalf("max_turns type = %T", agent["max_turns"])
	}

	// Defaults must be a copy: mutating it must not affect the next caller.
	agent["max_turns"] = 1
	again, _ := Defaults()
	if again["agent"].(map[string]any)["max_turns"] == 1 {
		t.Fatal("Defaults returned a shared map")
	}

	env, err := OptionalEnv()
	if err != nil {
		t.Fatal(err)
	}
	if len(env) == 0 || env[0].Name == "" {
		t.Fatalf("optional env = %+v", env[:1])
	}
}

func TestMergeSemantics(t *testing.T) {
	defaults := map[string]any{
		"a":    1,
		"m":    map[string]any{"x": 1, "y": 2},
		"list": []any{1, 2},
	}
	user := map[string]any{
		"a":    9,
		"m":    map[string]any{"y": 20},
		"list": []any{3},
	}
	got := Merge(defaults, user)

	if got["a"] != 9 {
		t.Fatalf("a = %v", got["a"])
	}
	m := got["m"].(map[string]any)
	if m["x"] != 1 || m["y"] != 20 {
		t.Fatalf("m = %v", m)
	}
	if !reflect.DeepEqual(got["list"], []any{3}) {
		t.Fatalf("list = %v", got["list"])
	}
	// The inputs must not be mutated.
	if defaults["a"] != 1 || defaults["m"].(map[string]any)["y"] != 2 {
		t.Fatal("Merge mutated defaults")
	}
}

func TestMissingFields(t *testing.T) {
	defaults := map[string]any{
		"agent":           map[string]any{"max_turns": 90, "nested": map[string]any{"k": 1}},
		"_config_version": 32,
	}
	raw := map[string]any{"agent": map[string]any{}}

	missing := MissingFields(defaults, raw)
	want := map[string]bool{"agent.max_turns": true, "agent.nested": true}
	if len(missing) != len(want) {
		t.Fatalf("missing = %v", missing)
	}
	for _, key := range missing {
		if !want[key] {
			t.Fatalf("unexpected missing key %q", key)
		}
	}

	if got := MissingFields(defaults, defaults); len(got) != 0 {
		t.Fatalf("merged config reported missing: %v", got)
	}
}

func TestMasking(t *testing.T) {
	if got := MaskValue("model.api_key", "sk-1234567890"); got != "sk-1...7890" {
		t.Fatalf("mask = %q", got)
	}
	if got := MaskValue("model.default", "deepseek"); got != "deepseek" {
		t.Fatalf("non-secret = %q", got)
	}

	tree := MaskTree(map[string]any{
		"model": map[string]any{"api_key": "supersecretvalue", "default": "m"},
	})
	model := tree["model"].(map[string]any)
	if model["api_key"] == "supersecretvalue" {
		t.Fatal("secret not masked")
	}
	if model["default"] != "m" {
		t.Fatalf("non-secret changed: %v", model["default"])
	}
}

func TestParseEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/.env"
	content := "# comment\nexport OPENROUTER_API_KEY=sk-1\nQUOTED=\"a b\"\nSINGLE='c'\nEMPTY=\nBADLINE\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	env := ParseEnvFile(path)
	if env["OPENROUTER_API_KEY"] != "sk-1" || env["QUOTED"] != "a b" || env["SINGLE"] != "c" {
		t.Fatalf("env = %v", env)
	}
	if _, ok := env["BADLINE"]; ok {
		t.Fatal("malformed line parsed")
	}
}
