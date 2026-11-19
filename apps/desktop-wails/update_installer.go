package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Installer-mode desktop updates.
//
// A source checkout updates with git (`alice update` + rebuild). An
// installer-managed install has no `.git`: it updates by downloading the next
// NSIS installer from the GitHub release, verifying its SHA-256, and handing
// off to a detached watcher that runs it silently (/S, per-user scope — no
// UAC) once this process exits, then relaunches the app.
const (
	// desktopReleaseRepo is the GitHub repository that publishes the Windows
	// installer assets.
	desktopReleaseRepo = "Stuko0/alice-agent"

	// installerAssetName is the NSIS installer produced by
	// `wails build -nsis` (build/windows/installer/project.nsi OutFile).
	installerAssetName = "alice-desktop-amd64-installer.exe"

	// installerUpdateMode is reported to the renderer so the About/Updates UI
	// can describe the flow accurately.
	installerUpdateMode = "installer"
)

// desktopReleaseAPI is the GitHub API root. A var (not a const) so tests can
// point it at a local server instead of hitting the network.
var desktopReleaseAPI = "https://api.github.com"

// spawnUpdateWatcher launches the detached installer watcher. A var so tests
// can run the whole apply pipeline (download → verify → hand-off) without
// actually spawning a process on the host.
var spawnUpdateWatcher = func(scriptPath string) error { return spawnDetached(scriptPath) }

// githubRelease is the subset of the GitHub Releases API we consume.
type githubRelease struct {
	TagName string `json:"tag_name"`
	Name    string `json:"name"`
	Body    string `json:"body"`
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	} `json:"assets"`
}

// versionPattern extracts a dotted version from a tag like `v0.24.0`.
var versionPattern = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// parseVersion turns "v0.24.1" / "0.24.1" / "0.24" into numeric parts.
// Missing components default to 0; pre-release/build metadata is ignored.
func parseVersion(raw string) (int, int, int, bool) {
	m := versionPattern.FindStringSubmatch(raw)
	if m == nil {
		return 0, 0, 0, false
	}

	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	patch, _ := strconv.Atoi(m[3])

	return major, minor, patch, true
}

// compareVersions returns -1/0/1 for a<b, a==b, a>b. Unparseable versions
// compare equal so a malformed tag never triggers a phantom update loop.
func compareVersions(a, b string) int {
	amaj, amin, apat, aok := parseVersion(a)
	bmaj, bmin, bpat, bok := parseVersion(b)

	if !aok || !bok {
		return 0
	}

	if amaj != bmaj {
		if amaj < bmaj {
			return -1
		}

		return 1
	}

	if amin != bmin {
		if amin < bmin {
			return -1
		}

		return 1
	}

	switch {
	case apat < bpat:
		return -1
	case apat > bpat:
		return 1
	default:
		return 0
	}
}

// installerAsset picks the installer + checksum URLs out of a release.
func installerAsset(release githubRelease) (installerURL, checksumURL string, ok bool) {
	for _, asset := range release.Assets {
		switch asset.Name {
		case installerAssetName:
			installerURL = asset.BrowserDownloadURL
		case installerAssetName + ".sha256":
			checksumURL = asset.BrowserDownloadURL
		}
	}

	return installerURL, checksumURL, installerURL != ""
}

// fetchLatestRelease queries the GitHub API. Unauthenticated (public repo);
// rate limits surface as a clear error the UI shows.
func fetchLatestRelease(client *http.Client) (githubRelease, error) {
	var release githubRelease

	req, err := http.NewRequest(http.MethodGet, desktopReleaseAPI+"/repos/"+desktopReleaseRepo+"/releases/latest", nil)
	if err != nil {
		return release, err
	}

	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "alice-desktop-updater")

	resp, err := client.Do(req)
	if err != nil {
		return release, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))

		return release, fmt.Errorf("release check failed: HTTP %d %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	decoded, err := decodeRelease(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return release, fmt.Errorf("release check failed: %w", err)
	}

	return decoded, nil
}

// decodeRelease parses the GitHub release payload (split out so tests can feed
// it a fixture without the network).
func decodeRelease(r io.Reader) (githubRelease, error) {
	var release githubRelease

	if err := json.NewDecoder(r).Decode(&release); err != nil {
		return release, err
	}

	return release, nil
}

// sha256File returns the lowercase hex digest of a file.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

