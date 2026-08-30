package main

import (
	"bytes"
	"fmt"
	"os/exec"
	"strings"
)

type GitService struct{}

func NewGitService() *GitService {
	return &GitService{}
}

func (g *GitService) GetGitRoot(dirPath string) (string, error) {
	cmd := exec.Command("git", "rev-parse", "--show-toplevel")
	cmd.Dir = dirPath
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("not a git repository: %w", err)
	}
	return strings.TrimSpace(out.String()), nil
}

func (g *GitService) GetCurrentBranch(dirPath string) (string, error) {
	cmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
	cmd.Dir = dirPath
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("failed to get branch: %w", err)
	}
	return strings.TrimSpace(out.String()), nil
}

func (g *GitService) ListWorktrees(dirPath string) ([]string, error) {
	cmd := exec.Command("git", "worktree", "list", "--porcelain")
	cmd.Dir = dirPath
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("failed to list worktrees: %w", err)
	}
	var worktrees []string
	for _, line := range strings.Split(out.String(), "\n") {
		if strings.HasPrefix(line, "worktree ") {
			worktrees = append(worktrees, strings.TrimSpace(strings.TrimPrefix(line, "worktree ")))
		}
	}
	return worktrees, nil
}

func (g *GitService) ListBranches(dirPath string) ([]string, error) {
	cmd := exec.Command("git", "branch", "--format=%(refname:short)")
	cmd.Dir = dirPath
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("failed to list branches: %w", err)
	}
	var branches []string
	for _, line := range strings.Split(out.String(), "\n") {
		if b := strings.TrimSpace(line); b != "" {
			branches = append(branches, b)
		}
	}
	return branches, nil
}

func (g *GitService) SwitchBranch(dirPath string, branch string) error {
	cmd := exec.Command("git", "switch", branch)
	cmd.Dir = dirPath
	return cmd.Run()
}

func (g *GitService) AddWorktree(dirPath string, worktreePath string, branch string) error {
	args := []string{"worktree", "add", worktreePath}
	if branch != "" {
		args = append(args, "-b", branch)
	}
	cmd := exec.Command("git", args...)
	cmd.Dir = dirPath
	return cmd.Run()
}

func (g *GitService) RemoveWorktree(dirPath string, worktreePath string, force bool) error {
	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, worktreePath)
	cmd := exec.Command("git", args...)
	cmd.Dir = dirPath
	return cmd.Run()
}

func (g *GitService) GetRemoteURL(dirPath string) (string, error) {
	cmd := exec.Command("git", "remote", "get-url", "origin")
	cmd.Dir = dirPath
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("failed to get remote URL: %w", err)
	}
	return strings.TrimSpace(out.String()), nil
}

func (g *GitService) GetStatus(dirPath string) (string, error) {
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = dirPath
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("failed to get status: %w", err)
	}
	return out.String(), nil
}

func (g *GitService) GetFileDiff(dirPath string, filePath string) (string, error) {
	cmd := exec.Command("git", "diff", "--", filePath)
	cmd.Dir = dirPath
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("failed to get diff: %w", err)
	}
	return out.String(), nil
}

func (g *GitService) StageFile(dirPath string, filePath string) error {
	cmd := exec.Command("git", "add", "--", filePath)
	cmd.Dir = dirPath
	return cmd.Run()
}

func (g *GitService) UnstageFile(dirPath string, filePath string) error {
	cmd := exec.Command("git", "reset", "HEAD", "--", filePath)
	cmd.Dir = dirPath
	return cmd.Run()
}

func (g *GitService) RevertFile(dirPath string, filePath string) error {
	cmd := exec.Command("git", "checkout", "--", filePath)
	cmd.Dir = dirPath
	return cmd.Run()
}

func (g *GitService) Commit(dirPath string, message string) error {
	cmd := exec.Command("git", "commit", "-m", message)
	cmd.Dir = dirPath
	return cmd.Run()
}

func (g *GitService) Push(dirPath string) error {
	cmd := exec.Command("git", "push")
	cmd.Dir = dirPath
	return cmd.Run()
}

func (g *GitService) GetRecentCommits(dirPath string, count int) ([]string, error) {
	if count <= 0 {
		count = 10
	}
	cmd := exec.Command("git", "log", fmt.Sprintf("-%d", count), "--oneline")
	cmd.Dir = dirPath
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("failed to get recent commits: %w", err)
	}
	var commits []string
	for _, line := range strings.Split(out.String(), "\n") {
		if c := strings.TrimSpace(line); c != "" {
			commits = append(commits, c)
		}
	}
	return commits, nil
}

func (g *GitService) RevParse(dirPath string, ref string) (string, error) {
	if ref == "" {
		ref = "HEAD"
	}
	cmd := exec.Command("git", "rev-parse", ref)
	cmd.Dir = dirPath
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("failed to rev-parse: %w", err)
	}
	return strings.TrimSpace(out.String()), nil
}

