//go:build windows

package host

import (
	"errors"
	"io"
	"os/exec"
)

type windowsRunner struct{}

func defaultRunner() Runner { return windowsRunner{} }

// Windows has no exec(2) equivalent, so the host stays alive as the parent.
// Ctrl-C reaches the child through the shared console process group.
func (windowsRunner) Run(argv []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if len(argv) == 0 {
		return 127, errors.New("empty argv")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return wait(cmd)
}
