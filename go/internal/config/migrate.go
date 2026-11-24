package config

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// OldestNativeMigration is the first schema version this engine can migrate
// from. Older schemas need transforms that still live in Python (env moves,
// plugin grandfathering, MCP hardening).
const OldestNativeMigration = 1

// MigrationResult reports what a migration did.
type MigrationResult struct {
	From     int
	To       int
	Applied  []string
	Warnings []string
}

// MigrateToLatest applies the natively ported transforms and bumps
// `_config_version`. ok is false when the on-disk schema is too old and the
// caller must delegate to Python.
//
// This is a targeted edit: only the transformed keys and the version are
// touched, so comments and unrelated keys survive. Values that were not in the
// original file and equal the schema default are stripped, matching
// save_config's "never materialise defaults" invariant.
func (d *Document) MigrateToLatest(home string) (MigrationResult, bool, error) {
	latest, err := LatestVersion()
	if err != nil {
		return MigrationResult{}, false, err
	}
	defaults, err := Defaults()
	if err != nil {
		return MigrationResult{}, false, err
	}

	current := d.RawVersion()
	if current == 0 {
		current = 1
	}

	// save_config/ensure_alice_home create the home skeleton on every write;
	// Python's migrate triggers it for every version, including up-to-date ones.
	EnsureHome(home)

	result := MigrationResult{From: current, To: latest}
	envPath := filepath.Join(home, ".env")

	// Python sanitises .env at the very start of every migration run.
	if known, err := KnownEnvKeys(); err == nil {
		if fixes, err := SanitizeEnvFile(envPath, known); err == nil && fixes > 0 {
			result.Applied = append(result.Applied, fmt.Sprintf("sanitized .env (%d fixes)", fixes))
		}
	}
	fileEnv := ParseEnvFile(envPath)

	if current < OldestNativeMigration {
		return result, false, nil
	}
	if current >= latest {
		if d.disableSuspiciousMCPServers(&result) {
			d.normalizeForSave()
			if err := d.Save(); err != nil {
				return result, true, err
			}
		}
		return result, true, nil
	}

	// ── 22 → 23: curator defaults + logs/curator/ ──
	// Python adds the curator sections and then strips them as defaults, so the
	// only observable side effect is the logs directory.
	if current < 23 {
		if err := os.MkdirAll(filepath.Join(home, "logs", "curator"), 0o700); err != nil {
			return result, true, err
		}
		result.Applied = append(result.Applied, "logs/curator/ ensured")
	}

	// ── 24 → 25: model_catalog.ttl_hours 24 → 1 ──
	if current < 25 {
		if value, ok := d.Get("model_catalog.ttl_hours"); ok && asInt(value) == 24 {
			if err := d.setMigrationValue("model_catalog.ttl_hours", 1, defaults); err != nil {
				return result, true, err
			}
			result.Applied = append(result.Applied, "model_catalog.ttl_hours 24→1")
		}
	}

	// ── 3 → 4: tool progress from .env/env into display.tool_progress ──
	if current < 4 {
		if _, exists := d.Get("display.tool_progress"); !exists {
			displayIsMap := true
			if raw, ok := d.Get("display"); ok {
				if _, isMap := raw.(map[string]any); !isMap {
					displayIsMap = false
				}
			}
			if displayIsMap {
				enabled, _ := EnvValue("ALICE_TOOL_PROGRESS", fileEnv)
				mode, _ := EnvValue("ALICE_TOOL_PROGRESS_MODE", fileEnv)
				switch {
				case isFalsey(enabled):
					enabled = "off"
					if err := d.setMigrationValue("display.tool_progress", "off", defaults); err != nil {
						return result, true, err
					}
				case strings.EqualFold(strings.TrimSpace(mode), "new") || strings.EqualFold(strings.TrimSpace(mode), "all"):
					if err := d.setMigrationValue("display.tool_progress", strings.ToLower(strings.TrimSpace(mode)), defaults); err != nil {
						return result, true, err
					}
				default:
					if err := d.setMigrationValue("display.tool_progress", "all", defaults); err != nil {
						return result, true, err
					}
				}
				result.Applied = append(result.Applied, "display.tool_progress")
			}
		}
	}

	// ── 4 → 5: add timezone (process env only, like Python's os.getenv) ──
	if current < 5 {
		if _, exists := d.Get("timezone"); !exists {
			tz := strings.TrimSpace(os.Getenv("ALICE_TIMEZONE"))
			if err := d.setMigrationValue("timezone", tz, defaults); err != nil {
				return result, true, err
			}
			result.Applied = append(result.Applied, "timezone")
		}
	}

	// ── 8 → 9: clear ANTHROPIC_TOKEN from .env ──
	if current < 9 {
		if value, ok := EnvValue("ANTHROPIC_TOKEN", fileEnv); ok && value != "" {
			if err := WriteEnvValue(envPath, "ANTHROPIC_TOKEN", ""); err != nil {
				return result, true, err
			}
			result.Applied = append(result.Applied, "cleared ANTHROPIC_TOKEN from .env")
		}
	}

	// ── 11 → 12: custom_providers list → providers dict ──
	if current < 12 {
		if applied := d.migrateCustomProviders(); len(applied) > 0 {
			result.Applied = append(result.Applied, applied...)
		}
	}

	// ── 12 → 13: clear dead LLM_MODEL / OPENAI_MODEL from .env ──
	if current < 13 {
		for _, name := range []string{"LLM_MODEL", "OPENAI_MODEL"} {
			if value, ok := EnvValue(name, fileEnv); ok && value != "" {
				if err := WriteEnvValue(envPath, name, ""); err != nil {
					return result, true, err
				}
				result.Applied = append(result.Applied, "cleared "+name+" from .env")
			}
		}
	}

	// ── 13 → 14: legacy flat stt.model → provider-specific section ──
	if current < 14 {
		if legacy, ok := d.Get("stt.model"); ok {
			provider := "local"
			if raw, ok := d.Get("stt.provider"); ok {
				if text := strings.TrimSpace(stringValue(raw)); text != "" {
					provider = text
				}
			}
			// The model key itself is removed; an emptied `stt` mapping stays
			// (Python keeps an already-empty dict).
			_, _ = d.UnsetKeepParents("stt.model")

			legacyModel := stringValue(legacy)
			if provider == "local" || provider == "local_command" {
				if localSTTModels[legacyModel] && !d.IsExplicit("stt.local.model") {
					if err := d.setMigrationValue("stt.local.model", legacyModel, defaults); err != nil {
						return result, true, err
					}
				}
			} else if !d.IsExplicit("stt." + provider + ".model") {
				if err := d.setMigrationValue("stt."+provider+".model", legacyModel, defaults); err != nil {
					return result, true, err
				}
			}
			result.Applied = append(result.Applied, "stt.model → provider section")
		}
	}

	// ── 14 → 15 is a schema default (interim_assistant_messages=true) ──
	// The added value equals the default and is not in the user's file, so
	// Python strips it: nothing to write.

	// ── 15 → 16: display.tool_progress_overrides → display.platforms ──
	if current < 16 {
		if raw, ok := d.Get("display.tool_progress_overrides"); ok {
			if overrides, isMap := raw.(map[string]any); isMap && len(overrides) > 0 {
				platforms := map[string]any{}
				if value, ok := d.Get("display.platforms"); ok {
					if existing, isMap := value.(map[string]any); isMap {
						platforms = existing
					}
				}
				for platform, mode := range overrides {
					entry, _ := platforms[platform].(map[string]any)
					if entry == nil {
						entry = map[string]any{}
					}
					if _, exists := entry["tool_progress"]; !exists {
						entry["tool_progress"] = mode
					}
					platforms[platform] = entry
				}
				if err := d.SetAny("display.platforms", platforms); err != nil {
					return result, true, err
				}
				result.Applied = append(result.Applied, "display.platforms (from tool_progress_overrides)")
			}
		}
	}

	// ── 16 → 17: compression.summary_* → auxiliary.compression ──
	if current < 17 {
		summaryModel, hasModel := d.Get("compression.summary_model")
		summaryProvider, hasProvider := d.Get("compression.summary_provider")
		summaryBaseURL, hasBaseURL := d.Get("compression.summary_base_url")
		if hasModel || hasProvider || hasBaseURL {
			if hasModel {
				_, _ = d.UnsetKeepParents("compression.summary_model")
			}
			if hasProvider {
				_, _ = d.UnsetKeepParents("compression.summary_provider")
			}
			if hasBaseURL {
				_, _ = d.UnsetKeepParents("compression.summary_base_url")
			}

			if text := strings.TrimSpace(stringValue(summaryModel)); text != "" {
				if _, set := d.Get("auxiliary.compression.model"); !set {
					if err := d.setMigrationValue("auxiliary.compression.model", text, defaults); err != nil {
						return result, true, err
					}
				}
			}
			if text := strings.TrimSpace(stringValue(summaryProvider)); text != "" && !strings.EqualFold(text, "auto") {
				currentProvider := ""
				if value, ok := d.Get("auxiliary.compression.provider"); ok {
					currentProvider = strings.TrimSpace(stringValue(value))
				}
				if currentProvider == "" || strings.EqualFold(currentProvider, "auto") {
					if err := d.setMigrationValue("auxiliary.compression.provider", text, defaults); err != nil {
						return result, true, err
					}
				}
			}
			if text := strings.TrimSpace(stringValue(summaryBaseURL)); text != "" {
				if _, set := d.Get("auxiliary.compression.base_url"); !set {
					if err := d.setMigrationValue("auxiliary.compression.base_url", text, defaults); err != nil {
						return result, true, err
					}
				}
			}
			result.Applied = append(result.Applied, "compression.summary_* → auxiliary.compression")
		}
	}

	// ── 20 → 21: plugins opt-in; grandfather installed user plugins ──
	if current < 21 {
		if _, exists := d.Get("plugins.enabled"); !exists {
			disabled := map[string]bool{}
			if raw, ok := d.Get("plugins.disabled"); ok {
				if list, isList := raw.([]any); isList {
					for _, item := range list {
						if name, isString := item.(string); isString {
							disabled[name] = true
						}
					}
				}
			}
			names := discoverUserPlugins(filepath.Join(home, "plugins"), disabled)
			items := make([]any, len(names))
			for i, name := range names {
				items[i] = name
			}
			if err := d.SetAny("plugins.enabled", items); err != nil {
				return result, true, err
			}
			result.Applied = append(result.Applied, fmt.Sprintf("plugins.enabled (%d grandfathered)", len(names)))
		}
	}

	// ── 28 → 29: memory/skills write_mode tri-state → write_approval ──
	if current < 29 {
		for _, subsystem := range []string{"memory", "skills"} {
			value, ok := d.Get(subsystem + ".write_mode")
			if !ok {
				continue
			}
			approve := false
			if text, isString := value.(string); isString {
				approve = strings.EqualFold(strings.TrimSpace(text), "approve")
			}
			if _, err := d.Unset(subsystem + ".write_mode"); err != nil {
				return result, true, err
			}
			if err := d.setMigrationValue(subsystem+".write_approval", approve, defaults); err != nil {
				return result, true, err
			}
			result.Applied = append(result.Applied, subsystem+".write_mode → write_approval")
		}
	}

	// ── 29 → 30 is a schema-default change (curator.consolidate), no write.
	// ── 30 → 31: verify_on_stop "auto"/missing → false ──
	if current < 31 {
		value, ok := d.Get("agent.verify_on_stop")
		isAuto := false
		if text, isString := value.(string); isString {
			isAuto = strings.EqualFold(strings.TrimSpace(text), "auto")
		}
		if !ok || isAuto {
			if err := d.setMigrationValue("agent.verify_on_stop", false, defaults); err != nil {
				return result, true, err
			}
			result.Applied = append(result.Applied, "agent.verify_on_stop=false")
		}
	}

	// ── 31 → 32: flip a baked-in literal true to false ──
	if current < 32 {
		if value, ok := d.Get("agent.verify_on_stop"); ok {
			if flag, isBool := value.(bool); isBool && flag {
				if err := d.setMigrationValue("agent.verify_on_stop", false, defaults); err != nil {
					return result, true, err
				}
				result.Applied = append(result.Applied, "agent.verify_on_stop=false")
			}
		}
	}

	if err := d.Set("_config_version", fmt.Sprint(latest)); err != nil {
		return result, true, err
	}

	// Post-migration: MCP hardening runs on every migrate, even with no
	// version transform.
	d.disableSuspiciousMCPServers(&result)
	if managed := ManagedConfigKeys(DefaultManagedDir()); len(managed) > 0 {
		for key := range managed {
			if removed, _ := d.Unset(key); removed {
				result.Warnings = append(result.Warnings, "did not save managed setting "+key)
			}
		}
	}
	d.normalizeForSave()

	if err := d.Save(); err != nil {
		return result, true, err
	}
	return result, true, nil
}

