package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// TUIOptions configures the full-screen frontend.
type TUIOptions struct {
	In  io.Reader
	Out io.Writer
}

var (
	styleUser      = lipgloss.NewStyle().Foreground(lipgloss.Color("6")).Bold(true)
	styleAssistant = lipgloss.NewStyle().Foreground(lipgloss.Color("2")).Bold(true)
	styleDim       = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	styleErr       = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	stylePrompt    = lipgloss.NewStyle().Foreground(lipgloss.Color("3")).Bold(true)
)

type tuiMode int

const (
	modeChat tuiMode = iota
	modeApproval
	modeClarify
	modeSudo
	modeSecret
)

type eventMsg struct{ ev Event }
type streamClosedMsg struct{}
type submitDoneMsg struct{ err error }
type slashDoneMsg struct{ exec SlashExecution }
type promptDoneMsg struct{ err error }

type tuiModel struct {
	engine *Engine

	vp     viewport.Model
	input  textarea.Model
	secret textinput.Model

	mode   tuiMode
	prompt *PromptEvent

	transcript strings.Builder
	streaming  bool
	streamed   bool

	width, height int
	ready         bool
}

// RunTUI runs the full-screen interface until the user quits.
func RunTUI(ctx context.Context, engine *Engine, history []Message, opts TUIOptions) error {
	model := newTUIModel(engine, history)

	programOpts := []tea.ProgramOption{tea.WithAltScreen(), tea.WithContext(ctx)}
	if opts.In != nil {
		programOpts = append(programOpts, tea.WithInput(opts.In))
	}
	if opts.Out != nil {
		programOpts = append(programOpts, tea.WithOutput(opts.Out))
	}

	_, err := tea.NewProgram(model, programOpts...).Run()
	if errors.Is(err, tea.ErrProgramKilled) || errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func newTUIModel(engine *Engine, history []Message) *tuiModel {
	input := textarea.New()
	input.Placeholder = "Ask Alice…  (/help for commands)"
	input.Prompt = "› "
	input.ShowLineNumbers = false
	input.CharLimit = 0
	input.SetHeight(3)
	input.Focus()

	secret := textinput.New()
	secret.Prompt = "› "
	secret.EchoMode = textinput.EchoPassword

	m := &tuiModel{
		engine: engine,
		vp:     viewport.New(0, 0),
		input:  input,
		secret: secret,
	}
	if len(history) > 0 {
		m.transcript.WriteString(styleDim.Render(RenderHistory(history, 20)))
	}
	return m
}

func (m *tuiModel) Init() tea.Cmd {
	return tea.Batch(textarea.Blink, m.waitEvent())
}

func (m *tuiModel) waitEvent() tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-m.engine.Events()
		if !ok {
			return streamClosedMsg{}
		}
		return eventMsg{ev: ev}
	}
}

func (m *tuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.layout()
		m.ready = true
		return m, nil

	case eventMsg:
		cmd := m.handleEvent(msg.ev)
		return m, tea.Batch(cmd, m.waitEvent())

	case streamClosedMsg:
		m.streaming = false
		return m, tea.Quit

	case submitDoneMsg:
		if msg.err != nil {
			m.appendError(msg.err.Error())
			m.streaming = false
		}
		return m, nil

	case slashDoneMsg:
		m.streaming = false
		if msg.exec.Quit {
			return m, tea.Quit
		}
		if msg.exec.Clear {
			m.transcript.Reset()
		}
		if msg.exec.Output != "" {
			m.appendSystem(msg.exec.Output)
		}
		return m, nil

	case promptDoneMsg:
		if msg.err != nil {
			m.appendError(msg.err.Error())
		}
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)
	}

	return m, nil
}

