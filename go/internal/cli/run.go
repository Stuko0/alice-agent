package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/Stuko0/alice-agent/go/internal/rpcclient"
)

// Options configures Run.
type Options struct {
	Python string
	Dir    string
	Env    []string

	Resume string
	Model  string
	Cwd    string
	Plain  bool

	In  io.Reader
	Out io.Writer
	Err io.Writer
}

// Run starts the backend, opens a session and runs the requested frontend.
func Run(ctx context.Context, opts Options) error {
	if opts.Python == "" {
		return fmt.Errorf("no Python interpreter resolved")
	}
	if opts.In == nil {
		opts.In = os.Stdin
	}
	if opts.Out == nil {
		opts.Out = os.Stdout
	}
	if opts.Err == nil {
		opts.Err = os.Stderr
	}

	startCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()

	client, err := rpcclient.Start(startCtx, rpcclient.Options{
		Python: opts.Python,
		Dir:    opts.Dir,
		Env:    opts.Env,
		// The gateway logs to $ALICE_HOME/logs; letting it write to the
		// terminal would corrupt the alt-screen TUI and interleave with the
		// REPL transcript.
		Stderr: io.Discard,
	})
	if err != nil {
		return fmt.Errorf("%w (run `alice host doctor --deep` for diagnostics)", err)
	}
	defer client.Close()

	engine := NewEngine(client)
	defer engine.Close()

	cwd := opts.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	engine.SetSessionDefaults(CreateOptions{Cwd: cwd, Model: opts.Model, Cols: 100})

	var session *Session
	if opts.Resume != "" {
		session, err = engine.Resume(startCtx, opts.Resume, 100)
	} else {
		session, err = engine.NewSession(startCtx)
	}
	if err != nil {
		return err
	}

	color := !opts.Plain && colorEnabled(opts.Out)

	if wantsTUI(opts.Out, opts.Plain) {
		return RunTUI(ctx, engine, session.Messages, TUIOptions{In: opts.In, Out: opts.Out})
	}

	if len(session.Messages) > 0 {
		fmt.Fprint(opts.Out, RenderHistory(session.Messages, 20))
	}
	return RunREPL(ctx, engine, REPLOptions{
		In:    opts.In,
		Out:   opts.Out,
		Err:   opts.Err,
		Color: color,
	})
}
