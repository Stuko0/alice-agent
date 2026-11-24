package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Stuko0/alice-agent/go/internal/config"
	"gopkg.in/yaml.v3"
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
		config.EnsureHome(home)
		if err := doc.Save(); err != nil {
			fmt.Fprintf(opts.Stderr, "alice config set: %v\n", err)
			return true, 1
		}
		fmt.Fprintf(opts.Stdout, "✓ Set %s = %s in %s\n", key, config.MaskValue(key, raw), path)
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

	case "check":
		if len(args) != 1 {
			return false, 0
		}
		return true, runConfigCheck(opts, home, path)

	case "dump":
		if len(args) != 1 {
			return false, 0
		}
		return true, runConfigDump(opts, path)

	case "migrate":
		if len(args) != 1 {
			// Flags / interactive flows stay with Python.
			return false, 0
		}
		if _, statErr := os.Stat(path); statErr != nil {
			// Python reports a missing config as already current.
			fmt.Fprintln(opts.Stdout, "✓ Configuration is up to date!")
			return true, 0
		}
		doc, err := config.Load(path)
		if err != nil {
			fmt.Fprintf(opts.Stderr, "alice config migrate: %v\n", err)
			return true, 1
		}
		result, handled, err := doc.MigrateToLatest(home)
		if err != nil {
			fmt.Fprintf(opts.Stderr, "alice config migrate: %v\n", err)
			return true, 1
		}
		if !handled {
			return false, 0
		}
		if result.From < result.To {
			fmt.Fprintf(opts.Stdout, "Config version: %d → %d\n", result.From, result.To)
		}
		for _, applied := range result.Applied {
			fmt.Fprintf(opts.Stdout, "  ✓ %s\n", applied)
		}
		for _, warning := range result.Warnings {
			fmt.Fprintf(opts.Stderr, "  ⚠ %s\n", warning)
		}
		if result.From >= result.To && len(result.Applied) == 0 && len(result.Warnings) == 0 {
			fmt.Fprintln(opts.Stdout, "✓ Configuration is up to date!")
		}
		return true, 0
	}

	return false, 0
}

// runConfigCheck mirrors `alice config check`: schema version plus the status
// of every optional env var. Missing default keys are not reported because
// load_config deep-merges them away, exactly like Python.
func runConfigCheck(opts Options, home, path string) int {
	latest, err := config.LatestVersion()
	if err != nil {
		fmt.Fprintf(opts.Stderr, "alice config check: %v\n", err)
		return 1
	}

	current := latest
	if _, statErr := os.Stat(path); statErr == nil {
		doc, loadErr := config.Load(path)
		if loadErr != nil {
			fmt.Fprintf(opts.Stderr, "alice config check: %v\n", loadErr)
			return 1
		}
		current = doc.RawVersion()
		if current == 0 {
			current = 1
		}
	}

	optional, err := config.OptionalEnv()
	if err != nil {
		fmt.Fprintf(opts.Stderr, "alice config check: %v\n", err)
		return 1
	}

	fmt.Fprintln(opts.Stdout)
	fmt.Fprintln(opts.Stdout, "📋 Configuration Status")
	fmt.Fprintln(opts.Stdout)
	if current >= latest {
		fmt.Fprintf(opts.Stdout, "  Config version: %d ✓\n", current)
	} else {
		fmt.Fprintf(opts.Stdout, "  Config version: %d → %d (update available)\n", current, latest)
	}

	fmt.Fprintln(opts.Stdout)
	fmt.Fprintln(opts.Stdout, "  Required:")

	fmt.Fprintln(opts.Stdout)
	fmt.Fprintln(opts.Stdout, "  Optional:")

	envFile := config.ParseEnvFile(filepath.Join(home, ".env"))
	for _, variable := range optional {
		if _, ok := config.EnvValue(variable.Name, envFile); ok {
			fmt.Fprintf(opts.Stdout, "    ✓ %s\n", variable.Name)
			continue
		}
		tools := ""
		if len(variable.Tools) > 0 {
			limit := len(variable.Tools)
			if limit > 2 {
				limit = 2
			}
			tools = " → " + strings.Join(variable.Tools[:limit], ", ")
		}
		fmt.Fprintf(opts.Stdout, "    ○ %s%s\n", variable.Name, tools)
	}
	fmt.Fprintln(opts.Stdout)
	return 0
}

// runConfigDump prints the merged defaults+user config as YAML with secret
// leaves masked. Python has no equivalent raw view (its `show` is a curated
// panel that depends on auth and skill discovery).
func runConfigDump(opts Options, path string) int {
	defaults, err := config.Defaults()
	if err != nil {
		fmt.Fprintf(opts.Stderr, "alice config dump: %v\n", err)
		return 1
	}
	doc, err := config.Load(path)
	if err != nil {
		fmt.Fprintf(opts.Stderr, "alice config dump: %v\n", err)
		return 1
	}

	merged := config.Merge(defaults, doc.Map())
	masked := config.MaskTree(merged)

	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(masked); err != nil {
		fmt.Fprintf(opts.Stderr, "alice config dump: %v\n", err)
		return 1
	}
	if err := enc.Close(); err != nil {
		fmt.Fprintf(opts.Stderr, "alice config dump: %v\n", err)
		return 1
	}
	fmt.Fprint(opts.Stdout, buf.String())
	return 0
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
