//go:build !windows

package host

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
)

type posixRunner struct{}

func defaultRunner() Runner { return posixRunner{} }

func (posixRunner) Run(argv []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if len(argv) == 0 {
		return 127, errors.New("empty argv")
	}
	path, err := exec.LookPath(argv[0])
	if err != nil {
		return 127, err
	}
	// When the host owns the real stdio, exec in place: the child inherits the
	// terminal, the signal handlers and the exit status with zero glue code.
	// Any other sink (tests, embedding) falls through to a normal child.
	if stdin == os.Stdin && stdout == os.Stdout && stderr == os.Stderr {
		return 0, syscall.Exec(path, argv, os.Environ())
	}
	cmd := exec.Command(path, argv[1:]...)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return wait(cmd)
}