// expectedSHAFromChecksum accepts the two common checksum file shapes:
// "<hash>  name" or a bare "<hash>".
func expectedSHAFromChecksum(raw string) string {
	fields := strings.Fields(strings.TrimSpace(raw))
	if len(fields) == 0 {
		return ""
	}

	candidate := strings.ToLower(fields[0])
	if len(candidate) != 64 {
		return ""
	}

	if _, err := hex.DecodeString(candidate); err != nil {
		return ""
	}

	return candidate
}

// downloadFile streams url into dest, reporting coarse progress.
func downloadFile(client *http.Client, url, dest string, onProgress func(done, total int64)) error {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}

	req.Header.Set("User-Agent", "alice-desktop-updater")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed: HTTP %d", resp.StatusCode)
	}

	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}

	out, err := os.Create(dest)
	if err != nil {
		return err
	}

	defer out.Close()

	total := resp.ContentLength

	buf := make([]byte, 256*1024)
	var done int64

	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := out.Write(buf[:n]); writeErr != nil {
				return writeErr
			}

			done += int64(n)

			if onProgress != nil {
				onProgress(done, total)
			}
		}

		if readErr == io.EOF {
			break
		}

		if readErr != nil {
			return readErr
		}
	}

	return out.Sync()
}

// installerWatcherScript is the detached PowerShell program that finishes the
// update outside this process: wait for us to exit, run the installer silently,
// relaunch. NSIS `/S` + user-scope install means no UAC prompt.
func installerWatcherScript(oldPID int, installerPath, exePath string) string {
	return fmt.Sprintf(`$ErrorActionPreference = "Continue"
$log = Join-Path $env:TEMP "alice-desktop-update.log"
# Give the old process (and the backend it kills on shutdown) a moment to
# release file handles before the installer overwrites resources\python.
Start-Sleep -Seconds 2
while (Get-Process -Id %d -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500 }
try {
  $p = Start-Process -FilePath %s -ArgumentList '/S' -PassThru -Wait
  "$(Get-Date -Format o) installer exit $($p.ExitCode)" | Out-File -FilePath $log -Append -Encoding utf8
} catch {
  "$(Get-Date -Format o) installer failed: $_" | Out-File -FilePath $log -Append -Encoding utf8
}
# Relaunch either way: the new version on success, the current one on failure
# (never leave the user with no app after an update attempt).
Start-Process -FilePath %s
`, oldPID, shellQuote(installerPath), shellQuote(exePath))
}

// writeInstallerWatcher writes the hand-off script into the temp dir.
func writeInstallerWatcher(oldPID int, installerPath, exePath string) (string, error) {
	script := installerWatcherScript(oldPID, installerPath, exePath)
	path := filepath.Join(os.TempDir(), fmt.Sprintf("alice-desktop-install-%d.ps1", time.Now().UnixNano()))

	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		return "", err
	}

	return path, nil
}

// ── Service integration ────────────────────────────────────────────────────

// checkInstallerUpdate reports whether a newer NSIS installer exists for this
// install. Passive apart from one GitHub API call.
func (us *UpdateService) checkInstallerUpdate(root string, status UpdateStatus) UpdateStatus {
	status.Mode = installerUpdateMode
	status.Supported = true
	status.Branch = "installer"
	status.CurrentVersion = us.currentVersion(root)
	status.Commits = []any{}

	client := &http.Client{Timeout: 20 * time.Second}

	release, err := fetchLatestRelease(client)
	if err != nil {
		status.Error = "release-check-failed"
		status.Message = err.Error()

		return status
	}

	installerURL, _, hasInstaller := installerAsset(release)

	status.LatestVersion = release.TagName
	status.TargetSHA = release.TagName
	status.InstallerURL = installerURL

	if !hasInstaller {
		status.Supported = false
		status.Reason = "no-installer-asset"
		status.Message = "The latest release has no Windows installer yet."

		return status
	}

	if compareVersions(status.CurrentVersion, release.TagName) < 0 {
		status.UpdateAvailable = true
		// The renderer's update toast keys off `behind`/`targetSha`; one step
		// behind is the honest representation for discrete releases.
		status.Behind = 1
		status.Message = fmt.Sprintf("v%s → %s", status.CurrentVersion, release.TagName)
	}

	return status
}

