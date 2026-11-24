package config

import (
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

// coerce mirrors alice_cli.config.set_config_value's conversion rules:
// true/yes/on and false/no/off become booleans, all-digit strings become ints,
// a single decimal point with digits becomes a float, everything else stays a
// string. Negative numbers intentionally stay strings — Python uses isdigit().
func coerce(raw string) *yaml.Node {
	switch lower := strings.ToLower(raw); {
	case lower == "true" || lower == "yes" || lower == "on":
		return scalar("!!bool", "true")
	case lower == "false" || lower == "no" || lower == "off":
		return scalar("!!bool", "false")
	case isDigits(raw):
		return scalar("!!int", raw)
	case isFloatLike(raw):
		return scalar("!!float", raw)
	default:
		return scalar("!!str", raw)
	}
}

func scalar(tag, value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: tag, Value: value}
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

func isFloatLike(s string) bool {
	return isDigits(strings.Replace(s, ".", "", 1))
}
