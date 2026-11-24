package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

type FSService struct {
	ctx context.Context
}

func NewFSService() *FSService {
	return &FSService{}
}

// SetContext stores the Wails app context so the bound methods can use the
// native runtime dialogs. Called from OnStartup.
func (fs *FSService) SetContext(ctx context.Context) {
	fs.ctx = ctx
}

func (fs *FSService) ReadDir(dirPath string) ([]map[string]interface{}, error) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory: %w", err)
	}

	var results []map[string]interface{}
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil {
			continue
		}
		results = append(results, map[string]interface{}{
			"name":    entry.Name(),
			"path":    filepath.Join(dirPath, entry.Name()),
			"isDir":   entry.IsDir(),
			"size":    info.Size(),
			"modTime": info.ModTime().Format("2006-01-02 15:04:05"),
		})
	}
	return results, nil
}

func (fs *FSService) ReadFileText(filePath string) (ReadTextResult, error) {
	return fs.readFileTextLimited(filePath, defaultPreviewTextLimit)
}

// ReadFileTextLimited reads at most maxBytes (0 → defaultPreviewTextLimit).
// The full size is always reported so the renderer can show the truncation
// banner without a second stat; reading a 50MB log must not allocate 50MB.
func (fs *FSService) ReadFileTextLimited(filePath string, maxBytes int64) (ReadTextResult, error) {
	return fs.readFileTextLimited(filePath, maxBytes)
}

func (fs *FSService) readFileTextLimited(filePath string, maxBytes int64) (ReadTextResult, error) {
	if maxBytes <= 0 {
		maxBytes = defaultPreviewTextLimit
	}

	info, err := os.Stat(filePath)
	if err != nil {
		return ReadTextResult{}, fmt.Errorf("failed to read file: %w", err)
	}
	if info.IsDir() {
		return ReadTextResult{}, fmt.Errorf("failed to read file: is a directory")
	}

	f, err := os.Open(filePath)
	if err != nil {
		return ReadTextResult{}, fmt.Errorf("failed to read file: %w", err)
	}
	defer f.Close()

	limited := io.LimitReader(f, maxBytes)
	data, err := io.ReadAll(limited)
	if err != nil {
		return ReadTextResult{}, fmt.Errorf("failed to read file: %w", err)
	}

	sniff := data
	if len(sniff) > binarySniffBytes {
		sniff = sniff[:binarySniffBytes]
	}

	return ReadTextResult{
		Path:      filePath,
		Text:      string(data),
		ByteSize:  info.Size(),
		Truncated: info.Size() > int64(len(data)),
		Binary:    looksBinary(sniff),
		MimeType:  previewContentType(filePath),
		Language:  languageForPath(filePath),
	}, nil
}

// StatFile reports size/mtime/kind without reading the file body. The renderer
// uses it to decide whether a preview is safe before paying for a read.
func (fs *FSService) StatFile(filePath string) (FileStat, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return FileStat{}, fmt.Errorf("failed to stat file: %w", err)
	}

	stat := FileStat{
		Path:     filePath,
		ByteSize: info.Size(),
		MtimeMs:  info.ModTime().UnixMilli(),
		IsDir:    info.IsDir(),
		MimeType: previewContentType(filePath),
		Language: languageForPath(filePath),
	}

	if info.IsDir() {
		return stat, nil
	}

	// Sniff a bounded prefix only. A null byte or a high share of control
	// characters is the same heuristic the renderer used to run in JS.
	f, err := os.Open(filePath)
	if err != nil {
		return stat, nil
	}
	defer f.Close()

	buf := make([]byte, binarySniffBytes)
	n, _ := io.ReadFull(f, buf)
	stat.Binary = looksBinary(buf[:n])
	return stat, nil
}

// ReadFileDataUrl returns a base64 data URL. Oversized files are rejected
// instead of being streamed through the JS bridge: a 12MB image becomes ~16MB
// of base64 plus a second copy in the renderer heap. Preview images go through
// PreviewStartForImage instead.
func (fs *FSService) ReadFileDataUrl(filePath string) (string, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to read file: %w", err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("failed to read file: is a directory")
	}
	if info.Size() > defaultPreviewImageLimit {
		return "", fmt.Errorf("file too large for inline preview (%d bytes > %d)", info.Size(), defaultPreviewImageLimit)
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to read file: %w", err)
	}

	b64 := base64.StdEncoding.EncodeToString(data)
	return fmt.Sprintf("data:%s;base64,%s", previewContentType(filePath), b64), nil
}

