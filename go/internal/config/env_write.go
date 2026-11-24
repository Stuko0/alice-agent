package config

import (
	"os"
	"path/filepath"
	"strings"
)

// WriteEnvValue sets KEY=value in an .env file, preserving every other line.
// Empty values are written as `KEY=` (Python's save_env_value behaviour) and
// the file mode is preserved.
func WriteEnvValue(path, key, value string) error {
	var lines []string
	if data, err := os.ReadFile(path); err == nil {
		lines = strings.Split(string(data), "\n")
		// Drop the trailing element produced by a final newline; it is
		// re-added when writing.
		if len(lines) > 0 && lines[len(lines)-1] == "" {
			lines = lines[:len(lines)-1]
		}
	}

	serialized := quoteEnvValue(value)
	replaced := false
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), key+"=") {
			lines[i] = key + "=" + serialized
			replaced = true
			break
		}
	}
	if !replaced {
		lines = append(lines, key+"="+serialized)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	content := strings.Join(lines, "\n") + "\n"
	return atomicWrite(path, []byte(content))
}

func quoteEnvValue(value string) string {
	if value == "" {
		return ""
	}
	if !strings.ContainsAny(value, " \t#\"'") {
		return value
	}
	escaped := strings.ReplaceAll(value, "\\", "\\\\")
	escaped = strings.ReplaceAll(escaped, "\"", "\\\"")
	return "\"" + escaped + "\""
}
