package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func newTestEngine(t *testing.T) (*Engine, *fakeClient) {
	t.Helper()
	client := newFakeClient()
	client.on("session.create", func(json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"session_id":"s-1","messages":[],"info":{"model":"m"}}`), nil
	})
	engine := NewEngine(client)
	t.Cleanup(engine.Close)
	if _, err := engine.NewSession(context.Background()); err != nil {
		t.Fatalf("create session: %v", err)
	}
	return engine, client
}

func TestREPLStreamsReplyAndQuits(t *testing.T) {
	engine, client := newTestEngine(t)

	client.events <- makeEvent("message.start", "s-1", nil)
	client.events <- makeEvent("message.delta", "s-1", map[string]any{"text": "Hi "})
	client.events <- makeEvent("message.delta", "s-1", map[string]any{"text": "there"})
	client.events <- makeEvent("message.complete", "s-1", map[string]any{"text": ""})

	var out, errb bytes.Buffer
	in := strings.NewReader("hello\n/quit\n")
	if err := RunREPL(context.Background(), engine, REPLOptions{In: in, Out: &out, Err: &errb}); err != nil {
		t.Fatalf("RunREPL: %v", err)
	}

	if !strings.Contains(out.String(), "Hi there") {
		t.Fatalf("output = %q", out.String())
	}
	if calls := client.callsTo("prompt.submit"); len(calls) != 1 {
		t.Fatalf("prompt.submit calls = %d", len(calls))
	}
}

func TestREPLHandlesApproval(t *testing.T) {
	engine, client := newTestEngine(t)

	client.events <- makeEvent("approval.request", "s-1", map[string]any{"command": "rm -rf build"})
	client.events <- makeEvent("message.complete", "s-1", map[string]any{"text": "done"})

	var out, errb bytes.Buffer
	in := strings.NewReader("run it\ny\n/quit\n")
	if err := RunREPL(context.Background(), engine, REPLOptions{In: in, Out: &out, Err: &errb}); err != nil {
		t.Fatalf("RunREPL: %v", err)
	}

	if !strings.Contains(out.String(), "rm -rf build") {
		t.Fatalf("approval command was not shown: %q", out.String())
	}
	approvals := client.callsTo("approval.respond")
	if len(approvals) != 1 {
		t.Fatalf("approval.respond calls = %d", len(approvals))
	}
	var params map[string]any
	if err := json.Unmarshal(approvals[0].Params, &params); err != nil {
		t.Fatal(err)
	}
	if params["choice"] != "once" {
		t.Fatalf("choice = %v", params["choice"])
	}
}

func TestREPLAnswersClarify(t *testing.T) {
	engine, client := newTestEngine(t)

	client.events <- makeEvent("clarify.request", "s-1", map[string]any{
		"request_id": "req-1",
		"question":   "which environment?",
		"choices":    []string{"staging", "production"},
	})
	client.events <- makeEvent("message.complete", "s-1", map[string]any{"text": "ok"})

	var out, errb bytes.Buffer
	in := strings.NewReader("go\n2\n/quit\n")
	if err := RunREPL(context.Background(), engine, REPLOptions{In: in, Out: &out, Err: &errb}); err != nil {
		t.Fatalf("RunREPL: %v", err)
	}

	answers := client.callsTo("clarify.respond")
	if len(answers) != 1 {
		t.Fatalf("clarify.respond calls = %d", len(answers))
	}
	var params map[string]any
	if err := json.Unmarshal(answers[0].Params, &params); err != nil {
		t.Fatal(err)
	}
	if params["answer"] != "production" {
		t.Fatalf("answer = %v", params["answer"])
	}
	if params["request_id"] != "req-1" {
		t.Fatalf("request_id = %v", params["request_id"])
	}
}

func TestREPLSlashPrintsOutput(t *testing.T) {
	engine, client := newTestEngine(t)
	client.on("slash.exec", func(json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"output":"compressed 3 messages"}`), nil
	})

	var out, errb bytes.Buffer
	in := strings.NewReader("/compress\n/quit\n")
	if err := RunREPL(context.Background(), engine, REPLOptions{In: in, Out: &out, Err: &errb}); err != nil {
		t.Fatalf("RunREPL: %v", err)
	}
	if !strings.Contains(out.String(), "compressed 3 messages") {
		t.Fatalf("output = %q", out.String())
	}
}
