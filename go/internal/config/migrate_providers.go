package config

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

var placeholderToken = regexp.MustCompile(`\{[^}]+\}`)

var camelAliases = map[string]string{
	"apiKey":         "api_key",
	"baseUrl":        "base_url",
	"apiMode":        "api_mode",
	"keyEnv":         "key_env",
	"apiKeyEnv":      "key_env",
	"defaultModel":   "default_model",
	"contextLength":  "context_length",
	"rateLimitDelay": "rate_limit_delay",
}

// migrateCustomProviders ports `_normalize_custom_provider_entry` +
// `_custom_provider_entry_to_provider_config` for the 11 → 12 transform.
func (d *Document) migrateCustomProviders() []string {
	raw, ok := d.Get("custom_providers")
	if !ok {
		return nil
	}
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return nil
	}

	existing := map[string]any{}
	if value, ok := d.Get("providers"); ok {
		if mapping, isMap := value.(map[string]any); isMap {
			existing = mapping
		}
	}

	migrated := 0
	for _, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		oldName := stringValue(entry["name"])
		oldURL := firstString(entry, "base_url", "url", "api")
		if strings.TrimSpace(oldURL) == "" {
			continue
		}

		key := providerKey(oldName, oldURL, migrated)
		baseKey := key
		suffix := migrated
		for {
			if _, exists := existing[key]; !exists {
				break
			}
			key = fmt.Sprintf("%s-%d", baseKey, suffix)
			suffix++
		}

		normalized := normalizeCustomProvider(entry, key)
		if normalized == nil {
			continue
		}

		providerEntry := customProviderToProviderConfig(normalized)
		if strings.TrimSpace(oldName) == "" {
			delete(providerEntry, "name")
		}
		if apiKey, _ := providerEntry["api_key"].(string); apiKey == "no-key" || apiKey == "no-key-required" || apiKey == "" {
			delete(providerEntry, "api_key")
		}

		existing[key] = providerEntry
		migrated++
	}

	if migrated == 0 {
		return nil
	}
	_ = d.SetAny("providers", existing)
	_, _ = d.Unset("custom_providers")
	return []string{fmt.Sprintf("custom_providers → providers (%d)", migrated)}
}

func normalizeCustomProvider(entry map[string]any, providerKey string) map[string]any {
	normalizedEntry := make(map[string]any, len(entry))
	for key, value := range entry {
		normalizedEntry[key] = value
	}

	if _, hasKeyEnv := normalizedEntry["key_env"]; !hasKeyEnv {
		if value, ok := normalizedEntry["api_key_env"]; ok {
			normalizedEntry["key_env"] = value
		}
	}
	for camel, snake := range camelAliases {
		if value, ok := normalizedEntry[camel]; ok {
			if _, hasSnake := normalizedEntry[snake]; !hasSnake {
				normalizedEntry[snake] = value
			}
		}
	}

	baseURL := ""
	for _, key := range []string{"base_url", "url", "api"} {
		raw := strings.TrimSpace(stringValue(normalizedEntry[key]))
		if raw == "" {
			continue
		}
		candidate := stripEndpointPath(raw)
		if placeholderToken.MatchString(candidate) || validURL(candidate) {
			baseURL = candidate
			break
		}
	}
	if baseURL == "" {
		return nil
	}

	name := strings.TrimSpace(stringValue(normalizedEntry["name"]))
	if name == "" {
		name = strings.TrimSpace(providerKey)
	}
	if name == "" {
		return nil
	}

	out := map[string]any{"name": name, "base_url": baseURL}
	if key := strings.TrimSpace(providerKey); key != "" {
		out["provider_key"] = key
	}
	copyString(out, normalizedEntry, "api_key", "api_key")
	copyString(out, normalizedEntry, "key_env", "key_env")

	apiMode := stringValue(normalizedEntry["api_mode"])
	if apiMode == "" {
		apiMode = stringValue(normalizedEntry["transport"])
	}
	if mode := strings.TrimSpace(apiMode); mode != "" {
		out["api_mode"] = mode
	}

	modelName := stringValue(normalizedEntry["model"])
	if modelName == "" {
		modelName = stringValue(normalizedEntry["default_model"])
	}
	if model := strings.TrimSpace(modelName); model != "" {
		out["model"] = model
	}

	switch models := normalizedEntry["models"].(type) {
	case map[string]any:
		if len(models) > 0 {
			out["models"] = models
		}
	case []any:
		converted := map[string]any{}
		for _, item := range models {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				converted[text] = map[string]any{}
			}
		}
		if len(converted) > 0 {
			out["models"] = converted
		}
	}

	if length := asInt(normalizedEntry["context_length"]); length > 0 {
		out["context_length"] = length
	}
	if delay, ok := asNonNegativeNumber(normalizedEntry["rate_limit_delay"]); ok {
		out["rate_limit_delay"] = delay
	}
	if discover, ok := normalizedEntry["discover_models"].(bool); ok {
		out["discover_models"] = discover
	}
	if extra, ok := normalizedEntry["extra_body"].(map[string]any); ok {
		out["extra_body"] = extra
	}

	return out
}

func customProviderToProviderConfig(normalized map[string]any) map[string]any {
	entry := map[string]any{"api": normalized["base_url"]}
	for _, field := range []string{
		"name", "api_key", "key_env", "models", "context_length",
		"rate_limit_delay", "discover_models", "extra_body",
	} {
		if value, ok := normalized[field]; ok {
			entry[field] = value
		}
	}
	if value, ok := normalized["model"]; ok {
		entry["default_model"] = value
	}
	if value, ok := normalized["api_mode"]; ok {
		entry["transport"] = value
	}
	return entry
}

func providerKey(name, rawURL string, migrated int) string {
	key := strings.ToLower(strings.TrimSpace(name))
	key = strings.ReplaceAll(key, " ", "-")
	key = strings.ReplaceAll(key, "(", "")
	key = strings.ReplaceAll(key, ")", "")
	for strings.Contains(key, "--") {
		key = strings.ReplaceAll(key, "--", "-")
	}
	key = strings.Trim(key, "-")
	if key != "" {
		return key
	}

	if parsed, err := url.Parse(rawURL); err == nil && parsed.Hostname() != "" {
		return strings.ReplaceAll(parsed.Hostname(), ".", "-")
	}
	return fmt.Sprintf("endpoint-%d", migrated)
}

func stripEndpointPath(raw string) string {
	value := strings.TrimSpace(raw)
	lower := strings.ToLower(value)
	for _, suffix := range []string{"/chat/completions", "/completions"} {
		if strings.HasSuffix(lower, suffix) {
			return strings.TrimRight(value[:len(value)-len(suffix)], "/")
		}
	}
	return value
}

func validURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme != "" && parsed.Host != ""
}

func firstString(entry map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringValue(entry[key]); strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

func copyString(out, in map[string]any, from, to string) {
	if value := strings.TrimSpace(stringValue(in[from])); value != "" {
		out[to] = value
	}
}

func asNonNegativeNumber(value any) (any, bool) {
	switch typed := value.(type) {
	case int:
		return typed, typed >= 0
	case int64:
		return int(typed), typed >= 0
	case float64:
		return typed, typed >= 0
	default:
		return nil, false
	}
}