// applyInstallerUpdate downloads the next installer, verifies it and hands the
// swap to a detached watcher, then quits so the watcher can run it.
func (us *UpdateService) applyInstallerUpdate(root string) UpdateApplyResult {
	current := us.currentVersion(root)

	metaClient := &http.Client{Timeout: 20 * time.Second}

	release, err := fetchLatestRelease(metaClient)
	if err != nil {
		us.emitProgress("error", "Could not reach GitHub for the update.", nil)

		return UpdateApplyResult{OK: false, Error: "release-check-failed", Message: err.Error()}
	}

	if compareVersions(current, release.TagName) >= 0 {
		return UpdateApplyResult{OK: true, Message: fmt.Sprintf("Alice %s is already the latest version.", current)}
	}

	installerURL, checksumURL, ok := installerAsset(release)
	if !ok {
		us.emitProgress("error", "The latest release has no Windows installer.", nil)

		return UpdateApplyResult{OK: false, Error: "no-installer-asset", Message: "The latest release has no Windows installer."}
	}

	dest := filepath.Join(os.TempDir(), fmt.Sprintf("alice-desktop-%s-installer.exe", tagForFilename(release.TagName)))

	p5 := 5
	us.emitProgress("download", fmt.Sprintf("Downloading Alice %s…", release.TagName), &p5)

	downloadClient := &http.Client{Timeout: 30 * time.Minute}

	lastPercent := -1

	err = downloadVerifiedInstaller(downloadClient, installerURL, checksumURL, dest, func(done, total int64) {
		if total <= 0 {
			return
		}

		percent := 5 + int(float64(done)/float64(total)*85)
		if percent == lastPercent {
			return
		}

		lastPercent = percent
		us.emitProgress("download", fmt.Sprintf("Downloading Alice %s… %d%%", release.TagName, percent), &percent)
	})
	if err != nil {
		us.emitProgress("error", err.Error(), nil)

		return UpdateApplyResult{OK: false, Error: updateErrorCode(err), Message: err.Error()}
	}

	p90 := 90
	us.emitProgress("install", fmt.Sprintf("Installing Alice %s…", release.TagName), &p90)

	exe, err := os.Executable()
	if err != nil {
		return UpdateApplyResult{OK: false, Error: "relaunch-failed", Message: "Could not resolve the app executable."}
	}

	script, err := writeInstallerWatcher(os.Getpid(), dest, exe)
	if err != nil {
		return UpdateApplyResult{OK: false, Error: "relaunch-failed", Message: "Could not prepare the installer hand-off."}
	}

	if err := spawnUpdateWatcher(script); err != nil {
		return UpdateApplyResult{OK: false, Error: "relaunch-failed", Message: "Could not start the installer watcher."}
	}

	p100 := 100
	us.emitProgress("restart", "Restarting Alice with the new version…", &p100)
	us.quitSoon()

	return UpdateApplyResult{OK: true, HandedOff: true}
}

// fetchChecksum downloads a `.sha256` sidecar and normalizes it to a digest.
func fetchChecksum(client *http.Client, url string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}

	req.Header.Set("User-Agent", "alice-desktop-updater")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("checksum download failed: HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", err
	}

	digest := expectedSHAFromChecksum(string(body))
	if digest == "" {
		return "", fmt.Errorf("checksum file has no SHA-256 digest")
	}

	return digest, nil
}

// tagForFilename strips characters Windows rejects in file names.
func tagForFilename(tag string) string {
	cleaned := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			return r
		default:
			return '-'
		}
	}, tag)

	return strings.Trim(cleaned, "-")
}

// updateErrorCode maps a download/verify failure to the string the renderer
// shows (the overlay just displays the message, the code is for logs/tests).
type updateStageError struct {
	code string
	err  error
}

func (e *updateStageError) Error() string { return e.err.Error() }
func (e *updateStageError) Unwrap() error { return e.err }

func updateErrorCode(err error) string {
	var staged *updateStageError
	if errors.As(err, &staged) {
		return staged.code
	}

	return "download-failed"
}

// downloadVerifiedInstaller fetches the installer and, when the release
// publishes a checksum, refuses to keep a file whose digest doesn't match.
// Extracted from applyInstallerUpdate so the whole download/verify stage can be
// exercised against a real HTTP server.
func downloadVerifiedInstaller(client *http.Client, installerURL, checksumURL, dest string, onProgress func(done, total int64)) error {
	if err := downloadFile(client, installerURL, dest, onProgress); err != nil {
		_ = os.Remove(dest)

		return &updateStageError{code: "download-failed", err: err}
	}

	if checksumURL == "" {
		return nil
	}

	expected, err := fetchChecksum(client, checksumURL)
	if err != nil {
		_ = os.Remove(dest)

		return &updateStageError{code: "checksum-fetch-failed", err: err}
	}

	actual, err := sha256File(dest)
	if err != nil || !strings.EqualFold(expected, actual) {
		_ = os.Remove(dest)

		return &updateStageError{code: "checksum-mismatch", err: fmt.Errorf("installer checksum mismatch — refusing to install")}
	}

	return nil
}
