package config

import "strings"

// secretLeafNames mirrors alice_cli.config._SECRET_CONFIG_KEYS: leaf names
// whose values must never be echoed or dumped in clear text.
var secretLeafNames = map[string]bool{
	"api_key": true, "apikey": true, "key": true, "token": true,
	"access_token": true, "refresh_token": true, "id_token": true,
	"secret": true, "client_secret": true, "password": true,
}

// IsSecretLeaf reports whether the key's last path segment is credential-shaped.
func IsSecretLeaf(key string) bool {
	leaf := key
	if idx := strings.LastIndex(key, "."); idx >= 0 {
		leaf = key[idx+1:]
	}
	return secretLeafNames[strings.ToLower(leaf)]
}

// MaskValue masks a credential-shaped value, leaving other values untouched.
func MaskValue(key, value string) string {
	if !IsSecretLeaf(key) || value == "" {
		return value
	}
	if len(value) <= 8 {
		return "***"
	}
	return value[:4] + "..." + value[len(value)-4:]
}

// MaskTree returns a deep copy with credential-shaped leaves masked.
func MaskTree(node map[string]any) map[string]any {
	out := make(map[string]any, len(node))
	for key, value := range node {
		switch typed := value.(type) {
		case map[string]any:
			out[key] = MaskTree(typed)
		case []any:
			out[key] = maskSlice(typed, key)
		case string:
			out[key] = MaskValue(key, typed)
		default:
			out[key] = value
		}
	}
	return out
}

func maskSlice(items []any, key string) []any {
	out := make([]any, len(items))
	for i, item := range items {
		switch typed := item.(type) {
		case map[string]any:
			out[i] = MaskTree(typed)
		case string:
			out[i] = MaskValue(key, typed)
		default:
			out[i] = item
		}
	}
	return out
}
