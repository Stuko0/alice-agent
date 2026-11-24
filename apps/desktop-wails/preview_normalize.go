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
		parsed, err := url.Parse(raw)
		if err != nil {
			filePath = strings.TrimPrefix(raw, "file://")
		} else {
			decoded, err := url.PathUnescape(parsed.Path)
			if err != nil {
				decoded = parsed.Path
			}
			filePath = decoded
		}
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
