package config

import (
	"os"
	"sort"
	"strings"
)

// SanitizeEnvFile repairs concatenated KEY=VALUE lines in an .env file and
// returns the number of changed lines (0 means untouched). Mirrors
// alice_cli.config.sanitize_env_file.
func SanitizeEnvFile(path string, knownKeys map[string]bool) (int, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	original := strings.Split(string(data), "\n")
	if len(original) > 0 && original[len(original)-1] == "" {
		original = original[:len(original)-1]
	}

	sanitized := sanitizeEnvLines(original, knownKeys)
	if equalStringSlices(original, sanitized) {
		return 0, nil
	}

	content := strings.Join(sanitized, "\n")
	if len(sanitized) > 0 {
		content += "\n"
	}
	return countEnvFixes(original, sanitized), atomicWrite(path, []byte(content))
}

type needleRange struct {
	start int
	end   int
}

func sanitizeEnvLines(lines []string, knownKeys map[string]bool) []string {
	sanitized := make([]string, 0, len(lines))

	for _, raw := range lines {
		stripped := strings.TrimSpace(raw)
		if stripped == "" || strings.HasPrefix(stripped, "#") {
			sanitized = append(sanitized, raw)
			continue
		}

		var ranges []needleRange
		for key := range knownKeys {
			needle := key + "="
			index := strings.Index(stripped, needle)
			for index >= 0 {
				ranges = append(ranges, needleRange{start: index, end: index + len(needle)})
				next := strings.Index(stripped[index+len(needle):], needle)
				if next < 0 {
					break
				}
				index = index + len(needle) + next
			}
		}

		var positions []int
		seen := map[int]bool{}
		for _, candidate := range ranges {
			contained := false
			for _, other := range ranges {
				if other == candidate {
					continue
				}
				if other.start <= candidate.start && other.end >= candidate.end {
					contained = true
					break
				}
			}
			if contained || seen[candidate.start] {
				continue
			}
			seen[candidate.start] = true
			positions = append(positions, candidate.start)
		}
		sort.Ints(positions)

		if len(positions) > 1 {
			for i, start := range positions {
				end := len(stripped)
				if i+1 < len(positions) {
					end = positions[i+1]
				}
				part := strings.TrimSpace(stripped[start:end])
				if part != "" {
					sanitized = append(sanitized, part)
				}
			}
			continue
		}

		sanitized = append(sanitized, stripped)
	}

	return sanitized
}

func equalStringSlices(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func countEnvFixes(original, sanitized []string) int {
	fixes := len(sanitized) - len(original)
	if fixes < 0 {
		fixes = -fixes
	}
	if fixes > 0 {
		return fixes
	}
	for i := range original {
		if i < len(sanitized) && original[i] != sanitized[i] {
			fixes++
		}
	}
	return fixes
}
