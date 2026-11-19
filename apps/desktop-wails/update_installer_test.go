package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.23.4", "v0.24.0", -1},
		{"v0.24.0", "0.23.4", 1},
		{"0.24.0", "v0.24.0", 0},
		{"0.24", "0.24.0", 0},
		{"1.0.0", "0.99.99", 1},
		{"garbage", "0.24.0", 0}, // unparseable never triggers a phantom update
		{"0.10.0", "0.9.0", 1},   // numeric, not lexicographic
	}

	for _, tc := range cases {
		if got := compareVersions(tc.a, tc.b); got != tc.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestInstallerAssetPicksInstallerAndChecksum(t *testing.T) {
	release := githubRelease{TagName: "v0.24.0"}
	release.Assets = []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	}{
		{Name: "alice-desktop.exe", BrowserDownloadURL: "https://example.test/alice-desktop.exe"},
		{Name: installerAssetName, BrowserDownloadURL: "https://example.test/installer.exe"},
		{Name: installerAssetName + ".sha256", BrowserDownloadURL: "https://example.test/installer.exe.sha256"},
	}

	installerURL, checksumURL, ok := installerAsset(release)

	if !ok || installerURL != "https://example.test/installer.exe" {
		t.Fatalf("installerAsset = %q, ok=%v", installerURL, ok)
	}

	if checksumURL != "https://example.test/installer.exe.sha256" {
		t.Fatalf("checksum url = %q", checksumURL)
	}

	// A release without the installer asset must not be offered as an update.
	_, _, ok = installerAsset(githubRelease{TagName: "v0.24.0"})

	if ok {
		t.Fatal("release without the installer asset must not report ok")
	}
}

func TestExpectedSHAFromChecksumAcceptsBothShapes(t *testing.T) {
	digest := strings.Repeat("ab", 32)

	if got := expectedSHAFromChecksum(digest + "  alice-desktop-amd64-installer.exe\n"); got != digest {
		t.Fatalf("sha256sum shape = %q", got)
	}

	if got := expectedSHAFromChecksum(digest + "\n"); got != digest {
		t.Fatalf("bare shape = %q", got)
	}

	if got := expectedSHAFromChecksum("not-a-digest"); got != "" {
		t.Fatalf("garbage = %q, want empty", got)
	}
}

func TestSHA256File(t *testing.T) {
	path := filepath.Join(t.TempDir(), "payload.exe")

	if err := os.WriteFile(path, []byte("alice"), 0o600); err != nil {
		t.Fatal(err)
	}

	sum := sha256.Sum256([]byte("alice"))

	got, err := sha256File(path)
	if err != nil {
		t.Fatal(err)
	}

	if want := hex.EncodeToString(sum[:]); got != want {
		t.Fatalf("sha256File = %q, want %q", got, want)
	}
}

func TestInstallerWatcherScriptRunsSilentlyThenRelaunches(t *testing.T) {
	script := installerWatcherScript(4242, `C:\Temp\alice-installer.exe`, `C:\Apps\Alice\alice-desktop.exe`)

	for _, want := range []string{
		"Get-Process -Id 4242",
		"Start-Sleep -Seconds 2", // let released file handles settle
		"'C:\\Temp\\alice-installer.exe'",
		"'/S'", // silent install: no wizard, no UAC for user scope
		"alice-desktop-update.log",
		"'C:\\Apps\\Alice\\alice-desktop.exe'",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("watcher script missing %q:\n%s", want, script)
		}
	}
}

