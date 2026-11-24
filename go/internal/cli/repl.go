package cli

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"golang.org/x/term"
)

// REPLOptions configures the line-oriented frontend.
type REPLOptions struct {
	In    io.Reader
	Out   io.Writer
	Err   io.Writer
	Color bool
}

type repl struct {
	engine *Engine
	raw    io.Reader
	in     *bufio.Reader
	out    io.Writer
	err    io.Writer
	style  Style
}

// RunREPL runs the line interface until /quit, EOF or cancellation.
func RunREPL(ctx context.Context, engine *Engine, opts REPLOptions) error {
	if opts.In == nil {
		opts.In = os.Stdin
	}
	if opts.Out == nil {
		opts.Out = os.Stdout
	}
	if opts.Err == nil {
		opts.Err = os.Stderr
	}
	r := &repl{
		engine: engine,
		raw:    opts.In,
		in:     bufio.NewReader(opts.In),
		out:    opts.Out,
		err:    opts.Err,
		style:  Style{Color: opts.Color},
	}
	return r.run(ctx)
}

func (r *repl) run(ctx context.Context) error {
	for {
		fmt.Fprint(r.out, r.style.Cyan("› "))
		line, err := r.readLine()
		if err != nil {
			if err == io.EOF {
				fmt.Fprintln(r.out)
				return nil
			}
			return err
		}

		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "/") {
			exec := r.engine.ExecuteSlash(ctx, line)
			if exec.Quit {
				return nil
			}
			if exec.Clear {
				fmt.Fprint(r.out, "\x1b[2J\x1b[H")
			}
			if exec.Output != "" {
				fmt.Fprintln(r.out, exec.Output)
			}
			continue
		}

		r.turn(ctx, line)
	}
}

func (r *repl) turn(ctx context.Context, text string) {
	if err := r.engine.Submit(ctx, text); err != nil {
		r.printErr(err)
		return
	}

	streamed := false
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-r.engine.Events():
			if !ok {
				fmt.Fprintln(r.err, r.style.Red("backend disconnected"))
				return
			}
			switch ev.Kind {
			case EventTextDelta:
				fmt.Fprint(r.out, ev.Text)
				streamed = true
			case EventMessageComplete:
				if !streamed && ev.Text != "" {
					fmt.Fprint(r.out, ev.Text)
				}
				fmt.Fprintln(r.out)
				return
			case EventReasoningAvailable:
				if text := strings.TrimSpace(ev.Text); text != "" {
					fmt.Fprintf(r.out, "\n%s\n", r.style.Dim("[reasoning] "+clip(text, 800)))
				}
			case EventToolStart:
				detail := ev.Tool.Context
				if detail == "" {
					detail = ev.Tool.Name
				}
				fmt.Fprintf(r.out, "%s %s\n", r.style.Dim("⚙"), detail)
			case EventToolComplete:
				line := ev.Tool.Name
				if ev.Tool.Summary != "" {
					line = ev.Tool.Summary
				}
				if d := formatDuration(ev.Tool.DurationS); d != "" {
					line += " (" + d + ")"
				}
				fmt.Fprintf(r.out, "%s %s\n", r.style.Dim("✓"), line)
			case EventApproval:
				r.handleApproval(ctx, ev.Prompt)
			case EventClarify:
				r.handleClarify(ctx, ev.Prompt)
			case EventSudo:
				r.handleSecret(ctx, PromptSudo, ev.Prompt)
			case EventSecret:
				r.handleSecret(ctx, PromptSecret, ev.Prompt)
			case EventError:
				fmt.Fprintln(r.err, r.style.Red("error: "+ev.Text))
				return
			}
		}
	}
}

func (r *repl) handleApproval(ctx context.Context, prompt *PromptEvent) {
	fmt.Fprintln(r.out)
	fmt.Fprintln(r.out, r.style.Yellow("approval required"))
	if prompt.Command != "" {
		fmt.Fprintln(r.out, "  "+prompt.Command)
	}
	fmt.Fprint(r.out, r.style.Dim("[y]es once / [a]lways / [n]o › "))

	line, _ := r.readLine()
	choice := "deny"
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes", "once":
		choice = "once"
	case "a", "always":
		choice = "always"
	}
	if err := r.engine.Approve(ctx, choice); err != nil {
		r.printErr(err)
	}
}

func (r *repl) handleClarify(ctx context.Context, prompt *PromptEvent) {
	fmt.Fprintln(r.out)
	if prompt.Question != "" {
		fmt.Fprintln(r.out, r.style.Cyan(prompt.Question))
	}
	if len(prompt.Choices) > 0 {
		for i, choice := range prompt.Choices {
			fmt.Fprintf(r.out, "  %d. %s\n", i+1, choice)
		}
	}
	fmt.Fprint(r.out, r.style.Dim("answer › "))

	line, _ := r.readLine()
	answer := strings.TrimSpace(line)
	if len(prompt.Choices) > 0 {
		if n, err := strconv.Atoi(answer); err == nil && n >= 1 && n <= len(prompt.Choices) {
			answer = prompt.Choices[n-1]
		}
	}
	if err := r.engine.Answer(ctx, PromptClarify, prompt.RequestID, answer); err != nil {
		r.printErr(err)
	}
}

func (r *repl) handleSecret(ctx context.Context, kind PromptKind, prompt *PromptEvent) {
	fmt.Fprintln(r.out)
	if prompt.Question != "" {
		fmt.Fprintln(r.out, prompt.Question)
	} else if prompt.EnvVar != "" {
		fmt.Fprintln(r.out, "value for "+prompt.EnvVar)
	}
	label := "password › "
	if kind == PromptSecret {
		label = "value › "
	}
	value := r.readSecret(label)
	if err := r.engine.Answer(ctx, kind, prompt.RequestID, value); err != nil {
		r.printErr(err)
	}
}

func (r *repl) readLine() (string, error) {
	line, err := r.in.ReadString('\n')
	if err != nil {
		if err == io.EOF && line != "" {
			return strings.TrimRight(line, "\r\n"), nil
		}
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func (r *repl) readSecret(prompt string) string {
	fmt.Fprint(r.out, prompt)
	if f, ok := r.raw.(*os.File); ok && term.IsTerminal(int(f.Fd())) && r.in.Buffered() == 0 {
		value, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(r.out)
		if err != nil {
			return ""
		}
		return string(value)
	}
	line, err := r.readLine()
	if err != nil {
		return ""
	}
	return line
}

func (r *repl) printErr(err error) {
	fmt.Fprintln(r.err, r.style.Red("error: "+err.Error()))
}
