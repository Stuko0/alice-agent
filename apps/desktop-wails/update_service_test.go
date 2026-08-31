package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"simple":     "'simple'",
		"has space":  "'has space'",
		"it's":       `'it'\''s'`,
		"a'b'c":      `'a'\''b'\''c'`,
		`/tmp/x.sh`:  `'/tmp/x.sh'`,
		"under_score": "'under_score'",
	}
	for in, want := range cases {
		if got := shellQuote(in); got != want {
			t.Errorf("shellQuote(%q) = %s, want %s", in, got, want)
		}
	}
}

func TestVenvBinOnPathIncludesVenvBin(t *testing.T) {
	// The Windows layout (venv/Scripts) is compile-verified via GOOS=windows;
	// this asserts the shared invariant: the venv bin dir is prepended.
	got := venvBinOnPath("/root")
	if !strings.Contains(got, filepath.Join("root", "venv", "bin")) {
		t.Errorf("venv bin missing from PATH: %s", got)
	}
	if !strings.Contains(got, string(os.PathListSeparator)) {
		t.Errorf("expected PATH separator preserved: %s", got)
	}
}

func TestResolveAliceCliBinaryPrefersVenv(t *testing.T) {
	root := t.TempDir()
	bin := filepath.Join(root, "venv", "bin", "alice")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := resolveAliceCliBinary(root); got != bin {
		t.Errorf("resolveAliceCliBinary = %s, want %s", got, bin)
	}
}

func TestCheckNotAGitCheckout(t *testing.T) {
	us := &UpdateService{projectRoot: t.TempDir()}
	st := us.Check()
	if st.Supported {
		t.Errorf("expected supported=false for non-git dir, got %+v", st)
	}
	if st.Reason != "not-a-git-checkout" {
		t.Errorf("expected reason not-a-git-checkout, got %q", st.Reason)
	}
}

// gitRunner runs git commands inside a scratch repo.
func gitRunner(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=t@t",
		"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func initGitRepo(t *testing.T, dir string) string {
	t.Helper()
	gitRunner(t, dir, "init", "-q", "-b", "main")
	gitRunner(t, dir, "config", "user.name", "test")
	gitRunner(t, dir, "config", "user.email", "t@t")
	return dir
}

func TestCheckUpToDate(t *testing.T) {
	root := initGitRepo(t, t.TempDir())
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunner(t, root, "add", ".")
	gitRunner(t, root, "commit", "-q", "-m", "init")
	head := gitRunner(t, root, "rev-parse", "HEAD")

	us := &UpdateService{projectRoot: root}
	st := us.Check()
	if !st.Supported {
		t.Fatalf("expected supported=true, got %+v", st)
	}
	if st.CurrentSHA != head {
		t.Errorf("currentSha = %s, want %s", st.CurrentSHA, head)
	}
	if st.UpdateAvailable {
		t.Errorf("expected no update available on fresh repo, got %+v", st)
	}
	if st.Behind != 0 {
		t.Errorf("expected behind=0, got %d", st.Behind)
	}
}

func TestCheckBehindRemote(t *testing.T) {
	// Remote repo with one commit; clone; advance remote; Check must see it.
	remote := initGitRepo(t, t.TempDir())
	if err := os.WriteFile(filepath.Join(remote, "b.txt"), []byte("r1"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunner(t, remote, "add", ".")
	gitRunner(t, remote, "commit", "-q", "-m", "r1")

	local := t.TempDir()
	gitRunner(t, local, "clone", "-q", remote, filepath.Join(local, "work"))
	work := filepath.Join(local, "work")
	gitRunner(t, work, "remote", "set-url", "origin", remote)

	// Advance the remote.
	if err := os.WriteFile(filepath.Join(remote, "b.txt"), []byte("r2"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunner(t, remote, "add", ".")
	gitRunner(t, remote, "commit", "-q", "-m", "r2")

	us := &UpdateService{projectRoot: work}
	st := us.Check()
	if !st.Supported {
		t.Fatalf("expected supported=true, got %+v", st)
	}
	if !st.UpdateAvailable {
		t.Errorf("expected updateAvailable=true after remote advanced, got %+v", st)
	}
	if st.Behind != 1 {
		t.Errorf("expected behind=1, got %d", st.Behind)
	}
	if st.TargetSHA == "" || st.TargetSHA == st.CurrentSHA {
		t.Errorf("expected distinct targetSha, current=%s target=%s", st.CurrentSHA, st.TargetSHA)
	}
}
