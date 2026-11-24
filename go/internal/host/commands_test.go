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
