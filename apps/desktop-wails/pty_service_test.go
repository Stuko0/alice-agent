//go:build !windows

package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// pollRead repeatedly drains the terminal buffer until it contains marker or
// the deadline passes. ReadTerminal drains per call, so we accumulate.
func pollRead(t *testing.T, pts *PTYService, id, marker string, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var acc strings.Builder
	for time.Now().Before(deadline) {
		if chunk := pts.ReadTerminal(id); chunk != "" {
			acc.WriteString(chunk)
			if strings.Contains(acc.String(), marker) {
				return acc.String()
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for marker %q; buffer so far: %q", marker, acc.String())
	return ""
}

func TestPTYStartWriteRead(t *testing.T) {
	t.Setenv("SHELL", "/bin/bash")
	pts := NewPTYService()
	cwd := t.TempDir()
	sess, err := pts.StartTerminal(cwd, 100, 40)
	if err != nil {
		t.Fatalf("StartTerminal: %v", err)
	}
	defer pts.DisposeTerminal(sess.ID)

	if sess.Cwd != cwd {
		t.Fatalf("session cwd = %q, want %q", sess.Cwd, cwd)
	}
	if sess.Cols != 100 || sess.Rows != 40 {
		t.Fatalf("window size not preserved: %+v", sess)
	}

	marker := "PTY_MARKER_1740"
	if err := pts.WriteTerminal(sess.ID, fmt.Sprintf("printf '%s\\n'\n", marker)); err != nil {
		t.Fatalf("WriteTerminal: %v", err)
	}
	out := pollRead(t, pts, sess.ID, marker, 5*time.Second)
	if !strings.Contains(out, marker) {
		t.Fatalf("did not echo marker back: %q", out)
	}
}

func TestPTYResize(t *testing.T) {
	t.Setenv("SHELL", "/bin/bash")
	pts := NewPTYService()
	sess, err := pts.StartTerminal(t.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("StartTerminal: %v", err)
	}
	defer pts.DisposeTerminal(sess.ID)
	if err := pts.ResizeTerminal(sess.ID, 120, 50); err != nil {
		t.Fatalf("ResizeTerminal: %v", err)
	}
	if sess.Cols != 120 || sess.Rows != 50 {
		t.Fatalf("after resize: %dx%d, want 120x50", sess.Cols, sess.Rows)
	}
}

func TestPTYUnknownSessionErrors(t *testing.T) {
	pts := NewPTYService()
	if err := pts.WriteTerminal("nope", "x"); err == nil {
		t.Fatal("WriteTerminal on unknown session should error")
	}
	if err := pts.ResizeTerminal("nope", 10, 10); err == nil {
		t.Fatal("ResizeTerminal on unknown session should error")
	}
	if got := pts.ReadTerminal("nope"); got != "" {
		t.Fatalf("ReadTerminal on unknown session = %q, want empty", got)
	}
	if err := pts.DisposeTerminal("nope"); err != nil {
		t.Fatalf("DisposeTerminal on unknown session should be a no-op, got %v", err)
	}
}

func TestPTYDisposeStopsSession(t *testing.T) {
	t.Setenv("SHELL", "/bin/bash")
	pts := NewPTYService()
	sess, err := pts.StartTerminal(t.TempDir(), 80, 24)
	if err != nil {
		t.Fatalf("StartTerminal: %v", err)
	}
	if err := pts.DisposeTerminal(sess.ID); err != nil {
		t.Fatalf("DisposeTerminal: %v", err)
	}
	// After dispose the session is gone and further IO errors out.
	if err := pts.WriteTerminal(sess.ID, "x"); err == nil {
		t.Fatal("WriteTerminal after dispose should error")
	}
	// No orphaned bash processes for this test.
}

func TestPTYReadEmptyForNoOutput(t *testing.T) {
	pts := NewPTYService()
	// A fresh read with nothing written returns empty rather than erroring.
	if got := pts.ReadTerminal("missing"); got != "" {
		t.Fatalf("want empty read for missing session, got %q", got)
	}
}