//go:build windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

// spawnDetached launches the PowerShell watcher without a console window so it
// survives the app process exiting.
func spawnDetached(scriptPath string) error {
	cmd := exec.Command("powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}
	cmd.Env = os.Environ()
	return cmd.Start()
}
