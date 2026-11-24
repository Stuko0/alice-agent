package host

import (
	"strings"
)

// mergeEnv returns base with the given KEY=VALUE entries overriding (not
// duplicating) any existing key. Duplicate keys in an environment array have
// platform-dependent resolution, so the host never emits them.
func mergeEnv(base []string, overrides ...string) []string {
	replaced := make(map[string]string, len(overrides))
	order := make([]string, 0, len(overrides))
	for _, kv := range overrides {
		key, _, ok := strings.Cut(kv, "=")
		if !ok {
			continue
		}
		if _, seen := replaced[key]; !seen {
			order = append(order, key)
		}
		replaced[key] = kv
	}

	out := make([]string, 0, len(base)+len(overrides))
	for _, kv := range base {
		key, _, ok := strings.Cut(kv, "=")
		if ok {
			if _, override := replaced[key]; override {
				continue
			}
		}
		out = append(out, kv)
	}
	for _, key := range order {
		out = append(out, replaced[key])
	}
	return out
}
