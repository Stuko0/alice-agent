//go:build dev

package main

import "testing"

// The `dev` tag is the only build-time way to turn the inspector on; this test
// exists so `go test -tags dev` proves the flag actually flips.
func TestBrowserDevtoolsOnWithDevTag(t *testing.T) {
	if !browserDevtoolsEnabled() {
		t.Fatal("the dev build tag must enable developer extras")
	}
}
