package config

import (
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

func splitPath(key string) ([]string, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return nil, fmt.Errorf("empty key")
	}
	parts := strings.Split(key, ".")
	for _, part := range parts {
		if part == "" {
			return nil, fmt.Errorf("invalid key %q", key)
		}
	}
	return parts, nil
}

// childNode resolves one path segment.
func childNode(node *yaml.Node, part string) (*yaml.Node, bool) {
	switch node.Kind {
	case yaml.MappingNode:
		value, _ := mappingChild(node, part)
		return value, value != nil
	case yaml.SequenceNode:
		idx, err := strconv.Atoi(part)
		if err != nil || idx < 0 || idx >= len(node.Content) {
			return nil, false
		}
		return node.Content[idx], true
	default:
		return nil, false
	}
}

// mappingChild finds a key in a mapping node. yaml mappings store
// [key, value, key, value, ...] in Content.
func mappingChild(mapping *yaml.Node, key string) (*yaml.Node, int) {
	for i := 0; i+1 < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			return mapping.Content[i+1], i
		}
	}
	return nil, -1
}

func keyNode(key string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
}

func setPath(root *yaml.Node, parts []string, value *yaml.Node) error {
	current := root

	for i, part := range parts {
		last := i == len(parts)-1

		switch current.Kind {
		case yaml.MappingNode:
			child, idx := mappingChild(current, part)

			if last {
				if idx >= 0 {
					replaceValue(current.Content[idx+1], value)
				} else {
					current.Content = append(current.Content, keyNode(part), value)
				}
				return nil
			}

			if child == nil || (child.Kind != yaml.MappingNode && child.Kind != yaml.SequenceNode) {
				// Missing or scalar: replace with a mapping so the write can
				// proceed (same rule as Python's _set_nested). Lists are kept.
				fresh := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
				if idx >= 0 {
					replaceValue(current.Content[idx+1], fresh)
					// replaceValue copies into the existing node; continue from
					// the node that is actually in the tree.
					child = current.Content[idx+1]
				} else {
					current.Content = append(current.Content, keyNode(part), fresh)
					child = fresh
				}
			}
			current = child

		case yaml.SequenceNode:
			idx, err := strconv.Atoi(part)
			if err != nil || idx < 0 || idx >= len(current.Content) {
				return fmt.Errorf("cannot navigate into list at %q: %q is not a valid index", strings.Join(parts, "."), part)
			}
			if last {
				replaceValue(current.Content[idx], value)
				return nil
			}
			next := current.Content[idx]
			if next.Kind != yaml.MappingNode && next.Kind != yaml.SequenceNode {
				return fmt.Errorf("cannot navigate into a scalar at %q", strings.Join(parts, "."))
			}
			current = next

		default:
			return fmt.Errorf("cannot navigate into a %s at %q", kindName(current.Kind), strings.Join(parts, "."))
		}
	}
	return nil
}

type pathLevel struct {
	mapping *yaml.Node
	keyIdx  int
}

func unsetPath(root *yaml.Node, parts []string) (bool, error) {
	var chain []pathLevel

	current := root

	for i, part := range parts {
		last := i == len(parts)-1

		switch current.Kind {
		case yaml.MappingNode:
			_, idx := mappingChild(current, part)
			if idx < 0 {
				return false, nil
			}
			if last {
				current.Content = append(current.Content[:idx], current.Content[idx+2:]...)
				pruneEmptyAncestors(chain)
				return true, nil
			}
			child, _ := mappingChild(current, part)
			if child == nil {
				return false, nil
			}
			chain = append(chain, pathLevel{mapping: current, keyIdx: idx})
			current = child

		case yaml.SequenceNode:
			idx, err := strconv.Atoi(part)
			if err != nil || idx < 0 || idx >= len(current.Content) {
				return false, nil
			}
			if last {
				current.Content = append(current.Content[:idx], current.Content[idx+1:]...)
				return true, nil
			}
			current = current.Content[idx]

		default:
			return false, nil
		}
	}
	return false, nil
}

// pruneEmptyAncestors removes mappings left empty by an unset, walking back up
// the path that was traversed. Unrelated empty mappings are left alone.
func pruneEmptyAncestors(chain []pathLevel) {
	for j := len(chain) - 1; j >= 0; j-- {
		lvl := chain[j]
		if lvl.keyIdx+1 >= len(lvl.mapping.Content) {
			return
		}
		child := lvl.mapping.Content[lvl.keyIdx+1]
		if child.Kind != yaml.MappingNode || len(child.Content) != 0 {
			return
		}
		lvl.mapping.Content = append(lvl.mapping.Content[:lvl.keyIdx], lvl.mapping.Content[lvl.keyIdx+2:]...)
	}
}

// replaceValue swaps a node's payload while keeping the comments and the
// scalar quoting style of the node it replaces.
func replaceValue(old, next *yaml.Node) {
	next.HeadComment = old.HeadComment
	next.LineComment = old.LineComment
	next.FootComment = old.FootComment
	if old.Kind == yaml.ScalarNode && next.Kind == yaml.ScalarNode {
		next.Style = old.Style
	}
	*old = *next
}

func kindName(kind yaml.Kind) string {
	switch kind {
	case yaml.MappingNode:
		return "mapping"
	case yaml.SequenceNode:
		return "list"
	case yaml.ScalarNode:
		return "scalar"
	default:
		return "node"
	}
}