const (
	defaultPreviewTextLimit = 512 * 1024
	// Hard safety valve for inline data URLs. The preview pane applies a much
	// tighter policy (8MB) and serves larger images over the loopback origin;
	// this cap only exists so a pathological file can never be base64-encoded
	// into a multi-hundred-megabyte bridge payload. Chat attachments still
	// inline up to this size.
	defaultPreviewImageLimit = 32 * 1024 * 1024
	maxWriteBytes            = 10 * 1024 * 1024
	binarySniffBytes         = 8 * 1024
)

// FileStat is the metadata half of a preview read.
type FileStat struct {
	Path     string `json:"path"`
	ByteSize int64  `json:"byteSize"`
	MtimeMs  int64  `json:"mtimeMs"`
	IsDir    bool   `json:"isDir"`
	Binary   bool   `json:"binary"`
	MimeType string `json:"mimeType"`
	Language string `json:"language,omitempty"`
}

// ReadTextResult mirrors AliceReadFileTextResult in the renderer contract.
type ReadTextResult struct {
	Path      string `json:"path"`
	Text      string `json:"text"`
	ByteSize  int64  `json:"byteSize"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
	MimeType  string `json:"mimeType"`
	Language  string `json:"language,omitempty"`
}

// looksBinary ports the renderer's heuristic: a NUL byte is decisive, and a
// >12% control-character ratio (excluding tab/newline/CR) marks binary data.
func looksBinary(bytes []byte) bool {
	if len(bytes) == 0 {
		return false
	}

	suspicious := 0
	for _, b := range bytes {
		if b == 0 {
			return true
		}
		if b < 32 && b != 9 && b != 10 && b != 13 {
			suspicious++
		}
	}

	return float64(suspicious)/float64(len(bytes)) > 0.12
}

var languageByExtension = map[string]string{
	".c": "c", ".conf": "ini", ".cpp": "cpp", ".css": "css", ".csv": "csv",
	".go": "go", ".graphql": "graphql", ".h": "c", ".hpp": "cpp",
	".html": "html", ".htm": "html", ".java": "java", ".js": "javascript",
	".json": "json", ".jsx": "jsx", ".log": "text", ".lua": "lua",
	".md": "markdown", ".mjs": "javascript", ".py": "python", ".rb": "ruby",
	".rs": "rust", ".sh": "shell", ".sql": "sql", ".svg": "xml",
	".toml": "toml", ".ts": "typescript", ".tsx": "tsx", ".txt": "text",
	".xml": "xml", ".yaml": "yaml", ".yml": "yaml", ".zsh": "shell",
}

func languageForPath(filePath string) string {
	if language, ok := languageByExtension[strings.ToLower(filepath.Ext(filePath))]; ok {
		return language
	}
	return "text"
}


func (fs *FSService) WriteTextFile(filePath string, content string) error {
	if len(content) > maxWriteBytes {
		return fmt.Errorf("file too large to save (%d bytes > %d)", len(content), maxWriteBytes)
	}
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create parent dir: %w", err)
	}
	if err := os.WriteFile(filePath, []byte(content), 0644); err != nil {
		return fmt.Errorf("failed to write file: %w", err)
	}
	return nil
}

func (fs *FSService) TrashPath(targetPath string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("osascript", "-e", fmt.Sprintf(`tell application "Finder" to delete POSIX file "%s"`, targetPath))
	case "windows":
		cmd = exec.Command("cmd", "/c", "recycle", targetPath)
	default:
		if _, err := exec.LookPath("trash-put"); err == nil {
			cmd = exec.Command("trash-put", targetPath)
		} else if _, err := exec.LookPath("trash"); err == nil {
			cmd = exec.Command("trash", targetPath)
		} else {
			return fmt.Errorf("no trash utility available (install trash-cli)")
		}
	}
	return cmd.Run()
}

func (fs *FSService) RenamePath(targetPath string, newName string) (string, error) {
	parent := filepath.Dir(targetPath)
	newPath := filepath.Join(parent, newName)
	if err := os.Rename(targetPath, newPath); err != nil {
		return "", fmt.Errorf("failed to rename: %w", err)
	}
	return newPath, nil
}

func (fs *FSService) RevealPath(targetPath string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "-R", targetPath)
	case "windows":
		cmd = exec.Command("explorer", "/select,", targetPath)
	default:
		cmd = exec.Command("xdg-open", filepath.Dir(targetPath))
	}
	return cmd.Start()
}

func (fs *FSService) PathExists(targetPath string) bool {
	_, err := os.Stat(targetPath)
	return err == nil
}

func (fs *FSService) OpenExternal(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}

// SelectPathsRequest mirrors AliceSelectPathsOptions from the frontend.
type SelectPathsRequest struct {
	Title       string             `json:"title"`
	DefaultPath string             `json:"defaultPath"`
	Directories bool               `json:"directories"`
	Multiple     bool              `json:"multiple"`
}

// psEscape escapes a string for embedding inside a PowerShell single-quoted
// literal (PowerShell escapes a quote by doubling it).
func psEscape(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// SelectPaths opens the OS-native file/folder picker (zenity on Linux,
// osascript on macOS, PowerShell + WinForms on Windows) and returns the chosen
// paths. A user cancel returns an empty slice, not an error — cancel is a
// normal outcome, not a failure.
//
// Single-path selection uses the Wails runtime dialog (no subprocess); the
// subprocess pickers remain for multi-select (Wails v2.15 has no multi-select
// dialog) and as a fallback when the runtime context isn't available.
func (fs *FSService) SelectPaths(options SelectPathsRequest) ([]string, error) {
	if !options.Multiple && fs.ctx != nil {
		if options.Directories {
			dir, err := wailsruntime.OpenDirectoryDialog(fs.ctx, wailsruntime.OpenDialogOptions{
				Title:               options.Title,
				DefaultDirectory:    options.DefaultPath,
				CanCreateDirectories: true,
			})
			if err != nil {
				return []string{}, nil
			}
			if dir == "" {
				return []string{}, nil // user cancelled
			}
			return []string{dir}, nil
		}
		file, err := wailsruntime.OpenFileDialog(fs.ctx, wailsruntime.OpenDialogOptions{
			Title:               options.Title,
			DefaultDirectory:    options.DefaultPath,
			CanCreateDirectories: true,
		})
		if err != nil {
			return []string{}, nil
		}
		if file == "" {
			return []string{}, nil // user cancelled
		}
		return []string{file}, nil
	}

	var args []string
	switch runtime.GOOS {
	case "darwin":
		script := "choose file"
		if options.Directories {
			script = "choose folder"
		}
		if options.Multiple {
			script += " with multiple selections allowed"
		}
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			return []string{}, nil
		}
		// osascript returns POSIX paths separated by commas
		paths := strings.Split(strings.TrimSpace(string(out)), ", ")
		return paths, nil
	case "windows":
		// PowerShell + WinForms dialogs. -STA is required for the dialog
		// classes. Multi-select prints one path per line; single-select and
		// folder mode print a single line.
		var script string
		if options.Directories {
			script = fmt.Sprintf(
				"Add-Type -AssemblyName System.Windows.Forms\n"+
					"$f = New-Object System.Windows.Forms.FolderBrowserDialog\n"+
					"$f.Description = '%s'\n"+
					"if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }\n",
				psEscape(options.Title))
		} else {
			script = fmt.Sprintf(
				"Add-Type -AssemblyName System.Windows.Forms\n"+
					"$f = New-Object System.Windows.Forms.OpenFileDialog\n"+
					"$f.Multiselect = $%v\n"+
					"$f.Title = '%s'\n"+
					"if ($f.ShowDialog() -eq 'OK') { $f.FileNames }\n",
				options.Multiple, psEscape(options.Title))
		}
		out, err := exec.Command("powershell", "-NoProfile", "-STA", "-Command", script).Output()
		if err != nil {
			return []string{}, nil
		}
		var paths []string
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			line = strings.TrimSpace(line)
			if line != "" {
				paths = append(paths, line)
			}
		}
		return paths, nil
	default:
		// Linux: zenity/kdialog file dialog
		if _, err := exec.LookPath("zenity"); err == nil {
			args = []string{"--file-selection"}
			if options.Directories {
				args = append(args, "--directory")
			}
			if options.Multiple {
				args = append(args, "--multiple", "--separator", "\n")
			}
			if options.Title != "" {
				args = append(args, fmt.Sprintf("--title=%s", options.Title))
			}
			if options.DefaultPath != "" {
				args = append(args, fmt.Sprintf("--filename=%s/", options.DefaultPath))
			}
			out, err := exec.Command("zenity", args...).Output()
			if err != nil {
				return []string{}, nil
			}
			paths := strings.Split(strings.TrimSpace(string(out)), "\n")
			return paths, nil
		}
		if _, err := exec.LookPath("kdialog"); err == nil {
			mode := "--getopenfilename"
			if options.Directories {
				mode = "--getexistingdirectory"
			}
			out, err := exec.Command("kdialog", mode).Output()
			if err != nil {
				return []string{}, nil
			}
			return []string{strings.TrimSpace(string(out))}, nil
		}
		return []string{}, nil
	}
}

// SaveImageBuffer writes raw image bytes to a temp file and returns its path.
func (fs *FSService) SaveImageBuffer(data []byte, ext string) (string, error) {
	if len(data) == 0 {
		return "", fmt.Errorf("empty image buffer")
	}
	if ext == "" {
		ext = "png"
	}
	tmpFile, err := os.CreateTemp("", fmt.Sprintf("alice-image-*.%s", ext))
	if err != nil {
		return "", fmt.Errorf("failed to create temp file: %w", err)
	}
	defer tmpFile.Close()
	if _, err := tmpFile.Write(data); err != nil {
		return "", fmt.Errorf("failed to write image: %w", err)
	}
	return tmpFile.Name(), nil
}

// SaveClipboardImage pulls the clipboard image (Linux: xclip, Windows:
// PowerShell Clipboard.GetImage, macOS: osascript) to a temp file.
func (fs *FSService) SaveClipboardImage() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("osascript", "-e",
			`tell app "System Events" to write (the clipboard as «class PNGf») to (POSIX file "/tmp/alice-clipboard.png")`).Output()
		_ = out
		if err != nil {
			return "", err
		}
		return "/tmp/alice-clipboard.png", nil
	case "windows":
		tmpFile, err := os.CreateTemp("", "alice-clipboard-*.png")
		if err != nil {
			return "", err
		}
		tmpName := tmpFile.Name()
		tmpFile.Close()
		script := fmt.Sprintf(
			"Add-Type -AssemblyName System.Windows.Forms\n"+
				"$img = [System.Windows.Forms.Clipboard]::GetImage()\n"+
				"if ($img -ne $null) { $img.Save('%s') } else { exit 1 }\n",
			psEscape(tmpName))
		if err := exec.Command("powershell", "-NoProfile", "-STA", "-Command", script).Run(); err != nil {
			os.Remove(tmpName)
			return "", fmt.Errorf("clipboard has no image")
		}
		info, err := os.Stat(tmpName)
		if err != nil || info.Size() == 0 {
			os.Remove(tmpName)
			return "", fmt.Errorf("clipboard has no image")
		}
		return tmpName, nil
	default:
		if _, err := exec.LookPath("xclip"); err != nil {
			return "", fmt.Errorf("xclip not available")
		}
		tmpFile, err := os.CreateTemp("", "alice-clipboard-*.png")
		if err != nil {
			return "", err
		}
		defer tmpFile.Close()
		cmd := exec.Command("sh", "-c", fmt.Sprintf("xclip -selection clipboard -t image/png -o > %s", tmpFile.Name()))
		if err := cmd.Run(); err != nil {
			return "", err
		}
		info, err := os.Stat(tmpFile.Name())
		if err != nil || info.Size() == 0 {
			return "", fmt.Errorf("clipboard has no image")
		}
		return tmpFile.Name(), nil
	}
}