func TestFetchLatestReleaseReadsAssets(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") == "" {
			t.Error("missing User-Agent (GitHub rejects requests without one)")
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"tag_name": "v0.24.0",
			"assets": [
				{"name": "alice-desktop-amd64-installer.exe", "browser_download_url": "https://example.test/i.exe", "size": 10},
				{"name": "alice-desktop-amd64-installer.exe.sha256", "browser_download_url": "https://example.test/i.exe.sha256", "size": 65}
			]
		}`))
	}))
	defer server.Close()

	// fetchLatestRelease hard-codes the GitHub URL; exercise the decoder path by
	// hitting the test server through a tiny shim instead.
	req, _ := http.NewRequest(http.MethodGet, server.URL, nil)
	req.Header.Set("User-Agent", "alice-desktop-updater")

	resp, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}

	defer resp.Body.Close()

	release, err := decodeRelease(resp.Body)
	if err != nil {
		t.Fatal(err)
	}

	if release.TagName != "v0.24.0" {
		t.Fatalf("tag = %q", release.TagName)
	}

	if url, _, ok := installerAsset(release); !ok || url != "https://example.test/i.exe" {
		t.Fatalf("asset pick = %q ok=%v", url, ok)
	}
}

func TestCurrentVersionReadsRuntimeTree(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alice_cli"), 0o755); err != nil {
		t.Fatal(err)
	}

	initPy := filepath.Join(root, "alice_cli", "__init__.py")
	if err := os.WriteFile(initPy, []byte("__version__ = \"1.2.3\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	us := &UpdateService{}

	if got := us.currentVersion(root); got != "1.2.3" {
		t.Fatalf("currentVersion = %q, want 1.2.3", got)
	}

	if got := us.currentVersion(t.TempDir()); got != "0.0.0" {
		t.Fatalf("currentVersion(empty) = %q, want 0.0.0", got)
	}
}

func TestInstallerRuntimeRootAbsentInTestBuild(t *testing.T) {
	// The test binary lives in a temp dir with no resources/alice beside it, so
	// resolution must degrade to "" (and ResolveProjectRoot keeps its other
	// strategies).
	if got := installerRuntimeRoot(); got != "" {
		t.Fatalf("installerRuntimeRoot = %q, want empty", got)
	}
}

func TestHasGitCheckout(t *testing.T) {
	dir := t.TempDir()

	if hasGitCheckout(dir) {
		t.Fatal("empty dir reported as a git checkout")
	}

	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	if !hasGitCheckout(dir) {
		t.Fatal(".git dir not detected")
	}

	if hasGitCheckout("") {
		t.Fatal("empty root must not be a checkout")
	}
}

// Real-I/O coverage for the installer download stage: a local server serves the
// payload + its .sha256 sidecar, exactly like the release assets the updater
// consumes.
func TestDownloadVerifiedInstallerAcceptsMatchingChecksum(t *testing.T) {
	payload := bytes.Repeat([]byte("alice-installer-payload\n"), 64*1024) // ~1.6 MB
	sum := sha256.Sum256(payload)

	mux := http.NewServeMux()
	mux.HandleFunc("/installer.exe", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)))
		_, _ = w.Write(payload)
	})
	mux.HandleFunc("/installer.exe.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(hex.EncodeToString(sum[:]) + "  alice-desktop-amd64-installer.exe\n"))
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "installer.exe")

	var progressCalls int

	err := downloadVerifiedInstaller(server.Client(), server.URL+"/installer.exe", server.URL+"/installer.exe.sha256", dest, func(done, total int64) {
		progressCalls++
	})
	if err != nil {
		t.Fatalf("downloadVerifiedInstaller: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(got, payload) {
		t.Fatalf("downloaded payload differs (%d vs %d bytes)", len(got), len(payload))
	}

	if progressCalls == 0 {
		t.Fatal("progress callback never fired")
	}
}

func TestDownloadVerifiedInstallerRefusesBadChecksum(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/installer.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("tampered"))
	})
	mux.HandleFunc("/installer.exe.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("00", 32)))
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "installer.exe")

	err := downloadVerifiedInstaller(server.Client(), server.URL+"/installer.exe", server.URL+"/installer.exe.sha256", dest, nil)
	if err == nil {
		t.Fatal("expected checksum mismatch")
	}

	if code := updateErrorCode(err); code != "checksum-mismatch" {
		t.Fatalf("error code = %q, want checksum-mismatch", code)
	}

	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Fatal("tampered installer must be deleted")
	}
}

func TestDownloadVerifiedInstallerWithoutSidecarSkipsVerification(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/installer.exe", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("unsigned"))
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	dest := filepath.Join(t.TempDir(), "installer.exe")

	if err := downloadVerifiedInstaller(server.Client(), server.URL+"/installer.exe", "", dest, nil); err != nil {
		t.Fatalf("download without sidecar failed: %v", err)
	}

	if _, err := os.Stat(dest); err != nil {
		t.Fatalf("installer not kept: %v", err)
	}
}

// End-to-end installer-mode apply: real HTTP download, real checksum check,
// watcher script written, hand-off invoked. Only the OS-level watcher run is
// stubbed (it targets Windows PowerShell).
func TestApplyInstallerUpdateEndToEnd(t *testing.T) {
	installerPayload := []byte("MZ fake installer payload")
	sum := sha256.Sum256(installerPayload)

	var server *httptest.Server

	mux := http.NewServeMux()
	mux.HandleFunc("/repos/"+desktopReleaseRepo+"/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"tag_name":"v9.9.9","assets":[
			{"name":"%s","browser_download_url":"%s/installer.exe"},
			{"name":"%s.sha256","browser_download_url":"%s/installer.exe.sha256"}]}`,
			installerAssetName, server.URL, installerAssetName, server.URL)
	})
	mux.HandleFunc("/installer.exe", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(installerPayload)))
		_, _ = w.Write(installerPayload)
	})
	mux.HandleFunc("/installer.exe.sha256", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(hex.EncodeToString(sum[:]) + "  " + installerAssetName + "\n"))
	})

	server = httptest.NewServer(mux)
	defer server.Close()

	prevAPI := desktopReleaseAPI
	desktopReleaseAPI = server.URL
	t.Cleanup(func() { desktopReleaseAPI = prevAPI })

	prevSpawn := spawnUpdateWatcher
	var spawnedScript string

	spawnUpdateWatcher = func(scriptPath string) error {
		spawnedScript = scriptPath

		return nil
	}
	t.Cleanup(func() { spawnUpdateWatcher = prevSpawn })

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alice_cli"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "alice_cli", "__init__.py"), []byte("__version__ = \"0.1.0\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	dest := filepath.Join(os.TempDir(), fmt.Sprintf("alice-desktop-%s-installer.exe", tagForFilename("v9.9.9")))
	_ = os.Remove(dest)
	t.Cleanup(func() {
		_ = os.Remove(dest)
		if spawnedScript != "" {
			_ = os.Remove(spawnedScript)
		}
	})

	us := &UpdateService{projectRoot: root}
	result := us.applyInstallerUpdate(root)

	if !result.OK || !result.HandedOff {
		t.Fatalf("applyInstallerUpdate = %+v, want ok+handedOff", result)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("installer not downloaded: %v", err)
	}

	if !bytes.Equal(got, installerPayload) {
		t.Fatal("downloaded installer differs from the served payload")
	}

	if spawnedScript == "" {
		t.Fatal("watcher was never spawned")
	}

	script, err := os.ReadFile(spawnedScript)
	if err != nil {
		t.Fatalf("watcher script missing: %v", err)
	}

	for _, want := range []string{"'/S'", shellQuote(dest), "Start-Process"} {
		if !strings.Contains(string(script), want) {
			t.Fatalf("watcher script missing %q:\n%s", want, script)
		}
	}
}

