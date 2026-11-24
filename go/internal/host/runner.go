package host

import (
	"errors"
	"os/exec"
)

// wait runs cmd and converts an *exec.ExitError into a plain exit code so
// callers do not have to distinguish "failed to start" from "started and
// exited non-zero".
func wait(cmd *exec.Cmd) (int, error) {
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return 127, err
}
