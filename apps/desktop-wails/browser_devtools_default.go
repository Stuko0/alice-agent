//go:build !dev

package main

// Dev builds opt in with `-tags dev`; production keeps WebKit's inspector off.
const browserDevtoolsDefault = false
