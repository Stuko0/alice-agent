// Package cli is the Go classic CLI: a terminal frontend over the gateway
// JSON-RPC protocol. It owns session lifecycle, event rendering, prompt
// handling and slash-command dispatch; it knows nothing about how the backend
// implements any of it.
package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/Stuko0/alice-agent/go/internal/protocol"
)

// Client is the subset of rpcclient the CLI needs.
type Client interface {
	Call(ctx context.Context, method string, params any) (json.RawMessage, error)
	CallInto(ctx context.Context, method string, params, out any) error
	Events() <-chan protocol.Event
	Close() error
}

// Engine drives one gateway session and exposes a typed event stream.
type Engine struct {
	client Client

	events chan Event
	done   chan struct{}
	once   sync.Once

	mu        sync.RWMutex
	sessionID string
	model     string
	cwd       string
	skin      string
	defaults  CreateOptions
}

// NewEngine starts the event pump for client.
func NewEngine(client Client) *Engine {
	e := &Engine{
		client: client,
		events: make(chan Event, 128),
		done:   make(chan struct{}),
	}
	go e.pump()
	return e
}

// Events is the typed stream. It is closed when the backend goes away.
func (e *Engine) Events() <-chan Event { return e.events }

// Close stops the event pump and closes the backend.
func (e *Engine) Close() {
	e.once.Do(func() {
		close(e.done)
		_ = e.client.Close()
	})
}

// SessionID is the active gateway session ("" before Create/Resume).
func (e *Engine) SessionID() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.sessionID
}

// Model is the session model reported by the backend, when known.
func (e *Engine) Model() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.model
}

// SetModel records a pending model override for the next Create.
func (e *Engine) SetModel(model string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.model = model
}

// SetSkin records the skin announced by gateway.ready.
func (e *Engine) SetSkin(skin string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.skin = skin
}

// Skin is the backend's active skin name ("" when unknown).
func (e *Engine) Skin() string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.skin
}

func (e *Engine) pump() {
	defer close(e.events)
	for {
		select {
		case <-e.done:
			return
		case ev, ok := <-e.client.Events():
			if !ok {
				return
			}
			e.mu.RLock()
			sid := e.sessionID
			e.mu.RUnlock()
			// Session-scoped events for another session (subagent mirrors,
			// background jobs) are not part of this transcript.
			if sid != "" && ev.SessionID != "" && ev.SessionID != sid {
				continue
			}
			out, keep := translate(ev)
			if !keep {
				continue
			}
			select {
			case e.events <- out:
			case <-e.done:
				return
			}
		}
	}
}

// CreateOptions configures a new session.
type CreateOptions struct {
	Cwd   string
	Model string
	Title string
	Cols  int
}

// Session is the result of Create/Resume.
type Session struct {
	ID       string
	Messages []Message
	Model    string
	Running  bool
}

// Message is one transcript row.
type Message struct {
	Role    string
	Content string
}

type createResult struct {
	SessionID string        `json:"session_id"`
	Messages  []wireMessage `json:"messages"`
	Info      struct {
		Model string `json:"model"`
	} `json:"info"`
}

type wireMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Text    string          `json:"text"`
}

// Create starts a new session.
func (e *Engine) Create(ctx context.Context, opts CreateOptions) (*Session, error) {
	cols := opts.Cols
	if cols <= 0 {
		cols = 100
	}
	params := map[string]any{
		"cols":   cols,
		"source": "go-cli",
	}
	if opts.Cwd != "" {
		params["cwd"] = opts.Cwd
	}
	if opts.Model != "" {
		params["model"] = opts.Model
	}
	if opts.Title != "" {
		params["title"] = opts.Title
	}

	var result createResult
	if err := e.client.CallInto(ctx, "session.create", params, &result); err != nil {
		return nil, err
	}
	if result.SessionID == "" {
		return nil, fmt.Errorf("session.create returned no session_id")
	}

	e.mu.Lock()
	e.sessionID = result.SessionID
	if result.Info.Model != "" {
		e.model = result.Info.Model
	}
	if opts.Cwd != "" {
		e.cwd = opts.Cwd
	}
	e.mu.Unlock()

	return &Session{
		ID:       result.SessionID,
		Messages: convertMessages(result.Messages),
		Model:    result.Info.Model,
	}, nil
}

type resumeResult struct {
	SessionID string        `json:"session_id"`
	Messages  []wireMessage `json:"messages"`
	Running   bool          `json:"running"`
	Info      struct {
		Model string `json:"model"`
	} `json:"info"`
}

