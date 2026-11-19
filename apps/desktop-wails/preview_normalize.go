package main

// Preview target normalization, matching the renderer classifier in
// apps/desktop/src/lib/local-preview.ts. Electron normalizes targets in its
// main process; the Wails bridge used to return null and rely on the renderer
// fallback, which meant the two shells could classify the same path
// differently. Keeping the Go side in lockstep gives both shells one shape.

import (
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

var previewHTMLExensions = map[string]bool{".htm": true, ".html": true}
var previewImageExtensions = map[string]bool{
	".bmp": true, ".gif": true, ".jpeg": true, ".jpg": true,
	".png": true, ".svg": true, ".webp": true,
}

// PreviewTarget mirrors AlicePreviewTarget in the renderer's global.d.ts.
type PreviewTarget struct {
	Binary      bool   `json:"binary,omitempty"`
	ByteSize    int64  `json:"byteSize,omitempty"`
	Kind        string `json:"kind"`
	Label       string `json:"label"`
	Large       bool   `json:"large,omitempty"`
	Language    string `json:"language,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
	Path        string `json:"path,omitempty"`
	PreviewKind string `json:"previewKind,omitempty"`
	Source      string `json:"source"`
	URL         string `json:"url"`
}

// NormalizePreviewTarget classifies a raw preview reference. baseDir resolves
// relative paths (the session cwd); it may be empty.
// pathFromFileURL turns a file:// URL into a filesystem path.
//
// The old code took url.Parse(...).Path verbatim, which is right for
// "file:///tmp/a.md" and wrong for the Windows spelling "file:///C:/Users/a.md"
// (the drive letter keeps a leading slash) and for UNC URLs
// ("file://server/share" puts the host in Host, not Path). That produced an
// unusable path on Windows and a "%20"-encoded one when the URL had spaces.
// isWindowsDriveHost reports whether a URL host is really a drive letter
// ("C:") from the non-standard file://C:/path spelling.
func isWindowsDriveHost(host string) bool {
	if len(host) != 2 || host[1] != ':' {
		return false
	}

	c := host[0] | 0x20 // lowercase ASCII without importing unicode

	return c >= 'a' && c <= 'z'
}

func pathFromFileURL(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return filepath.FromSlash(strings.TrimPrefix(strings.TrimPrefix(raw, "file://"), "file:"))
	}

	p := parsed.Path

	switch {
	case isWindowsDriveHost(parsed.Host):
		// Not a real host: `file://C:/Users/a.md` (what several editors and
		// our own renderer produce) puts the drive letter in Host. Treat it as
		// part of the path instead of a UNC server.
		p = parsed.Host + p
	case parsed.Host != "" && !strings.EqualFold(parsed.Host, "localhost"):
		// UNC share: file://server/share/dir -> //server/share/dir
		p = "//" + parsed.Host + p
	}

	if decoded, decodeErr := url.PathUnescape(p); decodeErr == nil {
		p = decoded
	}

	// Windows drive letter: "/C:/dir/file" -> "C:/dir/file".
	if len(p) >= 3 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}

	return filepath.FromSlash(p)
}

func (fs *FSService) NormalizePreviewTarget(target string, baseDir string) (*PreviewTarget, error) {
	raw := strings.TrimSpace(target)
	raw = strings.TrimPrefix(raw, "`")
	raw = strings.TrimSuffix(raw, "`")
	if raw == "" {
		return nil, fmt.Errorf("empty preview target")
	}

	if strings.HasPrefix(strings.ToLower(raw), "http://") || strings.HasPrefix(strings.ToLower(raw), "https://") {
		return &PreviewTarget{
			Kind:   "url",
			Label:  previewBasename(raw),
			Source: raw,
			URL:    raw,
		}, nil
	}

	var filePath string
	if strings.HasPrefix(strings.ToLower(raw), "file://") {
		filePath = pathFromFileURL(raw)
	} else {
		filePath = raw
		if !filepath.IsAbs(filePath) && baseDir != "" {
			filePath = filepath.Join(baseDir, filePath)
		}
	}

	absPath, err := filepath.Abs(filePath)
	if err != nil {
		return nil, fmt.Errorf("invalid preview path: %w", err)
	}

	ext := strings.ToLower(filepath.Ext(absPath))
	previewKind := "text"
	switch {
	case previewHTMLExensions[ext]:
		previewKind = "html"
	case previewImageExtensions[ext]:
		previewKind = "image"
	}

	result := &PreviewTarget{
		Kind:        "file",
		Label:       filepath.Base(absPath),
		Language:    languageForPath(absPath),
		MimeType:    previewContentType(absPath),
		Path:        absPath,
		PreviewKind: previewKind,
		Source:      raw,
		URL:         previewFileURL(absPath),
	}

	if info, statErr := os.Stat(absPath); statErr == nil && !info.IsDir() {
		result.ByteSize = info.Size()
		result.Large = info.Size() > defaultPreviewTextLimit
		if previewKind != "image" {
			if stat, err := fs.StatFile(absPath); err == nil {
				result.Binary = stat.Binary
			}
		}
	}

	return result, nil
}

// previewBasename mirrors the renderer's basename(): last non-empty path
// segment of the URL, falling back to the host.
func previewBasename(raw string) string {
	if parsed, err := url.Parse(raw); err == nil {
		segments := strings.Split(strings.Trim(parsed.Path, "/"), "/")
		for i := len(segments) - 1; i >= 0; i-- {
			if segments[i] != "" {
				return segments[i]
			}
		}
		if parsed.Host != "" {
			return parsed.Host
		}
	}
	return path.Base(raw)
}

// previewFileURL percent-encodes each path segment, matching pathToFileUrl()
// in local-preview.ts (spaces, unicode, etc. must survive a round trip).
func previewFileURL(filePath string) string {
	slashed := filepath.ToSlash(filePath)
	segments := strings.Split(slashed, "/")
	encoded := make([]string, 0, len(segments))
	for _, segment := range segments {
		encoded = append(encoded, url.PathEscape(segment))
	}
	joined := strings.Join(encoded, "/")
	if !strings.HasPrefix(joined, "/") {
		joined = "/" + joined
	}
	return "file://" + joined
}
