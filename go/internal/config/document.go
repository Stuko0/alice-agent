// Package config edits Alice's config.yaml in place.
//
// It parses into a yaml.Node tree so comments, key order and quoting style
// survive a read-modify-write cycle — the property that makes it safe to port
// `alice config set` away from the Python (ruamel) implementation.
//
// Only the user file is touched. The merged defaults, migrations and managed
// overlay remain Python's job until those cores are ported.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Document is a parsed config.yaml.
type Document struct {
	path string
	root *yaml.Node
}

// Load parses path. A missing or empty file yields an empty mapping.
func Load(path string) (*Document, error) {
	doc := &Document{path: path}

	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		doc.root = newDocument()
		return doc, nil
	}
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(data)) == 0 {
		doc.root = newDocument()
		return doc, nil
	}

	var parsed yaml.Node
	if err := yaml.Unmarshal(data, &parsed); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if mappingNode(&parsed) == nil {
		return nil, fmt.Errorf("%s: root must be a mapping", path)
	}

	doc.root = &parsed
	return doc, nil
}

// Path is the file being edited.
func (d *Document) Path() string { return d.path }

// Bytes renders the document with two-space indentation.
func (d *Document) Bytes() ([]byte, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(d.root); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Save writes the document atomically, preserving the file mode (0600 for a
// new file).
func (d *Document) Save() error {
	data, err := d.Bytes()
	if err != nil {
		return err
	}
	return atomicWrite(d.path, data)
}

// Get returns the decoded value at a dotted key, including numeric list
// indices ("custom_providers.0.api_key").
func (d *Document) Get(key string) (any, bool) {
	parts, err := splitPath(key)
	if err != nil {
		return nil, false
	}

	node := d.mapping()
	for _, part := range parts {
		next, ok := childNode(node, part)
		if !ok {
			return nil, false
		}
		node = next
	}

	var value any
	if err := node.Decode(&value); err != nil {
		return nil, false
	}
	return value, true
}

// Set stores a value at a dotted key, coercing the raw string the same way
// `alice config set` does (true/yes/on, false/no/off, integers, floats).
func (d *Document) Set(key, raw string) error {
	parts, err := splitPath(key)
	if err != nil {
		return err
	}
	return setPath(d.mapping(), parts, coerce(raw))
}

// Unset removes the key (or list element) at a dotted path.
func (d *Document) Unset(key string) (bool, error) {
	parts, err := splitPath(key)
	if err != nil {
		return false, err
	}
	return unsetPath(d.mapping(), parts)
}

func (d *Document) mapping() *yaml.Node {
	if m := mappingNode(d.root); m != nil {
		return m
	}
	d.root = newDocument()
	return d.root.Content[0]
}

func newDocument() *yaml.Node {
	return &yaml.Node{
		Kind: yaml.DocumentNode,
		Content: []*yaml.Node{{
			Kind: yaml.MappingNode,
			Tag:  "!!map",
		}},
	}
}

func mappingNode(node *yaml.Node) *yaml.Node {
	if node == nil {
		return nil
	}
	if node.Kind == yaml.DocumentNode {
		if len(node.Content) != 1 {
			return nil
		}
		node = node.Content[0]
	}
	if node.Kind != yaml.MappingNode {
		return nil
	}
	return node
}

// Map decodes the document into a plain map (comments are not part of the
// value). A malformed tree yields an empty map.
func (d *Document) Map() map[string]any {
	var out map[string]any
	if err := d.mapping().Decode(&out); err != nil || out == nil {
		return map[string]any{}
	}
	return out
}

// RawVersion reads the on-disk `_config_version` (0 when absent).
func (d *Document) RawVersion() int {
	value, ok := d.Get("_config_version")
	if !ok {
		return 0
	}
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		n := 0
		for _, r := range typed {
			if r < '0' || r > '9' {
				return 0
			}
			n = n*10 + int(r-'0')
		}
		return n
	default:
		return 0
	}
}
