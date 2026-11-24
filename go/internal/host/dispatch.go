package host

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
)

// Runner executes a child process.
//
// On POSIX the production runner execs in place, so the child inherits the
// terminal, the signal handling and the exit status with no glue code. Tests
// inject a fake.
type Runner interface {
	Run(argv []string, stdin io.Reader, stdout, stderr io.Writer) (int, error)
}

// Options configures a host invocation.
type Options struct {
	Args      []string
	Version   string
	Commit    string
	BuildDate string
	Stdin     io.Reader
	Stdout    io.Writer
	Stderr    io.Writer
	Resolver  Resolver
	Runner    Runner
}

// Main runs the host and returns the process exit code.
//
// Only `alice host ...` is handled natively. Every other invocation is handed
// to the Python backend unchanged, including `version`, whose output includes
// update checks that the Go host must not reimplement.
func Main(opts Options) int {
	if opts.Stdin == nil {
		opts.Stdin = os.Stdin
	}
	if opts.Stdout == nil {
		opts.Stdout = os.Stdout
	}
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	if opts.Runner == nil {
		opts.Runner = defaultRunner()
	}
	if opts.Resolver.GOOS == "" {
		opts.Resolver = DefaultResolver()
	}

	if len(opts.Args) > 0 && opts.Args[0] == "host" {
		return hostCommand(opts, opts.Args[1:])
	}
	return delegate(opts)
}

func delegate(opts Options) int {
	rt, err := opts.Resolver.Python()
	if err != nil {
		fmt.Fprintf(opts.Stderr, "alice: %v\n", err)
		fmt.Fprintln(opts.Stderr, "alice: set ALICE_PYTHON to an interpreter with alice_cli installed, or run from a checkout with .venv/")
		return 127
	}

	argv := make([]string, 0, len(rt.Args)+len(opts.Args)+1)
	argv = append(argv, rt.Python)
	argv = append(argv, rt.Args...)
	argv = append(argv, opts.Args...)

	code, err := opts.Runner.Run(argv, opts.Stdin, opts.Stdout, opts.Stderr)
	if err != nil {
		fmt.Fprintf(opts.Stderr, "alice: failed to launch %s: %v\n", rt.Python, err)
		if code == 0 {
			code = 127
		}
	}
	return code
}

func hostCommand(opts Options, args []string) int {
	if len(args) == 0 {
		printHostHelp(opts.Stdout)
		return 0
	}
	switch args[0] {
	case "env":
		return hostEnv(opts)
	case "help", "--help", "-h":
		printHostHelp(opts.Stdout)
		return 0
	default:
		fmt.Fprintf(opts.Stderr, "alice host: unknown subcommand %q\n\n", args[0])
		printHostHelp(opts.Stderr)
		return 2
	}
}

type envReport struct {
	HostVersion     string   `json:"host_version"`
	Commit          string   `json:"commit"`
	BuildDate       string   `json:"build_date"`
	GoVersion       string   `json:"go_version"`
	OS              string   `json:"os"`
	Arch            string   `json:"arch"`
	AliceHome       string   `json:"alice_home"`
	AliceHomeSource string   `json:"alice_home_source"`
	Python          string   `json:"python,omitempty"`
	PythonSource    string   `json:"python_source,omitempty"`
	PythonArgs      []string `json:"python_args,omitempty"`
	PythonError     string   `json:"python_error,omitempty"`
}

func hostEnv(opts Options) int {
	home, homeSource := opts.Resolver.Home()
	report := envReport{
		HostVersion:     opts.Version,
		Commit:          opts.Commit,
		BuildDate:       opts.BuildDate,
		GoVersion:       runtime.Version(),
		OS:              opts.Resolver.GOOS,
		Arch:            runtime.GOARCH,
		AliceHome:       home,
		AliceHomeSource: homeSource,
	}

	rt, err := opts.Resolver.Python()
	if err != nil {
		report.PythonError = err.Error()
	} else {
		report.Python = rt.Python
		report.PythonSource = rt.Source
		report.PythonArgs = rt.Args
	}

	enc := json.NewEncoder(opts.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(report); err != nil {
		fmt.Fprintf(opts.Stderr, "alice host env: %v\n", err)
		return 1
	}
	return 0
}

func printHostHelp(w io.Writer) {
	fmt.Fprint(w, `alice host — Go host diagnostics

Usage:
  alice host env      Print the resolved ALICE_HOME, Python runtime and build info (JSON)
  alice host help     Show this help

Every other command is delegated to the Python backend unchanged.
`)
}
