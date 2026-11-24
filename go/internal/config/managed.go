package config

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// DefaultManagedDir resolves the administrator-managed scope. Mirrors
// alice_cli.managed_scope.get_managed_dir: $ALICE_MANAGED_DIR when it exists,
// else /etc/alice when it exists, else "" (no managed scope).
func DefaultManagedDir() string {
	if override := strings.TrimSpace(os.Getenv("ALICE_MANAGED_DIR")); override != "" {
		if info, err := os.Stat(override); err == nil && info.IsDir() {
			return override
		}
		return ""
	}
	if info, err := os.Stat("/etc/alice"); err == nil && info.IsDir() {
		return "/etc/alice"
	}
	return ""
}

// ManagedConfigKeys returns the dotted leaf keys pinned by <dir>/config.yaml.
func ManagedConfigKeys(dir string) map[string]bool {
	if dir == "" {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(dir, "config.yaml"))
	if err != nil {
		return nil
	}
	var parsed map[string]any
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return nil
	}
	keys := make(map[string]bool)
	flattenKeys(parsed, "", keys)
	return keys
}

// flattenKeys matches alice_cli.managed_scope._flatten_keys: recurse into
// non-empty mappings, everything else (including lists) is a leaf.
func flattenKeys(node map[string]any, prefix string, out map[string]bool) {
	for key, value := range node {
		dotted := key
		if prefix != "" {
			dotted = prefix + "." + key
		}
		child, isMap := value.(map[string]any)
		if isMap && len(child) > 0 {
			flattenKeys(child, dotted, out)
			continue
		}
		out[dotted] = true
	}
}
