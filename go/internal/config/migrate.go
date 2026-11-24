package config

import (
	"fmt"
	"reflect"
	"strings"
)

// OldestNativeMigration is the first schema version this engine can migrate
// from. Older schemas need transforms that still live in Python (env moves,
// plugin grandfathering, MCP hardening).
const OldestNativeMigration = 28

// MigrationResult reports what a migration did.
type MigrationResult struct {
	From    int
	To      int
	Applied []string
}

// MigrateToLatest applies the natively ported transforms (28 → 32) and bumps
// `_config_version`. ok is false when the on-disk schema is too old and the
// caller must delegate to Python.
//
// Unlike Python's save_config this is a targeted edit: only the transformed
// keys and the version are touched, so comments and unrelated keys survive.
func (d *Document) MigrateToLatest() (MigrationResult, bool, error) {
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

	result := MigrationResult{From: current, To: latest}
	if current < OldestNativeMigration {
		return result, false, nil
	}
	if current >= latest {
		return result, true, nil
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
			if err := d.setOrStrip(subsystem+".write_approval", approve, defaults); err != nil {
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
			if err := d.setOrStrip("agent.verify_on_stop", false, defaults); err != nil {
				return result, true, err
			}
			result.Applied = append(result.Applied, "agent.verify_on_stop=false")
		}
	}

	// ── 31 → 32: flip a baked-in literal true to false ──
	if current < 32 {
		if value, ok := d.Get("agent.verify_on_stop"); ok {
			if flag, isBool := value.(bool); isBool && flag {
				if err := d.setOrStrip("agent.verify_on_stop", false, defaults); err != nil {
					return result, true, err
				}
				result.Applied = append(result.Applied, "agent.verify_on_stop=false")
			}
		}
	}

	if err := d.Set("_config_version", fmt.Sprint(latest)); err != nil {
		return result, true, err
	}
	if err := d.Save(); err != nil {
		return result, true, err
	}
	return result, true, nil
}

// setOrStrip writes value, or removes the key when it equals the schema
// default (save_config's "never materialise defaults" invariant).
func (d *Document) setOrStrip(key string, value any, defaults map[string]any) error {
	if def, ok := lookupDefault(defaults, key); ok && reflect.DeepEqual(def, value) {
		_, err := d.Unset(key)
		return err
	}
	return d.Set(key, scalarString(value))
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

func scalarString(value any) string {
	switch typed := value.(type) {
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case int:
		return fmt.Sprint(typed)
	case float64:
		return fmt.Sprint(typed)
	case string:
		return typed
	default:
		return fmt.Sprint(value)
	}
}
