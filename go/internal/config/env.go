package config

import (
	"bufio"
	"os"
	"strings"
)

// ParseEnvFile reads a KEY=VALUE file. Missing files yield an empty map.
func ParseEnvFile(path string) map[string]string {
	out := make(map[string]string)
	file, err := os.Open(path)
	if err != nil {
		return out
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		out[key] = unquoteEnvValue(strings.TrimSpace(value))
	}
	return out
}

func unquoteEnvValue(value string) string {
	if len(value) >= 2 {
		if (value[0] == '"' && value[len(value)-1] == '"') ||
			(value[0] == '\'' && value[len(value)-1] == '\'') {
			return value[1 : len(value)-1]
		}
	}
	return value
}

// EnvValue mirrors alice_cli.config.get_env_value: the process environment
// wins, then the .env file.
func EnvValue(name string, fileEnv map[string]string) (string, bool) {
	if value, ok := os.LookupEnv(name); ok {
		return value, true
	}
	value, ok := fileEnv[name]
	return value, ok
}
