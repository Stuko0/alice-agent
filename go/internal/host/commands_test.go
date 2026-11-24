package host

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/Stuko0/alice-agent/go/internal/config"
)

func TestHostHelpListsEveryCommand(t *testing.T) {
	var out bytes.Buffer
	printHostHelp(&out)

	for _, c := range hostSubcommands {
		if !strings.Contains(out.String(), "alice host "+c.name) {
			t.Fatalf("help is missing %q:\n%s", c.name, out.String())
		}
	}
}

func TestDispatchHostUnknown(t *testing.T) {
	var out, errb bytes.Buffer
	code := dispatchHost(Options{Stdout: &out, Stderr: &errb}, []string{"nope"})
	if code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if !strings.Contains(errb.String(), "unknown subcommand") {
		t.Fatalf("stderr = %q", errb.String())
	}
}

func TestMainRoutesProfileToHostCommand(t *testing.T) {
	home := t.TempDir()
	profileDir := filepath.Join(home, ".alice", "profiles", "work")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		t.Fatal(err)
	}

	resolver := Resolver{
		GOOS:     "linux",
		HomeDir:  home,
		Stat:     os.Stat,
		ReadFile: os.ReadFile,
	}

	var out, errb bytes.Buffer
	code := Main(Options{
		Args:     []string{"-p", "work", "host", "env"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: resolver,
		Runner:   &fakeRunner{},
	})
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errb.String())
	}

	var report envReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, out.String())
	}
	if report.AliceHome != profileDir {
		t.Fatalf("alice_home = %q, want %q", report.AliceHome, profileDir)
	}
	if report.AliceHomeSource != "profile:work" {
		t.Fatalf("source = %q", report.AliceHomeSource)
	}
}

func TestMainRejectsMissingProfile(t *testing.T) {
	resolver := Resolver{GOOS: "linux", HomeDir: t.TempDir(), Stat: os.Stat}

	var out, errb bytes.Buffer
	code := Main(Options{
		Args:     []string{"-p", "nope", "host", "env"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: resolver,
		Runner:   &fakeRunner{},
	})
	if code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if !strings.Contains(errb.String(), "does not exist") {
		t.Fatalf("stderr = %q", errb.String())
	}
	if out.Len() != 0 {
		t.Fatalf("stdout = %q", out.String())
	}
}

func TestMainDelegatesProfiledNonHostCommand(t *testing.T) {
	fr := &fakeRunner{}
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:     []string{"-p", "work", "gateway", "status"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: testResolver(),
		Runner:   fr,
	})
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}

	want := []string{"/py/python", "-m", "alice_cli.main", "-p", "work", "gateway", "status"}
	if strings.Join(fr.argv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %v, want %v", fr.argv, want)
	}
}

func TestMainDelegatesUnknownLeadingFlag(t *testing.T) {
	fr := &fakeRunner{}
	var out, errb bytes.Buffer

	Main(Options{
		Args:     []string{"--frobnicate", "host", "env"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: testResolver(),
		Runner:   fr,
	})

	want := []string{"/py/python", "-m", "alice_cli.main", "--frobnicate", "host", "env"}
	if strings.Join(fr.argv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %v, want %v", fr.argv, want)
	}
}

func TestConfigNativePaths(t *testing.T) {
	home := t.TempDir()
	resolver := Resolver{GOOS: "linux", HomeDir: home, AliceHomeEnv: home}

	for _, tc := range []struct {
		arg  string
		want string
	}{
		{"path", filepath.Join(home, "config.yaml")},
		{"env-path", filepath.Join(home, ".env")},
	} {
		var out, errb bytes.Buffer
		opts := Options{Stdout: &out, Stderr: &errb, Resolver: resolver}
		handled, code := runConfigNative(opts, []string{tc.arg})
		if !handled || code != 0 {
			t.Fatalf("%s: handled=%v code=%d", tc.arg, handled, code)
		}
		if strings.TrimSpace(out.String()) != tc.want {
			t.Fatalf("%s: got %q, want %q", tc.arg, out.String(), tc.want)
		}
	}

	var out, errb bytes.Buffer
	handled, _ := runConfigNative(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"show"})
	if handled {
		t.Fatal("config show must stay delegated")
	}
}

