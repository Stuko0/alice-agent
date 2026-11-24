package config

import "strings"

// normalizeForSave mirrors the normalisation save_config applies before every
// write: agent section exists, root max_turns moves under agent, and stale
// root/model aliases canonicalise into model.*. Without it the migrated file
// differs from Python's in shape.
func (d *Document) normalizeForSave() {
	if _, ok := d.Get("agent"); !ok {
		_ = d.SetAny("agent", map[string]any{})
	}

	if root, ok := d.Get("max_turns"); ok {
		if _, has := d.Get("agent.max_turns"); !has {
			_ = d.SetAny("agent.max_turns", root)
		}
		_, _ = d.Unset("max_turns")
	}

	if raw, ok := d.Get("model"); ok {
		if text, isString := raw.(string); isString {
			if strings.TrimSpace(text) != "" {
				_ = d.SetAny("model", map[string]any{"default": text})
			} else {
				_ = d.SetAny("model", map[string]any{})
			}
		}
	}

	rawModel, _ := d.Get("model")
	model, _ := rawModel.(map[string]any)
	if model == nil {
		model = map[string]any{}
	}
	changed := false

	for _, key := range []string{"provider", "base_url", "context_length"} {
		rootValue, ok := d.Get(key)
		if !ok || !truthy(rootValue) {
			continue
		}
		if !truthy(model[key]) {
			model[key] = rootValue
			changed = true
		}
		_, _ = d.Unset(key)
	}

	if rootValue, ok := d.Get("api_base"); ok && truthy(rootValue) {
		if !truthy(model["base_url"]) {
			model["base_url"] = rootValue
			changed = true
		}
		_, _ = d.Unset("api_base")
	}
	if aliasValue, ok := model["api_base"]; ok && truthy(aliasValue) {
		if !truthy(model["base_url"]) {
			model["base_url"] = aliasValue
			changed = true
		}
		delete(model, "api_base")
		changed = true
	}

	if !truthy(model["default"]) {
		alias := model["model"]
		if !truthy(alias) {
			alias = model["name"]
		}
		if truthy(alias) {
			model["default"] = alias
			changed = true
		}
	}
	if truthy(model["default"]) {
		if _, ok := model["model"]; ok {
			delete(model, "model")
			changed = true
		}
		if _, ok := model["name"]; ok {
			delete(model, "name")
			changed = true
		}
	}

	if changed {
		_ = d.SetAny("model", model)
	}
}

func truthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(typed) != ""
	case bool:
		return typed
	case int:
		return typed != 0
	case int64:
		return typed != 0
	case float64:
		return typed != 0
	case map[string]any:
		return len(typed) > 0
	case []any:
		return len(typed) > 0
	default:
		return true
	}
}
