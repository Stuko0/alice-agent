package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLogGetLogsDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ALICE_HOME", home)
	ls := NewLogService()
	got := ls.GetLogsDir()
	if filepath.Clean(got) != filepath.Join(home, "logs") {
		t.Fatalf("GetLogsDir() = %q, want %q", got, filepath.Join(home, "logs"))
	}
}

func TestLogGetRecentLogs(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ALICE_HOME", home)
	ls := NewLogService()

	// Missing log file -> error.
	if _, err := ls.GetRecentLogs(10); err == nil {
		t.Fatal("GetRecentLogs on missing agent.log should error")
	}

	logsDir := filepath.Join(home, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for i := 1; i <= 5; i++ {
		lines = append(lines, "line "+string(rune('0'+i)))
	}
	lines = append(lines, "") // trailing empty line must be filtered
	if err := os.WriteFile(filepath.Join(logsDir, "agent.log"), []byte(strings.Join(lines, "\n")), 0o644); err != nil {
		t.Fatal(err)
	}

	// maxLines smaller than the file truncates to the tail.
	got, err := ls.GetRecentLogs(3)
	if err != nil {
		t.Fatalf("GetRecentLogs: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d lines, want 3", len(got))
	}
	if !strings.Contains(got[0], "line 3") {
		t.Fatalf("tail should start at line 3, got %q", got[0])
	}
	// Empty lines are dropped, so the trailing "" is not returned.
	for _, l := range got {
		if strings.TrimSpace(l) == "" {
			t.Fatalf("empty line leaked into result: %q", l)
		}
	}
}

func TestLogGetRecentLogsAll(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ALICE_HOME", home)
	ls := NewLogService()
	logsDir := filepath.Join(home, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "a\nb\nc\n"
	if err := os.WriteFile(filepath.Join(logsDir, "agent.log"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := ls.GetRecentLogs(100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d lines, want 3", len(got))
	}
}
func TestLogGetRecentLogsIncludesShellBootLog(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ALICE_HOME", home)
	logsDir := filepath.Join(home, "logs")
	if err := os.MkdirAll(logsDir, 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(logsDir, "agent.log"), []byte("agent line\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The shell writes this before the backend exists, so it is the only trace
	// of a boot that never reached Python.
	logBoot("boot: python=%q", "")
	logBoot("python runtime search failed (executable: C:\\Alice\\alice-desktop.exe)")

	got, err := NewLogService().GetRecentLogs(20)
	if err != nil {
		t.Fatalf("GetRecentLogs: %v", err)
	}

	if len(got) < 3 {
		t.Fatalf("got %d lines, want the agent line plus both boot lines: %q", len(got), got)
	}

	joined := strings.Join(got, "")
	for _, want := range []string{"agent line", "boot: python=", "runtime search failed"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %q", want, joined)
		}
	}

	// The boot decision must survive at the tail: the overlay renders the
	// last 40 lines of this list.
	if !strings.Contains(got[len(got)-1], "runtime search failed") {
		t.Fatalf("boot log should end the list, got %q", got[len(got)-1])
	}
}

func TestLogBootAppendsToProfileLog(t *testing.T) {
	home := t.TempDir()
	t.Setenv("ALICE_HOME", home)

	logBoot("first %d", 1)
	logBoot("second %s", "two")

	want := filepath.Join(home, "logs", bootLogName)
	if filepath.Clean(bootLogPath()) != want {
		t.Fatalf("bootLogPath() = %q, want %q", bootLogPath(), want)
	}

	data, err := os.ReadFile(want)
	if err != nil {
		t.Fatalf("reading boot log: %v", err)
	}

	if !strings.Contains(string(data), "first 1") || !strings.Contains(string(data), "second two") {
		t.Fatalf("boot log missing entries: %q", data)
	}
}