// Resume attaches to an existing session by id (or unique prefix/title).
func (e *Engine) Resume(ctx context.Context, id string, cols int) (*Session, error) {
	if cols <= 0 {
		cols = 100
	}
	var result resumeResult
	if err := e.client.CallInto(ctx, "session.resume", map[string]any{
		"session_id": id,
		"cols":       cols,
	}, &result); err != nil {
		return nil, err
	}
	if result.SessionID == "" {
		return nil, fmt.Errorf("session.resume returned no session_id")
	}

	e.mu.Lock()
	e.sessionID = result.SessionID
	if result.Info.Model != "" {
		e.model = result.Info.Model
	}
	e.mu.Unlock()

	return &Session{
		ID:       result.SessionID,
		Messages: convertMessages(result.Messages),
		Model:    result.Info.Model,
		Running:  result.Running,
	}, nil
}

// Submit sends a prompt. The reply streams through Events.
func (e *Engine) Submit(ctx context.Context, text string) error {
	sid := e.SessionID()
	if sid == "" {
		return fmt.Errorf("no active session")
	}
	if strings.TrimSpace(text) == "" {
		return nil
	}
	return e.client.CallInto(ctx, "prompt.submit", map[string]any{
		"session_id": sid,
		"text":       text,
	}, nil)
}

// Interrupt stops the in-flight turn.
func (e *Engine) Interrupt(ctx context.Context) error {
	sid := e.SessionID()
	if sid == "" {
		return nil
	}
	return e.client.CallInto(ctx, "session.interrupt", map[string]any{"session_id": sid}, nil)
}

// Approve resolves the oldest pending approval for this session.
// choice is "once", "always" or "deny".
func (e *Engine) Approve(ctx context.Context, choice string) error {
	sid := e.SessionID()
	if sid == "" {
		return fmt.Errorf("no active session")
	}
	return e.client.CallInto(ctx, "approval.respond", map[string]any{
		"session_id": sid,
		"choice":     choice,
	}, nil)
}

// PromptKind selects the RPC used to answer a blocking prompt.
type PromptKind string

const (
	PromptClarify PromptKind = "clarify"
	PromptSudo    PromptKind = "sudo"
	PromptSecret  PromptKind = "secret"
)

// Answer resolves a clarify/sudo/secret prompt by request id.
func (e *Engine) Answer(ctx context.Context, kind PromptKind, requestID, value string) error {
	method := ""
	field := ""
	switch kind {
	case PromptClarify:
		method, field = "clarify.respond", "answer"
	case PromptSudo:
		method, field = "sudo.respond", "password"
	case PromptSecret:
		method, field = "secret.respond", "value"
	default:
		return fmt.Errorf("unknown prompt kind %q", kind)
	}
	return e.client.CallInto(ctx, method, map[string]any{
		"request_id": requestID,
		field:        value,
	}, nil)
}

// SlashResult is the rendered output of a backend slash command.
type SlashResult struct {
	Output  string `json:"output"`
	Warning string `json:"warning"`
}

// Slash runs a slash command on the backend. The leading "/" is optional.
func (e *Engine) Slash(ctx context.Context, command string) (SlashResult, error) {
	sid := e.SessionID()
	if sid == "" {
		return SlashResult{}, fmt.Errorf("no active session")
	}
	var result SlashResult
	err := e.client.CallInto(ctx, "slash.exec", map[string]any{
		"session_id": sid,
		"command":    strings.TrimPrefix(strings.TrimSpace(command), "/"),
	}, &result)
	return result, err
}

// SessionRow is one entry of the resume picker.
type SessionRow struct {
	ID           string  `json:"id"`
	Title        string  `json:"title"`
	Preview      string  `json:"preview"`
	StartedAt    float64 `json:"started_at"`
	MessageCount int     `json:"message_count"`
	Source       string  `json:"source"`
}

// Sessions lists resumable sessions, newest first.
func (e *Engine) Sessions(ctx context.Context, limit int) ([]SessionRow, error) {
	if limit <= 0 {
		limit = 30
	}
	var result struct {
		Sessions []SessionRow `json:"sessions"`
	}
	if err := e.client.CallInto(ctx, "session.list", map[string]any{"limit": limit}, &result); err != nil {
		return nil, err
	}
	return result.Sessions, nil
}

// ModelOption is one provider/model choice from the backend.
type ModelOption struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Label    string `json:"label"`
}

type modelOptionsResult struct {
	Options []ModelOption `json:"options"`
	Current string        `json:"current"`
}

// ModelOptions asks the backend for the model picker rows.
func (e *Engine) ModelOptions(ctx context.Context) ([]ModelOption, string, error) {
	var result modelOptionsResult
	if err := e.client.CallInto(ctx, "model.options", map[string]any{}, &result); err != nil {
		return nil, "", err
	}
	return result.Options, result.Current, nil
}

func convertMessages(rows []wireMessage) []Message {
	out := make([]Message, 0, len(rows))
	for _, row := range rows {
		content := row.Text
		if content == "" {
			content = messageText(row.Content)
		}
		out = append(out, Message{Role: row.Role, Content: content})
	}
	return out
}

// messageText accepts both the string form and the multimodal array form.
func messageText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			if p.Type == "text" || p.Text != "" {
				b.WriteString(p.Text)
			}
		}
		return b.String()
	}
	return string(raw)
}
