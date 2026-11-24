// Command alice is the Go host for Alice Agent.
//
// It is the first rung of the "Option C" migration: the binary owns process
// startup, path/runtime resolution and (progressively) the operational
// subcommands, while the agent loop and the gateway keep running in Python.
//
// Everything the host does not implement natively is delegated verbatim to
// `python -m alice_cli.main`, so the observable behaviour of `alice` is
// unchanged until a subcommand is ported on purpose.
package main

import (
	"os"

	"github.com/Stuko0/alice-agent/go/internal/host"
)

// Injected at build time via -ldflags.
var (
	version   = "0.1.0-dev"
	commit    = "unknown"
	buildDate = "unknown"
)

func main() {
	// Marker for the Python side (and for bug reports) so a running process
	// can tell whether it was launched by the Go host.
	if os.Getenv("ALICE_HOST") == "" {
		_ = os.Setenv("ALICE_HOST", "go")
	}

	os.Exit(host.Main(host.Options{
		Args:      os.Args[1:],
		Version:   version,
		Commit:    commit,
		BuildDate: buildDate,
		Stdin:     os.Stdin,
		Stdout:    os.Stdout,
		Stderr:    os.Stderr,
	}))
}
