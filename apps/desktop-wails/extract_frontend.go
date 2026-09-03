package main

import (
	"io/fs"
	"os"
	"path/filepath"
)

// extractEmbeddedFrontend writes the Wails-embedded frontend (go:embed
// frontend/dist → the `assets` embed.FS in main.go, rooted at "frontend/dist")
// to dst so ALICE_WEB_DIST points at a real build. Used when the checkout has
// no apps/desktop/dist (fresh clone / managed install without a Node
// toolchain): the backend fail-fasts on a missing index.html, which used to
// surface as the opaque "Starting Alice" boot hang.
func extractEmbeddedFrontend(dst string) error {
	const embedRoot = "frontend/dist"
	if _, err := fs.Stat(assets, embedRoot+"/index.html"); err != nil {
		return err // embedded frontend missing — build packaging problem
	}

	return fs.WalkDir(assets, embedRoot, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, relErr := filepath.Rel(embedRoot, path)
		if relErr != nil {
			return relErr
		}
		target := filepath.Join(dst, filepath.FromSlash(rel))

		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}

		data, readErr := fs.ReadFile(assets, path)
		if readErr != nil {
			return readErr
		}
		if writeErr := os.MkdirAll(filepath.Dir(target), 0o755); writeErr != nil {
			return writeErr
		}
		return os.WriteFile(target, data, 0o644)
	})
}
