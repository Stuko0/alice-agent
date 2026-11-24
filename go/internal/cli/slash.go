package cli

import (
	"context"
	"fmt"
	"strings"
)

// SlashOutcome is the raw decision produced by one slash command.
type SlashOutcome struct {
	Handled      bool
	Output       string
	Quit         bool
	New          bool
	Clear        bool
	Interrupt    bool
	ResumeID     string
	ShowSessions bool
	ShowModels   bool
}

// SlashExecution is the final result after the engine resolves any follow-up
// work (creating, resuming, listing).
type SlashExecution struct {
	Quit   bool
	Clear  bool
	Output string
}

// HelpText documents the commands the Go CLI owns. Everything else is sent to
// the backend, so the backend's command set stays authoritative.
const HelpText = `Local commands
  /help                 show this help
  /new                  start a new session
  /resume [id]          resume a session (no id opens the picker)
  /sessions             list recent sessions
  /model [name]         show the model picker, or switch the session model
  /interrupt, /stop     stop the in-flight turn
  /clear                clear the screen
  /status               session id, model and working directory
  /quit, /exit          leave

Everything else is forwarded to the backend (skills, plugins, /compress,
/config, /cron, …), which owns the canonical command registry.`

// SetSessionDefaults configures the options used by the next NewSession.
func (e *Engine) SetSessionDefaults(opts CreateOptions) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.defaults = opts
}

// NewSession creates a session with the configured defaults.
func (e *Engine) NewSession(ctx context.Context) (*Session, error) {
	e.mu.RLock()
	opts := e.defaults
	e.mu.RUnlock()
	if opts.Cols <= 0 {
		opts.Cols = 100
	}
	return e.Create(ctx, opts)
}

// ExecuteSlash runs a slash command and resolves its follow-up work.
func (e *Engine) ExecuteSlash(ctx context.Context, line string) SlashExecution {
	outcome := e.HandleSlash(ctx, line)
	exec := SlashExecution{Quit: outcome.Quit, Clear: outcome.Clear, Output: outcome.Output}

	switch {
	case outcome.New:
		session, err := e.NewSession(ctx)
		if err != nil {
			exec.Output = "error: " + err.Error()
		} else {
			exec.Output = "new session " + session.ID
		}

	case outcome.ResumeID != "":
		session, err := e.Resume(ctx, outcome.ResumeID, e.cols())
		if err != nil {
			exec.Output = "error: " + err.Error()
		} else {
			exec.Output = fmt.Sprintf("resumed %s (%d messages)", session.ID, len(session.Messages))
		}

	case outcome.ShowSessions:
		rows, err := e.Sessions(ctx, 20)
		if err != nil {
			exec.Output = "error: " + err.Error()
		} else {
			exec.Output = FormatSessions(rows)
		}

	case outcome.ShowModels:
		options, current, err := e.ModelOptions(ctx)
		if err != nil {
			exec.Output = "error: " + err.Error()
		} else {
			exec.Output = FormatModels(options, current)
		}
	}

	return exec
}

func (e *Engine) cols() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	if e.defaults.Cols > 0 {
		return e.defaults.Cols
	}
	return 100
}

// HandleSlash executes one slash command. The line may start with "/".
func (e *Engine) HandleSlash(ctx context.Context, line string) SlashOutcome {
	trimmed := strings.TrimSpace(line)
	body := strings.TrimPrefix(trimmed, "/")
	name, arg, _ := strings.Cut(body, " ")
	name = strings.ToLower(strings.TrimSpace(name))
	arg = strings.TrimSpace(arg)

	switch name {
	case "", "help":
		return SlashOutcome{Handled: true, Output: HelpText}

	case "quit", "exit", "q":
		return SlashOutcome{Handled: true, Quit: true}

	case "new":
		return SlashOutcome{Handled: true, New: true}

	case "clear":
		return SlashOutcome{Handled: true, Clear: true}

	case "interrupt", "stop":
		if err := e.Interrupt(ctx); err != nil {
			return SlashOutcome{Handled: true, Output: "error: " + err.Error()}
		}
		return SlashOutcome{Handled: true, Output: "interrupted"}

	case "resume":
		if arg == "" {
			return SlashOutcome{Handled: true, ShowSessions: true}
		}
		return SlashOutcome{Handled: true, ResumeID: arg}

	case "sessions":
		return SlashOutcome{Handled: true, ShowSessions: true}

	case "model":
		if arg == "" {
			return SlashOutcome{Handled: true, ShowModels: true}
		}
		if err := e.setModel(ctx, arg); err != nil {
			return SlashOutcome{Handled: true, Output: "error: " + err.Error()}
		}
		return SlashOutcome{Handled: true, Output: "model set to " + arg}

	case "status":
		sid := e.SessionID()
		if sid == "" {
			sid = "(none)"
		}
		model := e.Model()
		if model == "" {
			model = "(backend default)"
		}
		e.mu.RLock()
		cwd := e.cwd
		e.mu.RUnlock()
		if cwd == "" {
			cwd = "(inherited)"
		}
		return SlashOutcome{Handled: true, Output: fmt.Sprintf(
			"session: %s\nmodel:   %s\ncwd:     %s", sid, model, cwd,
		)}
	}

	// Backend-owned command.
	result, err := e.Slash(ctx, trimmed)
	if err != nil {
		return SlashOutcome{Handled: true, Output: fmt.Sprintf("/%s: %v", name, err)}
	}
	output := result.Output
	if strings.TrimSpace(output) == "" {
		output = "(no output)"
	}
	if result.Warning != "" {
		output = "warning: " + result.Warning + "\n" + output
	}
	return SlashOutcome{Handled: true, Output: output}
}

func (e *Engine) setModel(ctx context.Context, model string) error {
	sid := e.SessionID()
	if sid == "" {
		e.SetModel(model)
		return nil
	}
	if err := e.client.CallInto(ctx, "config.set", map[string]any{
		"session_id": sid,
		"key":        "model",
		"value":      model,
	}, nil); err != nil {
		return err
	}
	e.SetModel(model)
	return nil
}

// FormatSessions renders the resume picker rows for a line interface.
func FormatSessions(rows []SessionRow) string {
	if len(rows) == 0 {
		return "no sessions yet"
	}
	var b strings.Builder
	for i, row := range rows {
		title := strings.TrimSpace(row.Title)
		if title == "" {
			title = strings.TrimSpace(row.Preview)
		}
		if len(title) > 70 {
			title = title[:67] + "..."
		}
		fmt.Fprintf(&b, "%2d. %-24s %-9s %4d msg  %s\n",
			i+1, row.ID, row.Source, row.MessageCount, title)
	}
	return strings.TrimRight(b.String(), "\n")
}

// FormatModels renders the model picker rows.
func FormatModels(options []ModelOption, current string) string {
	if len(options) == 0 {
		return "no model options reported by the backend"
	}
	var b strings.Builder
	if current != "" {
		fmt.Fprintf(&b, "current: %s\n", current)
	}
	for i, opt := range options {
		label := opt.Label
		if label == "" {
			label = strings.TrimSpace(opt.Provider + " " + opt.Model)
		}
		fmt.Fprintf(&b, "%2d. %-12s %s\n", i+1, opt.Provider, label)
	}
	return strings.TrimRight(b.String(), "\n")
}
