package cli

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Stuko0/alice-agent/go/internal/protocol"
)

type fakeCall struct {
	Method string
	Params json.RawMessage
}

type fakeClient struct {
	mu       sync.Mutex
	calls    []fakeCall
	handlers map[string]func(json.RawMessage) (json.RawMessage, error)
	events   chan protocol.Event
	closed   sync.Once
}

func newFakeClient() *fakeClient {
	return &fakeClient{
		handlers: make(map[string]func(json.RawMessage) (json.RawMessage, error)),
		events:   make(chan protocol.Event, 64),
	}
}

func (f *fakeClient) Call(_ context.Context, method string, params any) (json.RawMessage, error) {
	raw, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}

	f.mu.Lock()
	f.calls = append(f.calls, fakeCall{Method: method, Params: raw})
	handler := f.handlers[method]
	f.mu.Unlock()

	if handler != nil {
		return handler(raw)
	}
	return json.RawMessage(`{}`), nil
}

func (f *fakeClient) CallInto(ctx context.Context, method string, params, out any) error {
	raw, err := f.Call(ctx, method, params)
	if err != nil {
		return err
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, out)
}

func (f *fakeClient) Events() <-chan protocol.Event { return f.events }
func (f *fakeClient) Close() error {
	f.closed.Do(func() { close(f.events) })
	return nil
}

func (f *fakeClient) on(method string, fn func(json.RawMessage) (json.RawMessage, error)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.handlers[method] = fn
}

func (f *fakeClient) callsTo(method string) []fakeCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []fakeCall
	for _, call := range f.calls {
		if call.Method == method {
			out = append(out, call)
		}
	}
	return out
}

func makeEvent(kind, sid string, fields map[string]any) protocol.Event {
	body := make(map[string]json.RawMessage, len(fields))
	for key, value := range fields {
		data, _ := json.Marshal(value)
		body[key] = data
	}
	data, _ := json.Marshal(body)
	return protocol.Event{
		Type:      kind,
		SessionID: sid,
		Fields:    map[string]json.RawMessage{"payload": data},
	}
}

func nextEvent(t *testing.T, engine *Engine) Event {
	t.Helper()
	select {
	case ev, ok := <-engine.Events():
		if !ok {
			t.Fatal("event stream closed")
		}
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for an event")
	}
	return Event{}
}

