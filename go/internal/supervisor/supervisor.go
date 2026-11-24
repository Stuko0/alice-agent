// Package supervisor runs a long-lived child process and restarts it with
// exponential backoff when it fails.
//
// It is intentionally policy-only: no daemonization, no service manager, no
// health probes. The Go host uses it to keep the Python backend alive; tests
// drive it with a re-exec'd helper process.
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"time"
)

// Spec describes the child and the restart policy.
type Spec struct {
	Name string
	Args []string
	Env  []string
	Dir  string

	Stdout io.Writer
	Stderr io.Writer

	// MaxRestarts is the number of restarts allowed after the first exit.
	// Zero means "run once, never restart".
	MaxRestarts int
	BackoffBase time.Duration
	BackoffMax  time.Duration
}

// Result reports how the supervision ended.
type Result struct {
	Restarts int
	LastExit int
	Err      error
}

// Run supervises the child until it exits cleanly, the restart budget is
// exhausted, or ctx is cancelled.
func Run(ctx context.Context, spec Spec) Result {
	if spec.MaxRestarts < 0 {
		spec.MaxRestarts = 0
	}
	if spec.BackoffBase <= 0 {
		spec.BackoffBase = time.Second
	}
	if spec.BackoffMax <= 0 {
		spec.BackoffMax = 30 * time.Second
	}
	logw := spec.Stderr
	if logw == nil {
		logw = io.Discard
	}

	restarts := 0
	backoff := spec.BackoffBase

	for {
		cmd := exec.Command(spec.Name, spec.Args...)
		cmd.Env = spec.Env
		cmd.Dir = spec.Dir
		cmd.Stdout = spec.Stdout
		cmd.Stderr = spec.Stderr
		setProcessGroup(cmd)

		if err := cmd.Start(); err != nil {
			return Result{Restarts: restarts, Err: err}
		}

		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()

		select {
		case <-ctx.Done():
			terminate(cmd)
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				kill(cmd)
				<-done
			}
			return Result{Restarts: restarts}

		case err := <-done:
			code := exitCode(err)
			if code == 0 {
				return Result{Restarts: restarts}
			}
			if restarts >= spec.MaxRestarts {
				return Result{
					Restarts: restarts,
					LastExit: code,
					Err:      fmt.Errorf("%s exited with status %d after %d restart(s)", spec.Name, code, restarts),
				}
			}
			restarts++
			fmt.Fprintf(logw, "[supervisor] %s exited with status %d; restarting in %s (%d/%d)\n",
				spec.Name, code, backoff, restarts, spec.MaxRestarts)

			select {
			case <-time.After(backoff):
			case <-ctx.Done():
				return Result{Restarts: restarts}
			}
			backoff *= 2
			if backoff > spec.BackoffMax {
				backoff = spec.BackoffMax
			}
		}
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}
