package config

// Merge deep-merges user on top of defaults, mirroring load_config():
// mappings merge recursively; lists and scalars replace.
func Merge(defaults, user map[string]any) map[string]any {
	out := cloneMap(defaults)
	mergeInto(out, user)
	return out
}

func mergeInto(dst, src map[string]any) {
	for key, value := range src {
		if dstMap, ok := dst[key].(map[string]any); ok {
			if srcMap, ok := value.(map[string]any); ok {
				mergeInto(dstMap, srcMap)
				continue
			}
		}
		dst[key] = deepClone(value)
	}
}

// MissingFields lists defaults keys absent from current. `_`-prefixed keys are
// skipped. Passing the merged config (like Python's check does) yields none.
func MissingFields(defaults, current map[string]any) []string {
	var missing []string
	var walk func(prefix string, defs, cur map[string]any)
	walk = func(prefix string, defs, cur map[string]any) {
		for key, value := range defs {
			if len(key) > 0 && key[0] == '_' {
				continue
			}
			full := key
			if prefix != "" {
				full = prefix + "." + key
			}
			curValue, ok := cur[key]
			if !ok {
				missing = append(missing, full)
				continue
			}
			defMap, defIsMap := value.(map[string]any)
			curMap, curIsMap := curValue.(map[string]any)
			if defIsMap && curIsMap {
				walk(full, defMap, curMap)
			}
		}
	}
	walk("", defaults, current)
	return missing
}

func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = deepClone(value)
	}
	return out
}

func deepClone(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneMap(typed)
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = deepClone(item)
		}
		return out
	default:
		return value
	}
}
