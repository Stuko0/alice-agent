package host

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Stuko0/alice-agent/go/internal/supervisor"
)

// hostSupervise keeps a child process alive: the Go host's side of "Python is
// supervised, not launched by hand".
func hostSupervise(opts Options, args []string) int {
	const usage = "usage: alice host supervise [--max-restarts N] [--backoff-max 30s] -- <command...>"

	maxRestarts := 5
	backoffMax := 30 * time.Second

	sep := -1
	for i, arg := range args {
		if arg == "--" {
			sep = i
			break
		}
	}
	if sep < 0 || sep+1 >= len(args) {
		fmt.Fprintln(opts.Stderr, usage)
		return 2
	}

	for i := 0; i < sep; i++ {
		arg := args[i]
		switch {
		case arg == "--max-restarts":
			if i+1 >= sep {
				fmt.Fprintln(opts.Stderr, "alice host supervise: --max-restarts requires a value")
				return 2
			}
			n, err := strconv.Atoi(args[i+1])
			if err != nil || n < 0 {
				fmt.Fprintf(opts.Stderr, "alice host supervise: invalid --max-restarts %q\n", args[i+1])
				return 2
			}
			maxRestarts = n
			i++

		case strings.HasPrefix(arg, "--max-restarts="):
			n, err := strconv.Atoi(strings.TrimPrefix(arg, "--max-restarts="))
			if err != nil || n < 0 {
				fmt.Fprintf(opts.Stderr, "alice host supervise: invalid --max-restarts %q\n", arg)
				return 2
			}
			maxRestarts = n

		case arg == "--backoff-max":
			if i+1 >= sep {
				fmt.Fprintln(opts.Stderr, "alice host supervise: --backoff-max requires a duration")
				return 2
			}
			d, err := time.ParseDuration(args[i+1])
			if err != nil || d <= 0 {
				fmt.Fprintf(opts.Stderr, "alice host supervise: invalid --backoff-max %q\n", args[i+1])
				return 2
			}
			backoffMax = d
			i++

		case strings.HasPrefix(arg, "--backoff-max="):
			d, err := time.ParseDuration(strings.TrimPrefix(arg, "--backoff-max="))
			if err != nil || d <= 0 {
				fmt.Fprintf(opts.Stderr, "alice host supervise: invalid --backoff-max %q\n", arg)
				return 2
			}
			backoffMax = d

		default:
			fmt.Fprintf(opts.Stderr, "alice host supervise: unknown flag %q\n", arg)
			return 2
		}
	}

	command := args[sep+1:]

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	result := supervisor.Run(ctx, supervisor.Spec{
		Name:        command[0],
		Args:        command[1:],
		Env:         os.Environ(),
		Stdout:      opts.Stdout,
		Stderr:      opts.Stderr,
		MaxRestarts: maxRestarts,
		BackoffMax:  backoffMax,
	})

	if result.Err != nil {
		fmt.Fprintf(opts.Stderr, "alice host supervise: %v\n", result.Err)
		return 1
	}
	return result.LastExit
}
