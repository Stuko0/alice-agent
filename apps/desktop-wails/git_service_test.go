package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// makeGitRepo creates a throwaway git repository with one commit on "main".
func makeGitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=test", "GIT_COMMITTER_EMAIL=test@example.com",
			"GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "file.txt")
	run("commit", "-q", "-m", "initial commit")
	return dir
}

func TestGitGetRootAndBranch(t *testing.T) {
	dir := makeGitRepo(t)
	g := NewGitService()
	root, err := g.GetGitRoot(dir)
	if err != nil {
		t.Fatalf("GetGitRoot: %v", err)
	}
	if filepath.Clean(root) != filepath.Clean(dir) {
		t.Fatalf("root = %q, want %q", root, dir)
	}
	branch, err := g.GetCurrentBranch(dir)
	if err != nil {
		t.Fatalf("GetCurrentBranch: %v", err)
	}
	if branch != "main" {
		t.Fatalf("branch = %q, want main", branch)
	}
}

func TestGitNotARepo(t *testing.T) {
	g := NewGitService()
	if _, err := g.GetGitRoot(t.TempDir()); err == nil {
		t.Fatal("GetGitRoot on a non-repo should error")
	}
}

func TestGitBranchesAndSwitch(t *testing.T) {
	dir := makeGitRepo(t)
	g := NewGitService()
	if err := exec.Command("git", "-C", dir, "checkout", "-q", "-b", "feature").Run(); err != nil {
		t.Fatal(err)
	}
	branches, err := g.ListBranches(dir)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	branchSet := map[string]bool{}
	for _, b := range branches {
		branchSet[b] = true
	}
	if !branchSet["main"] || !branchSet["feature"] {
		t.Fatalf("branches = %v, want main + feature", branches)
	}
	if err := g.SwitchBranch(dir, "main"); err != nil {
		t.Fatalf("SwitchBranch: %v", err)
	}
	if b, _ := g.GetCurrentBranch(dir); b != "main" {
		t.Fatalf("after switch, branch = %q, want main", b)
	}
}

func TestGitStatusAndCommits(t *testing.T) {
	dir := makeGitRepo(t)
	g := NewGitService()
	// Dirty the worktree.
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	status, err := g.GetStatus(dir)
	if err != nil {
		t.Fatalf("GetStatus: %v", err)
	}
	if !strings.Contains(status, "file.txt") {
		t.Fatalf("status should mention file.txt, got %q", status)
	}
	commits, err := g.GetRecentCommits(dir, 5)
	if err != nil {
		t.Fatalf("GetRecentCommits: %v", err)
	}
	if len(commits) < 1 || !strings.Contains(commits[0], "initial") {
		t.Fatalf("commits = %v, want at least one matching 'initial'", commits)
	}
	sha, err := g.RevParse(dir, "HEAD")
	if err != nil {
		t.Fatalf("RevParse: %v", err)
	}
	if len(sha) != 40 {
		t.Fatalf("HEAD sha len = %d, want 40", len(sha))
	}
}

func TestGitRemoteURL(t *testing.T) {
	dir := makeGitRepo(t)
	if err := exec.Command("git", "-C", dir, "remote", "add", "origin", "https://example.com/x/y.git").Run(); err != nil {
		t.Fatal(err)
	}
	g := NewGitService()
	url, err := g.GetRemoteURL(dir)
	if err != nil {
		t.Fatalf("GetRemoteURL: %v", err)
	}
	if url != "https://example.com/x/y.git" {
		t.Fatalf("url = %q", url)
	}
	// No origin -> error.
	if _, err := g.GetRemoteURL(t.TempDir()); err == nil {
		t.Fatal("GetRemoteURL on repo without origin should error")
	}
}

func TestGitWorktrees(t *testing.T) {
	dir := makeGitRepo(t)
	g := NewGitService()
	wt := filepath.Join(dir, "..", "wt-"+strings.ReplaceAll(t.Name(), "/", "_"))
	wt = filepath.Clean(wt)
	defer func() { _ = g.RemoveWorktree(dir, wt, true) }()
	if err := g.AddWorktree(dir, wt, ""); err != nil {
		t.Skipf("worktree add unsupported here: %v", err)
	}
	wts, err := g.ListWorktrees(dir)
	if err != nil {
		t.Fatalf("ListWorktrees: %v", err)
	}
	found := false
	for _, w := range wts {
		if filepath.Clean(w) == wt {
			found = true
		}
	}
	if !found {
		t.Fatalf("worktree %q not listed in %v", wt, wts)
	}
}

func TestGitFileDiffAndRevert(t *testing.T) {
	dir := makeGitRepo(t)
	f := filepath.Join(dir, "file.txt")
	if err := os.WriteFile(f, []byte("modified\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	g := NewGitService()
	diff, err := g.GetFileDiff(dir, "file.txt")
	if err != nil {
		t.Fatalf("GetFileDiff: %v", err)
	}
	if !strings.Contains(diff, "-hello") || !strings.Contains(diff, "+modified") {
		t.Fatalf("diff = %q", diff)
	}
	if err := g.RevertFile(dir, "file.txt"); err != nil {
		t.Fatalf("RevertFile: %v", err)
	}
	data, _ := os.ReadFile(f)
	if strings.TrimSpace(string(data)) != "hello" {
		t.Fatalf("after revert file = %q, want hello", data)
	}
}