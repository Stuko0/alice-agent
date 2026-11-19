package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestShellQuote(t *testing.T) {
	cases := map[string]string{
		"simple":      "'simple'",
		"has space":   "'has space'",
		"it's":        `'it'\''s'`,
		"a'b'c":       `'a'\''b'\''c'`,
		`/tmp/x.sh`:   `'/tmp/x.sh'`,
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

func TestCheckInstallerModeReadsRelease(t *testing.T) {
	// Installer-managed installs have no .git: updates come from the release
	// assets, not from git. The API root is swappable so this stays offline.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"tag_name": "v0.24.0",
			"assets": [
				{"name": "alice-desktop-amd64-installer.exe", "browser_download_url": "https://example.test/i.exe"},
				{"name": "alice-desktop-amd64-installer.exe.sha256", "browser_download_url": "https://example.test/i.exe.sha256"}
			]
		}`))
	}))
	defer server.Close()

	previous := desktopReleaseAPI
	desktopReleaseAPI = server.URL
	defer func() { desktopReleaseAPI = previous }()

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alice_cli"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "alice_cli", "__init__.py"), []byte("__version__ = \"0.23.4\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	us := &UpdateService{projectRoot: root}
	st := us.Check()

	if !st.Supported || st.Mode != "installer" {
		t.Fatalf("expected installer mode supported, got %+v", st)
	}
	if !st.UpdateAvailable || st.LatestVersion != "v0.24.0" || st.CurrentVersion != "0.23.4" {
		t.Fatalf("unexpected update state: %+v", st)
	}
	if st.InstallerURL == "" || st.Behind != 1 {
		t.Fatalf("installer url/behind missing: %+v", st)
	}
}

func TestCheckInstallerModeWithoutAssetIsUnsupported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name": "v0.24.0", "assets": []}`))
	}))
	defer server.Close()

	previous := desktopReleaseAPI
	desktopReleaseAPI = server.URL
	defer func() { desktopReleaseAPI = previous }()

	us := &UpdateService{projectRoot: t.TempDir()}
	st := us.Check()

	if st.Supported || st.Reason != "no-installer-asset" {
		t.Fatalf("expected no-installer-asset, got %+v", st)
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
