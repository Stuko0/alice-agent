package main

import "os"

// browserDevtoolsEnabled is the single switch the service reads: a dev build,
// or an explicit env override for ad-hoc debugging of a release binary.
func browserDevtoolsEnabled() bool {
	return browserDevtoolsDefault || os.Getenv("ALICE_BROWSER_DEVTOOLS") == "1"
}
