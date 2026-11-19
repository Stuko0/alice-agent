//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

const (
	// CREATE_NEW_CONSOLE: allocate a console for the child and its own
	// children. Combined with HideWindow the console exists but is invisible,
	// so grandchildren (python → subprocesses) inherit it instead of each
	// allocating a fresh, VISIBLE console.
	//
	// (createNoWindow lives in relaunch_windows.go.)
	createNewConsole = 0x00000010
)

// setChildHiddenWindow is for long-lived backends that spawn their own
// children (the Python agent, which shells out to git/pip/terminals).
//
// CREATE_NO_WINDOW alone hides the direct child, but a console-app grandchild
// of a console-less process allocates its OWN console — on Win11 that is the
// "terminal flashes open and closes" storm users see when the agent shells out.
// A hidden NEW console is inherited by every descendant, so nothing flashes.
func setChildHiddenWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNewConsole,
	}
}

// hideChildConsole is for short-lived helpers the GUI shell runs itself (git,
// version probes, update scripts). They never spawn children, so the cheaper
// CREATE_NO_WINDOW (no console allocation at all) is the right tool: a console
// flash per git probe is exactly the flicker this prevents.
func hideChildConsole(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}
