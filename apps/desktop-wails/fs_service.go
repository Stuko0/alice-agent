package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type FSService struct{}

func NewFSService() *FSService {
	return &FSService{}
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

func (fs *FSService) ReadFileText(filePath string) (string, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to read file: %w", err)
	}
	return string(data), nil
}

func (fs *FSService) ReadFileDataUrl(filePath string) (string, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return "", fmt.Errorf("failed to read file: %w", err)
	}

	ext := strings.TrimPrefix(filepath.Ext(filePath), ".")
	mime := "application/octet-stream"
	switch ext {
	case "png":
		mime = "image/png"
	case "jpg", "jpeg":
		mime = "image/jpeg"
	case "gif":
		mime = "image/gif"
	case "svg":
		mime = "image/svg+xml"
	case "webp":
		mime = "image/webp"
	case "pdf":
		mime = "application/pdf"
	case "txt", "md", "log":
		mime = "text/plain"
	case "json":
		mime = "application/json"
	case "html", "htm":
		mime = "text/html"
	case "css":
		mime = "text/css"
	case "js":
		mime = "application/javascript"
	}

	b64 := base64.StdEncoding.EncodeToString(data)
	return fmt.Sprintf("data:%s;base64,%s", mime, b64), nil
}

func (fs *FSService) WriteTextFile(filePath string, content string) error {
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

// SelectPaths opens the OS-native file/folder picker (zenity on Linux,
// osascript on macOS, powershell on Windows) and returns the chosen paths.
func (fs *FSService) SelectPaths(options SelectPathsRequest) ([]string, error) {
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
		return []string{}, nil
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

// SaveClipboardImage pulls the clipboard image (Linux: xclip) to a temp file.
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