func TestMainRoutesConfigPath(t *testing.T) {
	home := t.TempDir()
	resolver := Resolver{GOOS: "linux", HomeDir: home, AliceHomeEnv: home}

	var out, errb bytes.Buffer
	code := Main(Options{
		Args:     []string{"config", "path"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: resolver,
		Runner:   &fakeRunner{},
	})
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if strings.TrimSpace(out.String()) != filepath.Join(home, "config.yaml") {
		t.Fatalf("out = %q", out.String())
	}
}

func TestConfigSetGetUnsetNative(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("# keep me\nmodel:\n  provider: openrouter\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ALICE_MANAGED_DIR", filepath.Join(t.TempDir(), "absent"))

	resolver := Resolver{GOOS: "linux", HomeDir: home, AliceHomeEnv: home, Stat: os.Stat}

	set := func(args ...string) int {
		var out, errb bytes.Buffer
		opts := Options{Stdout: &out, Stderr: &errb, Resolver: resolver}
		handled, code := runConfigNative(opts, args)
		if !handled {
			t.Fatalf("%v was delegated", args)
		}
		if code != 0 {
			t.Fatalf("%v: code=%d stderr=%s", args, code, errb.String())
		}
		return code
	}

	set("set", "model.default", "test/model")
	set("set", "agent.max_turns", "42")
	set("set", "display.mouse", "true")

	var out, errb bytes.Buffer
	if handled, code := runConfigNative(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"get", "agent.max_turns"}); !handled || code != 0 {
		t.Fatalf("get handled=%v code=%d", handled, code)
	}
	if strings.TrimSpace(out.String()) != "42" {
		t.Fatalf("get = %q", out.String())
	}

	set("unset", "display.mouse")

	raw, _ := os.ReadFile(filepath.Join(home, "config.yaml"))
	text := string(raw)
	if !strings.Contains(text, "# keep me") {
		t.Fatalf("comment lost:\n%s", text)
	}
	if strings.Contains(text, "mouse") {
		t.Fatalf("display.mouse not removed:\n%s", text)
	}
	if !strings.Contains(text, "test/model") || !strings.Contains(text, "max_turns: 42") {
		t.Fatalf("values missing:\n%s", text)
	}
}

func TestConfigSetDelegatesCredentialsAndTerminal(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ALICE_MANAGED_DIR", filepath.Join(t.TempDir(), "absent"))
	resolver := Resolver{GOOS: "linux", HomeDir: home, AliceHomeEnv: home, Stat: os.Stat}

	for _, key := range []string{"OPENROUTER_API_KEY", "SOME_TOKEN", "terminal.cwd"} {
		var out, errb bytes.Buffer
		handled, _ := runConfigNative(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"set", key, "x"})
		if handled {
			t.Fatalf("%s must be delegated to Python", key)
		}
	}
}

func TestConfigSetRefusesManagedKey(t *testing.T) {
	home := t.TempDir()
	managed := t.TempDir()
	if err := os.WriteFile(filepath.Join(managed, "config.yaml"), []byte("model:\n  default: locked/model\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ALICE_MANAGED_DIR", managed)

	resolver := Resolver{GOOS: "linux", HomeDir: home, AliceHomeEnv: home, Stat: os.Stat}
	var out, errb bytes.Buffer
	handled, code := runConfigNative(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"set", "model.default", "mine/model"})
	if !handled || code != 1 {
		t.Fatalf("handled=%v code=%d", handled, code)
	}
	if !strings.Contains(errb.String(), "managed by your administrator") {
		t.Fatalf("stderr = %q", errb.String())
	}
}

func TestConfigSetNormalizesAPIAlias(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ALICE_MANAGED_DIR", filepath.Join(t.TempDir(), "absent"))
	resolver := Resolver{GOOS: "linux", HomeDir: home, AliceHomeEnv: home, Stat: os.Stat}

	var out, errb bytes.Buffer
	if handled, code := runConfigNative(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"set", "model.api_base", "https://x"}); !handled || code != 0 {
		t.Fatalf("handled=%v code=%d", handled, code)
	}
	raw, _ := os.ReadFile(filepath.Join(home, "config.yaml"))
	if !strings.Contains(string(raw), "base_url: https://x") {
		t.Fatalf("config = %s", raw)
	}
}

