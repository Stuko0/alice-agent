//go:build dev

package main

// `go build -tags dev` (and `wails build -tags dev`) enables the inspector.
const browserDevtoolsDefault = true
