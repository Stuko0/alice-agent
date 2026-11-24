package host

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func logResolver(t *testing.T) (Resolver, string) {
	t.Helper()
	home := t.TempDir()
	return Resolver{
		GOOS:         "linux",
		HomeDir:      home,
		AliceHomeEnv: home,
		Stat:         os.Stat,
		ReadFile:     os.ReadFile,
	}, home
}

func TestHostLogsTailsLastLines(t *testing.T) {
	resolver, home := logResolver(t)
	logDir := filepath.Join(home, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatal(err)
	}

	var content strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&content, "line %03d\n", i)
	}
	if err := os.WriteFile(filepath.Join(logDir, "agent.log"), []byte(content.String()), 0o600); err != nil {
		t.Fatal(err)
	}

	var out, errb bytes.Buffer
	code := hostLogs(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"-n", "3"})
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errb.String())
	}

	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("lines = %v", lines)
	}
	if lines[0] != "line 097" || lines[2] != "line 099" {
		t.Fatalf("lines = %v", lines)
	}
}

func TestHostLogsNamedLog(t *testing.T) {
	resolver, home := logResolver(t)
	logDir := filepath.Join(home, "logs")
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(logDir, "gateway.log"), []byte("boot\nready\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var out, errb bytes.Buffer
	if code := hostLogs(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"gateway"}); code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errb.String())
	}
	if out.String() != "boot\nready\n" {
		t.Fatalf("out = %q", out.String())
	}
}

func TestHostLogsUnknownName(t *testing.T) {
	resolver, _ := logResolver(t)
	var out, errb bytes.Buffer
	if code := hostLogs(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"nope"}); code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if !strings.Contains(errb.String(), "unknown log") {
		t.Fatalf("stderr = %q", errb.String())
	}
}

func TestHostLogsMissingFile(t *testing.T) {
	resolver, _ := logResolver(t)
	var out, errb bytes.Buffer
	if code := hostLogs(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, nil); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
}

func TestHostLogsRejectsBadLineCount(t *testing.T) {
	resolver, _ := logResolver(t)
	var out, errb bytes.Buffer
	if code := hostLogs(Options{Stdout: &out, Stderr: &errb, Resolver: resolver}, []string{"-n", "zero"}); code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
}
