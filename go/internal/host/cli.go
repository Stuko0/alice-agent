package host

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Stuko0/alice-agent/go/internal/cli"
)

const cliUsage = `usage: alice cli [--resume ID] [--model NAME] [--cwd DIR] [--plain]

Launches the Go classic CLI against the Python backend.
  --resume ID    resume a session (id, unique prefix or title)
  --model NAME   model override for a new session
  --cwd DIR      session working directory (default: current directory)
  --plain        line mode (no full-screen UI)`

func runCLI(opts Options, args []string) int {
	cliOpts := cli.Options{
		In:  opts.Stdin,
		Out: opts.Stdout,
		Err: opts.Stderr,
	}

	for i := 0; i < len(args); i++ {
		arg := args[i]
		takeValue := func(flag string) (string, bool) {
			if i+1 >= len(args) {
				fmt.Fprintf(opts.Stderr, "alice cli: %s requires a value\n", flag)
				return "", false
			}
			i++
			return args[i], true
		}

		switch {
		case arg == "--help" || arg == "-h":
			fmt.Fprintln(opts.Stdout, cliUsage)
			return 0

		case arg == "--plain":
			cliOpts.Plain = true

		case arg == "--resume" || arg == "-r":
			value, ok := takeValue(arg)
			if !ok {
				return 2
			}
			cliOpts.Resume = value

		case strings.HasPrefix(arg, "--resume="):
			cliOpts.Resume = strings.TrimPrefix(arg, "--resume=")

		case arg == "--model" || arg == "-m":
			value, ok := takeValue(arg)
			if !ok {
				return 2
			}
			cliOpts.Model = value

		case strings.HasPrefix(arg, "--model="):
			cliOpts.Model = strings.TrimPrefix(arg, "--model=")

		case arg == "--cwd":
			value, ok := takeValue(arg)
			if !ok {
				return 2
			}
			cliOpts.Cwd = value

		case strings.HasPrefix(arg, "--cwd="):
			cliOpts.Cwd = strings.TrimPrefix(arg, "--cwd=")

		default:
			fmt.Fprintf(opts.Stderr, "alice cli: unknown argument %q\n", arg)
			return 2
		}
	}

	rt, err := opts.Resolver.Python()
	if err != nil {
		fmt.Fprintf(opts.Stderr, "alice: %v\n", err)
		return 127
	}
	home, _ := opts.Resolver.Home()

	cliOpts.Python = rt.Python
	cliOpts.Dir = opts.Resolver.CheckoutRoot(rt)
	cliOpts.Env = mergeEnv(os.Environ(),
		"ALICE_HOME="+home,
		"ALICE_HOST=go",
	)

	// Bubbletea owns Ctrl+C in the TUI, so only SIGTERM is a process signal.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()

	if err := cli.Run(ctx, cliOpts); err != nil {
		fmt.Fprintf(opts.Stderr, "alice cli: %v\n", err)
		return 1
	}
	return 0
}
