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

// buildCommit / buildTime identify the exact build, stamped the same way:
//
//	-X main.buildCommit=abc1234 -X main.buildTime=2026-11-19T06:54:34Z
//
// The version alone was not enough while iterating on a release: every
// republish of v0.24.0 looked identical in About, so "the installer doesn't
// have the new UI" could not be settled without guessing.
var (
	buildCommit = ""
	buildTime   = ""
)

// normalizedBuildVersion returns the stamped version without a leading "v".
func normalizedBuildVersion() string {
	return strings.TrimPrefix(strings.TrimSpace(buildVersion), "v")
}

// normalizedBuildCommit returns the short commit hash, or "" for dev builds.
func normalizedBuildCommit() string {
	return strings.TrimSpace(buildCommit)
}

// normalizedBuildTime returns the stamped UTC build time, or "".
func normalizedBuildTime() string {
	return strings.TrimSpace(buildTime)
}
