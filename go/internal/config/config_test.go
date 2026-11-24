package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFixture(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const annotatedConfig = `# top comment
model:
  # provider comment
  provider: openrouter  # inline note
  default: old/model

# display section
display:
  skin: default
`

func TestRoundTripPreservesCommentsAndOrder(t *testing.T) {
	path := writeFixture(t, annotatedConfig)

	doc, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := doc.Set("model.default", "new/model"); err != nil {
		t.Fatal(err)
	}
	if err := doc.Set("agent.max_turns", "42"); err != nil {
		t.Fatal(err)
	}
	if err := doc.Save(); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)

	for _, comment := range []string{"# top comment", "# provider comment", "# inline note", "# display section"} {
		if !strings.Contains(text, comment) {
			t.Fatalf("comment %q lost:\n%s", comment, text)
		}
	}
	if strings.Index(text, "model:") > strings.Index(text, "display:") {
		t.Fatalf("key order changed:\n%s", text)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if value, ok := reloaded.Get("model.default"); !ok || value != "new/model" {
		t.Fatalf("model.default = %v (%v)", value, ok)
	}
	if value, ok := reloaded.Get("agent.max_turns"); !ok || value != 42 {
		t.Fatalf("agent.max_turns = %v (%T)", value, value)
	}
}

func TestSetCoercionMatchesPython(t *testing.T) {
	doc, err := Load(filepath.Join(t.TempDir(), "missing.yaml"))
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		raw  string
		want any
	}{
		{"true", true},
		{"YES", true},
		{"on", true},
		{"false", false},
		{"no", false},
		{"42", 42},
		{"3.14", 3.14},
		// Python uses str.isdigit(), so signed numbers stay strings.
		{"-1", "-1"},
		{"1.2.3", "1.2.3"},
		{"hello", "hello"},
		{"", ""},
	}

	for _, tc := range cases {
		if err := doc.Set("k", tc.raw); err != nil {
			t.Fatalf("%q: %v", tc.raw, err)
		}
		got, ok := doc.Get("k")
		if !ok || got != tc.want {
			t.Fatalf("%q -> %v (%T), want %v (%T)", tc.raw, got, got, tc.want, tc.want)
		}
	}
}

func TestSetNestedCreatesMappings(t *testing.T) {
	doc, err := Load(filepath.Join(t.TempDir(), "missing.yaml"))
	if err != nil {
		t.Fatal(err)
	}

	if err := doc.Set("a.b.c", "7"); err != nil {
		t.Fatal(err)
	}
	if value, ok := doc.Get("a.b.c"); !ok || value != 7 {
		t.Fatalf("a.b.c = %v", value)
	}
}

func TestSetReplacesScalarWithMapping(t *testing.T) {
	path := writeFixture(t, "a: scalar\n")
	doc, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if err := doc.Set("a.b", "x"); err != nil {
		t.Fatal(err)
	}
	if value, ok := doc.Get("a.b"); !ok || value != "x" {
		t.Fatalf("a.b = %v", value)
	}
}

func TestSetListIndex(t *testing.T) {
	path := writeFixture(t, "providers:\n  - name: one\n  - name: two\n")
	doc, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	if err := doc.Set("providers.1.name", "TWO"); err != nil {
		t.Fatal(err)
	}
	if value, ok := doc.Get("providers.1.name"); !ok || value != "TWO" {
		t.Fatalf("providers.1.name = %v", value)
	}

	// Lists are not grown; an out-of-range index is an error.
	if err := doc.Set("providers.5.name", "nope"); err == nil {
		t.Fatal("expected an out-of-range error")
	}
}

func TestUnsetRemovesKeyAndKeepsComments(t *testing.T) {
	path := writeFixture(t, annotatedConfig)
	doc, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}

	removed, err := doc.Unset("model.provider")
	if err != nil || !removed {
		t.Fatalf("removed=%v err=%v", removed, err)
	}
	if _, ok := doc.Get("model.provider"); ok {
		t.Fatal("model.provider still present")
	}
	if err := doc.Save(); err != nil {
		t.Fatal(err)
	}

	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "# top comment") || !strings.Contains(string(raw), "# display section") {
		t.Fatalf("comments lost:\n%s", raw)
	}

	if removed, _ := doc.Unset("does.not.exist"); removed {
		t.Fatal("unset of a missing key reported removal")
	}
}

func TestSavePreservesMode(t *testing.T) {
	path := writeFixture(t, "model:\n  default: x\n")
	if err := os.Chmod(path, 0o640); err != nil {
		t.Fatal(err)
	}

	doc, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := doc.Set("model.default", "y"); err != nil {
		t.Fatal(err)
	}
	if err := doc.Save(); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %o, want 640", info.Mode().Perm())
	}
}

func TestManagedConfigKeys(t *testing.T) {
	dir := t.TempDir()
	content := "model:\n  default: managed/model\ntenant: acme\nproviders:\n  - a\n"
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}

	keys := ManagedConfigKeys(dir)
	for _, key := range []string{"model.default", "tenant", "providers"} {
		if !keys[key] {
			t.Fatalf("%q not pinned: %v", key, keys)
		}
	}
	if keys["model"] {
		t.Fatal("non-leaf key should not be pinned")
	}
}
