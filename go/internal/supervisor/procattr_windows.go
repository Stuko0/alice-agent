//go:build windows

package supervisor

import "os/exec"

// Windows has no POSIX process groups; killing the direct child is the
// supported path. A job object would be needed to reap grandchildren, which
// the host does not own yet.
func setProcessGroup(cmd *exec.Cmd) {}

func terminate(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func kill(cmd *exec.Cmd) { terminate(cmd) }