// setMigrationValue writes value, honoring save_config's two rules:
//   - a path the user wrote explicitly is preserved even when it matches a
//     default;
//   - a value the migration adds that matches a default is stripped instead.
func (d *Document) setMigrationValue(key string, value any, defaults map[string]any) error {
	// Migrations write typed values (a string "off" stays a string); routing
	// them through Set would apply set_config_value's CLI coercion.
	if d.IsExplicit(key) {
		return d.SetAny(key, value)
	}
	if def, ok := lookupDefault(defaults, key); ok && reflect.DeepEqual(def, value) {
		_, err := d.Unset(key)
		return err
	}
	return d.SetAny(key, value)
}

func lookupDefault(defaults map[string]any, key string) (any, bool) {
	var current any = defaults
	for _, part := range strings.Split(key, ".") {
		mapping, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = mapping[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func asInt(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		parsed, _ := strconv.Atoi(strings.TrimSpace(typed))
		return parsed
	default:
		return 0
	}
}

// localSTTModels mirrors the model-size list from the 13 → 14 transform.
var localSTTModels = map[string]bool{
	"tiny.en": true, "tiny": true, "base.en": true, "base": true,
	"small.en": true, "small": true, "medium.en": true, "medium": true,
	"large-v1": true, "large-v2": true, "large-v3": true, "large": true,
	"distil-large-v2": true, "distil-medium.en": true, "distil-small.en": true,
	"distil-large-v3": true, "distil-large-v3.5": true, "large-v3-turbo": true,
	"turbo": true,
}

// discoverUserPlugins lists $ALICE_HOME/plugins/*/plugin.yaml|yml names,
// skipping disabled ones (the 20 → 21 grandfathering rule).
func discoverUserPlugins(dir string, disabled map[string]bool) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifestPath := filepath.Join(dir, entry.Name(), "plugin.yaml")
		if _, err := os.Stat(manifestPath); err != nil {
			manifestPath = filepath.Join(dir, entry.Name(), "plugin.yml")
			if _, err := os.Stat(manifestPath); err != nil {
				continue
			}
		}
		name := entry.Name()
		if data, err := os.ReadFile(manifestPath); err == nil {
			var manifest map[string]any
			if yaml.Unmarshal(data, &manifest) == nil && stringValue(manifest["name"]) != "" {
				name = stringValue(manifest["name"])
			}
		}
		if disabled[name] {
			continue
		}
		names = append(names, name)
	}
	return names
}

func isFalsey(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "false", "0", "no":
		return true
	default:
		return false
	}
}
