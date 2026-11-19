package main

import "strings"

// buildVersion is the version stamped at link time by build.ps1 / CI:
//
//	go build -ldflags "-X main.buildVersion=0.24.0"
//
// It is the authoritative identity of the *shell* being run. Reading the
// version from disk instead (alice_cli/__init__.py) reported whatever checkout
// the app happened to resolve — an installer install next to an older CLI
// profile showed 0.23.4 forever, which made every Windows update look like it
// had not applied and kept re-offering the same release.
var buildVersion = ""

// normalizedBuildVersion returns the stamped version without a leading "v".
func normalizedBuildVersion() string {
	return strings.TrimPrefix(strings.TrimSpace(buildVersion), "v")
}
