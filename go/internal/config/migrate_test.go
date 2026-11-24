package config

import (
	"os"
	"path/filepath"
	"testing"
)

func migrateFixture(t *testing.T, content string) (*Document, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	doc, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	return doc, path
}

func TestMigrate28WriteMode(t *testing.T) {
	doc, path := migrateFixture(t, `_config_version: 28
memory:
  write_mode: approve
skills:
  write_mode: off
agent:
  verify_on_stop: auto
`)

	result, handled, err := doc.MigrateToLatest(t.TempDir())
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if result.From != 28 || result.To != 32 {
		t.Fatalf("result = %+v", result)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reloaded.Get("memory.write_mode"); ok {
		t.Fatal("memory.write_mode not removed")
	}
	if value, ok := reloaded.Get("memory.write_approval"); !ok || value != true {
		t.Fatalf("memory.write_approval = %v (%v)", value, ok)
	}
	// "off" maps to false, which is the default → stripped, not written.
	if _, ok := reloaded.Get("skills.write_approval"); ok {
		t.Fatal("skills.write_approval should have been stripped as a default")
	}
	// "auto" → false; the default is "auto", so false persists.
	if value, ok := reloaded.Get("agent.verify_on_stop"); !ok || value != false {
		t.Fatalf("verify_on_stop = %v (%v)", value, ok)
	}
	if version := reloaded.RawVersion(); version != 32 {
		t.Fatalf("version = %d", version)
	}
}

func TestMigrate30FlipsTrue(t *testing.T) {
	doc, path := migrateFixture(t, `_config_version: 30
agent:
  verify_on_stop: true
`)

	if _, handled, err := doc.MigrateToLatest(t.TempDir()); err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}

	reloaded, _ := Load(path)
	if value, _ := reloaded.Get("agent.verify_on_stop"); value != false {
		t.Fatalf("verify_on_stop = %v", value)
	}
}

func TestMigrate31PreservesExplicitTrue(t *testing.T) {
	// At v31 a true is an explicit user choice and must be left alone until
	// the v32 flip? No: v32 flips any true persisted before it, so this test
	// pins that behavior.
	doc, path := migrateFixture(t, `_config_version: 31
agent:
  verify_on_stop: true
`)
	if _, handled, err := doc.MigrateToLatest(t.TempDir()); err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	reloaded, _ := Load(path)
	if value, _ := reloaded.Get("agent.verify_on_stop"); value != false {
		t.Fatalf("verify_on_stop = %v", value)
	}
}

func TestMigrate31FalseStaysFalse(t *testing.T) {
	doc, path := migrateFixture(t, `_config_version: 31
agent:
  verify_on_stop: false
`)
	if _, handled, err := doc.MigrateToLatest(t.TempDir()); err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	reloaded, _ := Load(path)
	if value, _ := reloaded.Get("agent.verify_on_stop"); value != false {
		t.Fatalf("verify_on_stop = %v", value)
	}
	if version := reloaded.RawVersion(); version != 32 {
		t.Fatalf("version = %d", version)
	}
}

func TestMigrateUpToDateIsNoop(t *testing.T) {
	doc, path := migrateFixture(t, `_config_version: 32
agent:
  verify_on_stop: false
`)
	before, _ := os.ReadFile(path)

	result, handled, err := doc.MigrateToLatest(t.TempDir())
	if err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if result.From != 32 || result.To != 32 {
		t.Fatalf("result = %+v", result)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatalf("up-to-date config was rewritten:\n%s", after)
	}
}

func TestMigrateV1RunsNatively(t *testing.T) {
	doc, path := migrateFixture(t, "_config_version: 1\n")
	home := t.TempDir()
	if _, handled, err := doc.MigrateToLatest(home); err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	reloaded, _ := Load(path)
	if reloaded.RawVersion() != 32 {
		t.Fatalf("version = %d", reloaded.RawVersion())
	}
	if value, ok := reloaded.Get("display.tool_progress"); !ok || value != "all" {
		t.Fatalf("tool_progress = %v (%v)", value, ok)
	}
}

func TestMigrate22CreatesCuratorLogs(t *testing.T) {
	doc, path := migrateFixture(t, "_config_version: 22\n")
	home := t.TempDir()

	if _, handled, err := doc.MigrateToLatest(home); err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	if info, err := os.Stat(filepath.Join(home, "logs", "curator")); err != nil || !info.IsDir() {
		t.Fatalf("logs/curator missing: %v", err)
	}

	// Curator defaults are stripped (Python adds them, then save_config
	// removes default-valued keys). The file only gains the version.
	reloaded, _ := Load(path)
	if _, ok := reloaded.Get("curator"); ok {
		t.Fatal("curator defaults should not be materialised")
	}
	if reloaded.RawVersion() != 32 {
		t.Fatalf("version = %d", reloaded.RawVersion())
	}
}

func TestMigrate24LowersTTL(t *testing.T) {
	doc, path := migrateFixture(t, `_config_version: 24
model_catalog:
  ttl_hours: 24
`)
	if _, handled, err := doc.MigrateToLatest(t.TempDir()); err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	reloaded, _ := Load(path)
	if value, _ := reloaded.Get("model_catalog.ttl_hours"); value != 1 {
		t.Fatalf("ttl_hours = %v", value)
	}
}

func TestMigrate24LeavesCustomTTL(t *testing.T) {
	doc, path := migrateFixture(t, `_config_version: 24
model_catalog:
  ttl_hours: 6
`)
	if _, handled, err := doc.MigrateToLatest(t.TempDir()); err != nil || !handled {
		t.Fatalf("handled=%v err=%v", handled, err)
	}
	reloaded, _ := Load(path)
	if value, _ := reloaded.Get("model_catalog.ttl_hours"); value != 6 {
		t.Fatalf("ttl_hours = %v", value)
	}
}