func TestEngineTranslatesEvents(t *testing.T) {
	client := newFakeClient()
	engine := NewEngine(client)
	defer engine.Close()

	client.events <- makeEvent("message.delta", "", map[string]any{"text": "Hel"})
	client.events <- makeEvent("tool.start", "", map[string]any{"tool_id": "t1", "name": "terminal", "context": "ls"})
	client.events <- makeEvent("tool.complete", "", map[string]any{"tool_id": "t1", "name": "terminal", "summary": "listed", "duration_s": 0.4})
	client.events <- makeEvent("approval.request", "", map[string]any{"command": "rm -rf build"})
	client.events <- makeEvent("notification", "", map[string]any{"title": "ignored"})

	delta := nextEvent(t, engine)
	if delta.Kind != EventTextDelta || delta.Text != "Hel" {
		t.Fatalf("delta = %+v", delta)
	}

	start := nextEvent(t, engine)
	if start.Kind != EventToolStart || start.Tool.Name != "terminal" || start.Tool.Context != "ls" {
		t.Fatalf("tool start = %+v", start.Tool)
	}

	done := nextEvent(t, engine)
	if done.Kind != EventToolComplete || done.Tool.Summary != "listed" || done.Tool.DurationS != 0.4 {
		t.Fatalf("tool complete = %+v", done.Tool)
	}

	approval := nextEvent(t, engine)
	if approval.Kind != EventApproval || approval.Prompt.Command != "rm -rf build" {
		t.Fatalf("approval = %+v", approval.Prompt)
	}

	// The "notification" event must not surface.
	select {
	case ev := <-engine.Events():
		t.Fatalf("unexpected event %+v", ev)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestEngineFiltersOtherSessions(t *testing.T) {
	client := newFakeClient()
	engine := NewEngine(client)
	defer engine.Close()

	client.on("session.create", func(json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"session_id":"s-1","messages":[],"info":{"model":"m"}}`), nil
	})
	if _, err := engine.NewSession(context.Background()); err != nil {
		t.Fatal(err)
	}

	client.events <- makeEvent("message.delta", "other", map[string]any{"text": "nope"})
	client.events <- makeEvent("message.delta", "s-1", map[string]any{"text": "yes"})

	ev := nextEvent(t, engine)
	if ev.Text != "yes" {
		t.Fatalf("event = %+v", ev)
	}
}

func TestEngineCreateSubmitAndSlash(t *testing.T) {
	client := newFakeClient()
	engine := NewEngine(client)
	defer engine.Close()

	client.on("session.create", func(params json.RawMessage) (json.RawMessage, error) {
		var p map[string]any
		_ = json.Unmarshal(params, &p)
		if p["source"] != "go-cli" {
			t.Errorf("source = %v", p["source"])
		}
		return json.RawMessage(`{"session_id":"s-1","messages":[{"role":"user","content":"hi"}],"info":{"model":"m-1"}}`), nil
	})
	client.on("slash.exec", func(json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"output":"compressed"}`), nil
	})

	engine.SetSessionDefaults(CreateOptions{Cwd: "/repo", Model: "m-1", Cols: 80})
	session, err := engine.NewSession(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if session.ID != "s-1" || session.Model != "m-1" || len(session.Messages) != 1 {
		t.Fatalf("session = %+v", session)
	}
	if engine.SessionID() != "s-1" {
		t.Fatalf("session id = %q", engine.SessionID())
	}

	if err := engine.Submit(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}
	submit := client.callsTo("prompt.submit")
	if len(submit) != 1 {
		t.Fatalf("prompt.submit calls = %d", len(submit))
	}

	exec := engine.ExecuteSlash(context.Background(), "/compress")
	if exec.Output != "compressed" {
		t.Fatalf("output = %q", exec.Output)
	}
}

func TestExecuteSlashLocalCommands(t *testing.T) {
	client := newFakeClient()
	engine := NewEngine(client)
	defer engine.Close()

	client.on("session.list", func(json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"sessions":[{"id":"a","title":"first","message_count":2,"source":"cli"}]}`), nil
	})
	client.on("model.options", func(json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"options":[{"provider":"openrouter","model":"x","label":"X"}],"current":"x"}`), nil
	})

	if exec := engine.ExecuteSlash(context.Background(), "/help"); exec.Output == "" {
		t.Fatal("help output is empty")
	}
	if exec := engine.ExecuteSlash(context.Background(), "/quit"); !exec.Quit {
		t.Fatal("expected quit")
	}
	if exec := engine.ExecuteSlash(context.Background(), "/sessions"); !strings.Contains(exec.Output, "first") {
		t.Fatalf("sessions output = %q", exec.Output)
	}
	if exec := engine.ExecuteSlash(context.Background(), "/model"); !strings.Contains(exec.Output, "openrouter") {
		t.Fatalf("models output = %q", exec.Output)
	}
}

func TestMessageTextMultimodal(t *testing.T) {
	raw := json.RawMessage(`[{"type":"text","text":"hello "},{"type":"text","text":"world"}]`)
	if got := messageText(raw); got != "hello world" {
		t.Fatalf("got %q", got)
	}
	if got := messageText(json.RawMessage(`"plain"`)); got != "plain" {
		t.Fatalf("got %q", got)
	}
}

func TestConvertMessagesAcceptsCompactText(t *testing.T) {
	rows := []wireMessage{
		{Role: "user", Text: "hello"},
		{Role: "assistant", Content: json.RawMessage(`"hi"`)},
		{Role: "tool"},
	}
	got := convertMessages(rows)
	if len(got) != 3 || got[0].Content != "hello" || got[1].Content != "hi" {
		t.Fatalf("messages = %+v", got)
	}
}
