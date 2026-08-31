//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// spawnDetached launches the watcher in a new session so it survives the app
// process exiting.
func spawnDetached(scriptPath string) error {
	cmd := exec.Command("/bin/bash", scriptPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Env = os.Environ()
	return cmd.Start()
}
