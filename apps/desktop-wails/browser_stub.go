//go:build !linux || !cgo

package main

// Non-GTK builds (and CGO-disabled builds) keep the API surface but report the
// native browser as unavailable, so the renderer can fall back to a plain
// iframe without conditionals everywhere.

func gtkBrowserPost(op, a, b, c, d int, s string) {}

func gtkBrowserPostZoom(zoom float64) {}

func gtkBrowserReady() bool { return false }
