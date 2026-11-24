package config

import (
	"os"
	"path/filepath"
)

// homeDirs mirrors alice_cli.config.ensure_alice_home's directory skeleton.
// SOUL.md seeding is intentionally not replicated: it is home bootstrap, not
// config editing, and the runtime seeds it on first use.
var homeDirs = []string{
	"cron",
	"sessions",
	"logs",
	"logs/curator",
	"memories",
	"pairing",
	"hooks",
	"image_cache",
	"audio_cache",
	"skills",
}

// EnsureHome creates the ALICE_HOME skeleton, best-effort (Python warns on
// failure instead of aborting a migration).
func EnsureHome(home string) {
	if home == "" {
		return
	}
	for _, dir := range homeDirs {
		_ = os.MkdirAll(filepath.Join(home, dir), 0o700)
	}
}