func TestConfigCheckNative(t *testing.T) {
	home := t.TempDir()
	latest, err := config.LatestVersion()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("_config_version: "+itoa(latest)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".env"), []byte("OPENROUTER_API_KEY=sk-test\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	optional, _ := config.OptionalEnv()
	missingName := ""
	for _, variable := range optional {
		// OPENROUTER_API_KEY is set in the fixture .env.
		if variable.Name == "OPENROUTER_API_KEY" {
			continue
		}
		if _, ok := os.LookupEnv(variable.Name); !ok {
			missingName = variable.Name
			break
		}
	}

	resolver := Resolver{GOOS: "linux", HomeDir: home, AliceHomeEnv: home, Stat: os.Stat}
	var out, errb bytes.Buffer
	handled, code := runConfigNative(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"check"})
	if !handled || code != 0 {
		t.Fatalf("handled=%v code=%d stderr=%s", handled, code, errb.String())
	}

	text := out.String()
	if !strings.Contains(text, "Configuration Status") || !strings.Contains(text, "Config version: "+itoa(latest)+" ✓") {
		t.Fatalf("output = %s", text)
	}
	if !strings.Contains(text, "✓ OPENROUTER_API_KEY") {
		t.Fatalf("configured key not reported:\n%s", text)
	}
	if missingName != "" && !strings.Contains(text, "○ "+missingName) {
		t.Fatalf("missing key %q not reported:\n%s", missingName, text)
	}
}

func TestConfigDumpMergesAndMasks(t *testing.T) {
	home := t.TempDir()
	fixture := "model:\n  api_key: sk-1234567890\n  default: mine\n"
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	resolver := Resolver{GOOS: "linux", HomeDir: home, AliceHomeEnv: home, Stat: os.Stat}

	var out, errb bytes.Buffer
	if handled, code := runConfigNative(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"dump"}); !handled || code != 0 {
		t.Fatalf("handled=%v code=%d stderr=%s", handled, code, errb.String())
	}

	text := out.String()
	if !strings.Contains(text, "max_turns: 90") {
		t.Fatalf("defaults not merged:\n%s", text)
	}
	if strings.Contains(text, "sk-1234567890") {
		t.Fatalf("secret leaked:\n%s", text)
	}
	if !strings.Contains(text, "api_key: sk-1...7890") {
		t.Fatalf("secret not masked as expected:\n%s", text)
	}
}

func TestConfigMigrateFastPath(t *testing.T) {
	home := t.TempDir()
	latest, _ := config.LatestVersion()
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("_config_version: "+itoa(latest)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ALICE_MANAGED_DIR", filepath.Join(t.TempDir(), "absent"))
	resolver := Resolver{GOOS: "linux", HomeDir: home, AliceHomeEnv: home, Stat: os.Stat}

	var out, errb bytes.Buffer
	handled, code := runConfigNative(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"migrate"})
	if !handled || code != 0 {
		t.Fatalf("handled=%v code=%d", handled, code)
	}
	if !strings.Contains(out.String(), "up to date") {
		t.Fatalf("output = %q", out.String())
	}

	// An old schema is migrated natively now.
	if err := os.WriteFile(filepath.Join(home, "config.yaml"), []byte("_config_version: 1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var out2, errb2 bytes.Buffer
	if handled, code := runConfigNative(Options{Stdout: &out2, Stderr: &errb2, Resolver: resolver}, []string{"migrate"}); !handled || code != 0 {
		t.Fatalf("old schema: handled=%v code=%d stderr=%s", handled, code, errb2.String())
	}
	if !strings.Contains(out2.String(), "Config version: 1 → 32") {
		t.Fatalf("output = %q", out2.String())
	}
}

func itoa(n int) string { return strconv.Itoa(n) }