func TestApplyInstallerUpdateNoopWhenCurrent(t *testing.T) {
	releaseJSON := `{"tag_name":"v0.1.0","assets":[{"name":"alice-desktop-amd64-installer.exe","browser_download_url":"https://example.test/i.exe"}]}`

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(releaseJSON))
	}))
	defer server.Close()

	prevAPI := desktopReleaseAPI
	desktopReleaseAPI = server.URL
	t.Cleanup(func() { desktopReleaseAPI = prevAPI })

	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alice_cli"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "alice_cli", "__init__.py"), []byte("__version__ = \"0.1.0\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	us := &UpdateService{projectRoot: root}
	result := us.applyInstallerUpdate(root)

	if !result.OK || result.HandedOff {
		t.Fatalf("expected a no-op success, got %+v", result)
	}
}

func TestCurrentVersionPrefersStampedBuildVersion(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alice_cli"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A stale CLI checkout on the same machine (the Windows bug): this reads
	// 0.23.4 while the shell was built as 0.24.0.
	if err := os.WriteFile(filepath.Join(root, "alice_cli", "__init__.py"), []byte("__version__ = \"0.23.4\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	previous := buildVersion
	buildVersion = "v0.24.0"
	t.Cleanup(func() { buildVersion = previous })

	us := &UpdateService{}

	if got := us.currentVersion(root); got != "0.24.0" {
		t.Fatalf("currentVersion = %q, want the stamped 0.24.0 (not the stale checkout)", got)
	}

	buildVersion = ""

	if got := us.currentVersion(root); got != "0.23.4" {
		t.Fatalf("currentVersion without a stamp = %q, want 0.23.4 from the tree", got)
	}
}

func TestReinstallRefusesNonInstallerInstall(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	us := &UpdateService{projectRoot: root}
	result := us.Reinstall()

	if result.OK {
		t.Fatal("Reinstall on a source checkout should fail, not pretend to repair")
	}

	if result.Error != "repair-unavailable" {
		t.Fatalf("error = %q, want repair-unavailable", result.Error)
	}

	if !strings.Contains(result.Message, "source checkout") && !strings.Contains(result.Message, "Windows") {
		t.Fatalf("message should say why repair cannot run here, got %q", result.Message)
	}
}

func TestGetVersionReportsTheBuildStamp(t *testing.T) {
	previousVersion, previousCommit, previousTime := buildVersion, buildCommit, buildTime
	buildVersion, buildCommit, buildTime = "v0.24.0", "abc1234", "2026-11-19T06:54:34Z"
	t.Cleanup(func() {
		buildVersion, buildCommit, buildTime = previousVersion, previousCommit, previousTime
	})

	info := (&UpdateService{projectRoot: t.TempDir()}).GetVersion()

	if info.AppVersion != "0.24.0" {
		t.Fatalf("AppVersion = %q, want 0.24.0", info.AppVersion)
	}

	if info.BuildCommit != "abc1234" {
		t.Fatalf("BuildCommit = %q, want abc1234", info.BuildCommit)
	}

	if info.BuiltAt != "2026-11-19T06:54:34Z" {
		t.Fatalf("BuiltAt = %q, want the stamped timestamp", info.BuiltAt)
	}
}
