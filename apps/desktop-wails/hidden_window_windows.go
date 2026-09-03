//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// setChildHiddenWindow prevents the spawned backend python from creating a
// console window. Without CREATE_NO_WINDOW, a GUI-launched exe has no console
// to inherit, so Windows allocates a NEW console for the child — observed on
// Win11 as a maximized black terminal covering the desktop app's window.
// Stdout/stderr stay piped, so the port announcement and log tee are unaffected.
func setChildHiddenWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
}