func (m *tuiModel) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	switch m.mode {
	case modeApproval:
		switch key {
		case "y", "Y":
			return m.approve("once")
		case "a", "A":
			return m.approve("always")
		case "n", "N", "esc", "ctrl+c":
			return m.approve("deny")
		}
		return m, nil

	case modeClarify:
		if key == "esc" {
			return m.answer("")
		}
		if key == "enter" {
			text := strings.TrimSpace(m.input.Value())
			m.input.Reset()
			return m.answer(m.resolveChoice(text))
		}
		var cmd tea.Cmd
		m.input, cmd = m.input.Update(msg)
		return m, cmd

	case modeSudo, modeSecret:
		if key == "esc" {
			return m.respondSecret("")
		}
		if key == "enter" {
			value := m.secret.Value()
			m.secret.Reset()
			return m.respondSecret(value)
		}
		var cmd tea.Cmd
		m.secret, cmd = m.secret.Update(msg)
		return m, cmd
	}

	// Chat mode.
	switch key {
	case "ctrl+c":
		if m.streaming {
			return m, m.interruptCmd()
		}
		return m, tea.Quit

	case "ctrl+d":
		if strings.TrimSpace(m.input.Value()) == "" {
			return m, tea.Quit
		}

	case "esc":
		m.input.Reset()
		return m, nil

	case "ctrl+j":
		m.input.InsertString("\n")
		return m, nil

	case "enter":
		text := strings.TrimSpace(m.input.Value())
		if text == "" {
			return m, nil
		}
		m.input.Reset()
		if strings.HasPrefix(text, "/") {
			return m, m.slashCmd(text)
		}
		m.appendUser(text)
		m.streaming = true
		m.streamed = false
		return m, m.submitCmd(text)
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m *tuiModel) handleEvent(ev Event) tea.Cmd {
	switch ev.Kind {
	case EventMessageStart:
		m.streaming = true
		m.transcript.WriteString("\n" + styleAssistant.Render("alice") + " ")

	case EventTextDelta:
		m.streamed = true
		m.transcript.WriteString(ev.Text)

	case EventMessageComplete:
		if !m.streamed && ev.Text != "" {
			m.transcript.WriteString(ev.Text)
		}
		m.transcript.WriteString("\n")
		m.streaming = false
		m.streamed = false

	case EventReasoningAvailable:
		if text := strings.TrimSpace(ev.Text); text != "" {
			m.appendDim("[reasoning] " + clip(text, 800))
		}

	case EventToolStart:
		detail := ev.Tool.Context
		if detail == "" {
			detail = ev.Tool.Name
		}
		m.appendDim("⚙ " + detail)

	case EventToolComplete:
		line := ev.Tool.Name
		if ev.Tool.Summary != "" {
			line = ev.Tool.Summary
		}
		if d := formatDuration(ev.Tool.DurationS); d != "" {
			line += " (" + d + ")"
		}
		m.appendDim("✓ " + line)

	case EventApproval:
		m.mode = modeApproval
		m.prompt = ev.Prompt
		m.appendSystem("approval required: " + ev.Prompt.Command)

	case EventClarify:
		m.mode = modeClarify
		m.prompt = ev.Prompt
		m.input.Reset()
		m.input.Placeholder = "answer"
		m.input.Focus()
		m.appendSystem(ev.Prompt.Question)
		if len(ev.Prompt.Choices) > 0 {
			var lines []string
			for i, choice := range ev.Prompt.Choices {
				lines = append(lines, fmt.Sprintf("%d. %s", i+1, choice))
			}
			m.appendSystem(strings.Join(lines, "\n"))
		}

	case EventSudo:
		m.mode = modeSudo
		m.prompt = ev.Prompt
		m.secret.SetValue("")
		m.secret.Placeholder = "password"
		m.secret.Focus()
		m.appendSystem("sudo password required")

	case EventSecret:
		m.mode = modeSecret
		m.prompt = ev.Prompt
		m.secret.SetValue("")
		m.secret.Placeholder = "value"
		m.secret.Focus()
		label := ev.Prompt.Question
		if label == "" {
			label = "value for " + ev.Prompt.EnvVar
		}
		m.appendSystem(label)

	case EventError:
		if ev.Text != "" {
			m.appendError(ev.Text)
		}
		m.streaming = false
		m.streamed = false
	}

	m.sync()
	return nil
}

