package host

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
