package host

import (
	"fmt"
	"path/filepath"
)

// runConfigNative handles the `alice config` subcommands that only need the
// resolved ALICE_HOME. Everything else (show/set/edit/check/migrate) still
// belongs to the Python config core — the YAML round-trip, defaults merge,
// migrations and env routing are not safe to duplicate yet.
//
// handled=false means "delegate the original argv to Python".
func runConfigNative(opts Options, args []string) (handled bool, code int) {
	if len(args) != 1 {
		return false, 0
	}

	home, _ := opts.Resolver.Home()
	switch args[0] {
	case "path":
		fmt.Fprintln(opts.Stdout, filepath.Join(home, "config.yaml"))
		return true, 0
	case "env-path":
		fmt.Fprintln(opts.Stdout, filepath.Join(home, ".env"))
		return true, 0
	default:
		return false, 0
	}
}
