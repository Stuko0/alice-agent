package host

import (
	"fmt"
	"io"
	"strings"
)

// GlobalArgs is the conservative pre-parse of leading flags.
//
// The host only understands enough of the global flags to route `host`
// subcommands and to resolve the profile for diagnostics. Everything else
// (unknown flags, `--args` passthrough regions, subcommand-local flags) is
// left to Python: OK is false and the caller delegates the original argv
// verbatim.
type GlobalArgs struct {
	Profile string
	// Rest starts at the first positional argument (inclusive).
	Rest []string
	// OK is false when the leading flags are not safely understood.
	OK bool
}

var valueFlags = map[string]bool{
	"-z": true, "--oneshot": true,
	"-m": true, "--model": true,
	"--provider": true,
	"-t":         true, "--toolsets": true,
	"-r": true, "--resume": true,
	"-s": true, "--skills": true,
}

var optionalValueFlags = map[string]bool{
	"-c": true, "--continue": true,
}

// ParseGlobalArgs walks the leading flags only. It stops at the first
// positional argument or at `--`.
func ParseGlobalArgs(args []string) GlobalArgs {
	g := GlobalArgs{OK: true}
	for i := 0; i < len(args); i++ {
		arg := args[i]

		if arg == "--" {
			g.Rest = args[i+1:]
			return g
		}
		if arg == "-" || !strings.HasPrefix(arg, "-") {
			g.Rest = args[i:]
			return g
		}

		switch {
		case arg == "-p" || arg == "--profile":
			if i+1 >= len(args) {
				return GlobalArgs{OK: false}
			}
			g.Profile = args[i+1]
			i++

		case strings.HasPrefix(arg, "--profile="):
			g.Profile = strings.TrimPrefix(arg, "--profile=")

		case valueFlags[arg]:
			if i+1 >= len(args) {
				return GlobalArgs{OK: false}
			}
			i++

		case optionalValueFlags[arg]:
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}

		default:
			// Unknown leading flag: Python may know it, we do not.
			return GlobalArgs{OK: false}
		}
	}
	return g
}

type hostSubcommand struct {
	name    string
	args    string
	summary string
	run     func(Options, []string) int
}

var hostSubcommands = []hostSubcommand{
	{name: "env", summary: "Print resolved ALICE_HOME, Python runtime and build info (JSON)", run: func(opts Options, _ []string) int { return hostEnv(opts) }},
	{name: "doctor", args: "[--json] [--deep]", summary: "Check the host plumbing", run: hostDoctor},
	{name: "logs", args: "[name] [-n N] [-f]", summary: "Tail an Alice log file", run: hostLogs},
	{name: "rpc", args: "<method> [json]", summary: "Call one gateway RPC and print the result", run: hostRPC},
	{name: "supervise", args: "-- <command...>", summary: "Run a child process and restart it on failure", run: hostSupervise},
}

func dispatchHost(opts Options, args []string) int {
	if len(args) == 0 {
		printHostHelp(opts.Stdout)
		return 0
	}
	switch args[0] {
	case "help", "--help", "-h":
		printHostHelp(opts.Stdout)
		return 0
	}
	for _, c := range hostSubcommands {
		if c.name == args[0] {
			return c.run(opts, args[1:])
		}
	}
	fmt.Fprintf(opts.Stderr, "alice host: unknown subcommand %q\n\n", args[0])
	printHostHelp(opts.Stderr)
	return 2
}

func printHostHelp(w io.Writer) {
	fmt.Fprint(w, "alice host — Go host operations\n\nUsage:\n  alice host <command> [args]\n\nCommands:\n")
	for _, c := range hostSubcommands {
		line := "  alice host " + c.name
		if c.args != "" {
			line += " " + c.args
		}
		fmt.Fprintf(w, "  %-46s %s\n", line, c.summary)
	}
	fmt.Fprint(w, "\nEvery other command is delegated to the Python backend unchanged.\n")
}
