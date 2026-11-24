package config

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"sync"
)

// schema.json is generated from the Python config module by
// scripts/gen_go_config_schema.py. `go test ./internal/config -run SchemaFreshness`
// (opt-in) fails when it is stale.
//
//go:embed schema.json
var schemaJSON []byte

// EnvVar is one entry of Python's OPTIONAL_ENV_VARS metadata.
type EnvVar struct {
	Name        string   `yaml:"name" json:"name"`
	Description string   `yaml:"description" json:"description"`
	Tools       []string `yaml:"tools" json:"tools"`
	Advanced    bool     `yaml:"advanced" json:"advanced"`
	Category    string   `yaml:"category" json:"category"`
}

type schema struct {
	ConfigVersion int            `yaml:"config_version" json:"config_version"`
	Defaults      map[string]any `yaml:"defaults" json:"defaults"`
	OptionalEnv   []EnvVar       `yaml:"optional_env" json:"optional_env"`
	ExtraEnvKeys  []string       `yaml:"extra_env_keys" json:"extra_env_keys"`
}

var (
	schemaOnce sync.Once
	schemaData schema
	schemaErr  error
)

func loadSchema() (schema, error) {
	schemaOnce.Do(func() {
		dec := json.NewDecoder(bytes.NewReader(schemaJSON))
		// Keep integers as integers; the default JSON decoder would turn
		// every number into a float64.
		dec.UseNumber()
		if err := dec.Decode(&schemaData); err != nil {
			schemaErr = err
			return
		}
		schemaData.Defaults = normalizeNumbers(schemaData.Defaults).(map[string]any)
	})
	return schemaData, schemaErr
}

func normalizeNumbers(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for key, item := range typed {
			typed[key] = normalizeNumbers(item)
		}
		return typed
	case []any:
		for i, item := range typed {
			typed[i] = normalizeNumbers(item)
		}
		return typed
	case json.Number:
		if asInt, err := typed.Int64(); err == nil {
			return int(asInt)
		}
		if asFloat, err := typed.Float64(); err == nil {
			return asFloat
		}
		return typed.String()
	default:
		return value
	}
}

// LatestVersion is the `_config_version` of the embedded defaults.
func LatestVersion() (int, error) {
	s, err := loadSchema()
	return s.ConfigVersion, err
}

// Defaults returns a deep copy of DEFAULT_CONFIG.
func Defaults() (map[string]any, error) {
	s, err := loadSchema()
	if err != nil {
		return nil, err
	}
	return cloneMap(s.Defaults), nil
}

// OptionalEnv returns the optional environment-variable metadata.
func OptionalEnv() ([]EnvVar, error) {
	s, err := loadSchema()
	return s.OptionalEnv, err
}

// ExtraEnvKeys are the non-user-facing env names .env sanitisation must also
// recognize (alice_cli.config._EXTRA_ENV_KEYS).
func ExtraEnvKeys() ([]string, error) {
	s, err := loadSchema()
	return s.ExtraEnvKeys, err
}

// KnownEnvKeys is OPTIONAL_ENV_VARS ∪ _EXTRA_ENV_KEYS.
func KnownEnvKeys() (map[string]bool, error) {
	s, err := loadSchema()
	if err != nil {
		return nil, err
	}
	keys := make(map[string]bool, len(s.OptionalEnv)+len(s.ExtraEnvKeys))
	for _, variable := range s.OptionalEnv {
		keys[variable.Name] = true
	}
	for _, key := range s.ExtraEnvKeys {
		keys[key] = true
	}
	return keys, nil
}
