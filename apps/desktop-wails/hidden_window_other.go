//go:build !windows

package main

import "os/exec"

// setChildHiddenWindow is a no-op on POSIX: children of a GUI process don't
// allocate terminal windows there.
func setChildHiddenWindow(*exec.Cmd) {}
