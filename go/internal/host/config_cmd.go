package host

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/Stuko0/alice-agent/go/internal/config"
)

// Keys Python routes to .env instead of config.yaml. Kept verbatim so the Go
// slice never silently writes a credential into the YAML file.
var apiKeyNames = map[string]bool{
	"OPENROUTER_API_KEY":      true,
	"OPENAI_API_KEY":          true,
	"ANTHROPIC_API_KEY":       true,
	"VOICE_TOOLS_OPENAI_KEY":  true,
	"EXA_API_KEY":             true,
	"PARALLEL_API_KEY":        true,
	"FIRECRAWL_API_KEY":       true,
	"FIRECRAWL_API_URL":       true,
	"FIRECRAWL_GATEWAY_URL":   true,
	"TOOL_GATEWAY_DOMAIN":     true,
	"TOOL_GATEWAY_SCHEME":     true,
	"TOOL_GATEWAY_USER_TOKEN": true,
	"TAVILY_API_KEY":          true,
	"BROWSERBASE_API_KEY":     true,
	"BROWSERBASE_PROJECT_ID":  true,
	"BROWSER_USE_API_KEY":     true,
	"FAL_KEY":                 true,
	"TELEGRAM_BOT_TOKEN":      true,
	"DISCORD_BOT_TOKEN":       true,
	"TERMINAL_SSH_HOST":       true,
	"TERMINAL_SSH_USER":       true,
	"TERMINAL_SSH_KEY":        true,
	"SUDO_PASSWORD":           true,
	"SLACK_BOT_TOKEN":         true,
	"SLACK_APP_TOKEN":         true,
	"GITHUB_TOKEN":            true,
	"HONCHO_API_KEY":          true,
}

var secretLeafKeys = map[string]bool{
	"api_key": true, "apikey": true, "key": true, "token": true,
	"access_token": true, "refresh_token": true, "id_token": true,
	"secret": true, "client_secret": true, "password": true,
}

func looksLikeAPIKey(key string) bool {
	upper := strings.ToUpper(key)
	if apiKeyNames[upper] {
		return true
	}
	return strings.HasSuffix(upper, "_API_KEY") ||
		strings.HasSuffix(upper, "_TOKEN") ||
		strings.HasPrefix(upper, "TERMINAL_SSH")
}

// runConfigNative handles the safe slices of `alice config`. Everything that
// needs the Python config core (show/edit/check/migrate) and every write that
// Python routes to .env or to the terminal env mirror is delegated: handled
// is false and the caller forwards the original argv.
func runConfigNative(opts Options, args []string) (handled bool, code int) {
	if len(args) == 0 {
		return false, 0
	}

	home, _ := opts.Resolver.Home()
	path := filepath.Join(home, "config.yaml")

	switch args[0] {
	case "path":
		if len(args) != 1 {
			return false, 0
		}
		fmt.Fprintln(opts.Stdout, path)
		return true, 0

	case "env-path":
		if len(args) != 1 {
			return false, 0
		}
		fmt.Fprintln(opts.Stdout, filepath.Join(home, ".env"))
		return true, 0

	case "get":
		if len(args) != 2 {
			fmt.Fprintln(opts.Stderr, "usage: alice config get <key>")
			return true, 2
		}
		doc, err := config.Load(path)
		if err != nil {
			fmt.Fprintf(opts.Stderr, "alice config get: %v\n", err)
			return true, 1
		}
		value, ok := doc.Get(args[1])
		if !ok {
			fmt.Fprintf(opts.Stderr, "%s is not set\n", args[1])
			return true, 1
		}
		fmt.Fprintln(opts.Stdout, formatConfigValue(value))
		return true, 0

	case "set":
		if len(args) != 3 {
			// Python prints the canonical usage.
			return false, 0
		}
		key, raw := args[1], args[2]
		if looksLikeAPIKey(key) || strings.HasPrefix(key, "terminal.") {
			return false, 0
		}
		if managedKeySet(key) {
			fmt.Fprintf(opts.Stderr,
				"Cannot set '%s': it is managed by your administrator and cannot be changed. Contact your administrator to modify it.\n", key)
			return true, 1
		}

		if strings.EqualFold(key, "api_base") || strings.EqualFold(key, "model.api_base") {
			key = "model.base_url"
			fmt.Fprintln(opts.Stdout, "  (note: 'api_base' is an alias — saved as model.base_url)")
		}

		doc, err := config.Load(path)
		if err != nil {
			fmt.Fprintf(opts.Stderr, "alice config set: %v\n", err)
			return true, 1
		}
		if err := doc.Set(key, raw); err != nil {
			fmt.Fprintf(opts.Stderr, "alice config set: %v\n", err)
			return true, 1
		}
		if err := doc.Save(); err != nil {
			fmt.Fprintf(opts.Stderr, "alice config set: %v\n", err)
			return true, 1
		}
		fmt.Fprintf(opts.Stdout, "✓ Set %s = %s in %s\n", key, maskConfigValue(key, raw), path)
		return true, 0

	case "unset":
		if len(args) != 2 {
			fmt.Fprintln(opts.Stderr, "usage: alice config unset <key>")
			return true, 2
		}
		key := args[1]
		if looksLikeAPIKey(key) || strings.HasPrefix(key, "terminal.") {
			return false, 0
		}
		if managedKeySet(key) {
			fmt.Fprintf(opts.Stderr,
				"Cannot unset '%s': it is managed by your administrator and cannot be changed. Contact your administrator to modify it.\n", key)
			return true, 1
		}

		doc, err := config.Load(path)
		if err != nil {
			fmt.Fprintf(opts.Stderr, "alice config unset: %v\n", err)
			return true, 1
		}
		removed, err := doc.Unset(key)
		if err != nil {
			fmt.Fprintf(opts.Stderr, "alice config unset: %v\n", err)
			return true, 1
		}
		if !removed {
			fmt.Fprintf(opts.Stderr, "%s is not set\n", key)
			return true, 1
		}
		if err := doc.Save(); err != nil {
			fmt.Fprintf(opts.Stderr, "alice config unset: %v\n", err)
			return true, 1
		}
		fmt.Fprintf(opts.Stdout, "✓ Unset %s in %s\n", key, path)
		return true, 0
	}

	return false, 0
}

func managedKeySet(key string) bool {
	dir := config.DefaultManagedDir()
	if dir == "" {
		return false
	}
	return config.ManagedConfigKeys(dir)[key]
}

func formatConfigValue(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case nil:
		return "null"
	default:
		if data, err := json.Marshal(v); err == nil {
			return string(data)
		}
		return fmt.Sprint(v)
	}
}

func maskConfigValue(key, value string) string {
	leaf := key
	if idx := strings.LastIndex(key, "."); idx >= 0 {
		leaf = key[idx+1:]
	}
	if !secretLeafKeys[strings.ToLower(leaf)] || value == "" {
		return value
	}
	if len(value) <= 8 {
		return "***"
	}
	return value[:4] + "..." + value[len(value)-4:]
}