func (m *tuiModel) approve(choice string) (tea.Model, tea.Cmd) {
	m.mode = modeChat
	m.prompt = nil
	m.appendSystem("approval: " + choice)
	return m, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return promptDoneMsg{err: m.engine.Approve(ctx, choice)}
	}
}

func (m *tuiModel) answer(text string) (tea.Model, tea.Cmd) {
	prompt := m.prompt
	m.mode = modeChat
	m.prompt = nil
	m.input.Placeholder = "Ask Alice…  (/help for commands)"
	if prompt == nil {
		return m, nil
	}
	m.appendSystem("answer> " + text)
	return m, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return promptDoneMsg{err: m.engine.Answer(ctx, PromptClarify, prompt.RequestID, text)}
	}
}

func (m *tuiModel) respondSecret(value string) (tea.Model, tea.Cmd) {
	prompt := m.prompt
	kind := PromptSecret
	if m.mode == modeSudo {
		kind = PromptSudo
	}
	m.mode = modeChat
	m.prompt = nil
	if prompt == nil {
		return m, nil
	}
	return m, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return promptDoneMsg{err: m.engine.Answer(ctx, kind, prompt.RequestID, value)}
	}
}

func (m *tuiModel) resolveChoice(text string) string {
	if m.prompt == nil || len(m.prompt.Choices) == 0 {
		return text
	}
	if n, err := strconv.Atoi(text); err == nil && n >= 1 && n <= len(m.prompt.Choices) {
		return m.prompt.Choices[n-1]
	}
	return text
}

func (m *tuiModel) submitCmd(text string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		return submitDoneMsg{err: m.engine.Submit(ctx, text)}
	}
}

func (m *tuiModel) slashCmd(line string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		defer cancel()
		return slashDoneMsg{exec: m.engine.ExecuteSlash(ctx, line)}
	}
}

func (m *tuiModel) interruptCmd() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return promptDoneMsg{err: m.engine.Interrupt(ctx)}
	}
}

func (m *tuiModel) layout() {
	inputHeight := 4
	m.vp.Width = m.width
	m.vp.Height = m.height - inputHeight - 2
	if m.vp.Height < 3 {
		m.vp.Height = 3
	}
	m.input.SetWidth(m.width - 2)
	m.input.SetHeight(inputHeight - 1)
	m.secret.Width = m.width - 2
	m.sync()
}

func (m *tuiModel) sync() {
	m.vp.SetContent(m.transcript.String())
	m.vp.GotoBottom()
}

func (m *tuiModel) appendUser(text string) {
	m.transcript.WriteString("\n" + styleUser.Render("you") + " " + text + "\n")
	m.sync()
}

func (m *tuiModel) appendSystem(text string) {
	m.transcript.WriteString("\n" + styleDim.Render(text) + "\n")
	m.sync()
}

func (m *tuiModel) appendDim(text string) {
	m.transcript.WriteString("\n" + styleDim.Render(text))
	m.sync()
}

func (m *tuiModel) appendError(text string) {
	m.transcript.WriteString("\n" + styleErr.Render("error: "+text) + "\n")
	m.sync()
}

func (m *tuiModel) View() string {
	if !m.ready {
		return "starting…"
	}

	var b strings.Builder
	b.WriteString(m.vp.View())
	b.WriteString("\n")
	b.WriteString(m.statusLine())
	b.WriteString("\n")

	switch m.mode {
	case modeApproval:
		b.WriteString(stylePrompt.Render("[y] once · [a] always · [n] deny"))
	case modeClarify:
		b.WriteString(m.input.View())
	case modeSudo, modeSecret:
		b.WriteString(m.secret.View())
	default:
		b.WriteString(m.input.View())
	}
	return b.String()
}

func (m *tuiModel) statusLine() string {
	parts := []string{"alice"}
	if sid := m.engine.SessionID(); sid != "" {
		parts = append(parts, sid)
	}
	if model := m.engine.Model(); model != "" {
		parts = append(parts, model)
	}
	if m.streaming {
		parts = append(parts, "…")
	}
	return styleDim.Render(strings.Join(parts, " · "))
}
