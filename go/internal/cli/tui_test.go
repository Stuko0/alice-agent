package cli

import (
	"encoding/json"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func newTestTUI(t *testing.T) (*tuiModel, *fakeClient) {
	t.Helper()
	engine, client := newTestEngine(t)
	model := newTUIModel(engine, nil)
	model.Update(tea.WindowSizeMsg{Width: 80, Height: 24})
	return model, client
}

func TestTUIStreamsAndRenders(t *testing.T) {
	model, _ := newTestTUI(t)

	model.Update(eventMsg{ev: Event{Kind: EventMessageStart}})
	model.Update(eventMsg{ev: Event{Kind: EventTextDelta, Text: "hello"}})
	model.Update(eventMsg{ev: Event{Kind: EventTextDelta, Text: " world"}})
	model.Update(eventMsg{ev: Event{Kind: EventMessageComplete}})

	if !strings.Contains(model.transcript.String(), "hello world") {
		t.Fatalf("transcript = %q", model.transcript.String())
	}
	view := model.View()
	if !strings.Contains(view, "hello world") || !strings.Contains(view, "alice") {
		t.Fatalf("view = %q", view)
	}
}

func TestTUISubmitsOnEnter(t *testing.T) {
	model, client := newTestTUI(t)

	model.input.SetValue("hi there")
	_, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter produced no command")
	}
	if msg := cmd(); msg == nil {
		t.Fatal("submit command returned nil")
	}

	submit := client.callsTo("prompt.submit")
	if len(submit) != 1 {
		t.Fatalf("prompt.submit calls = %d", len(submit))
	}
	if !strings.Contains(string(submit[0].Params), "hi there") {
		t.Fatalf("params = %s", submit[0].Params)
	}
	if !strings.Contains(model.transcript.String(), "hi there") {
		t.Fatalf("transcript = %q", model.transcript.String())
	}
}

func TestTUIApprovalKeys(t *testing.T) {
	model, client := newTestTUI(t)

	model.Update(eventMsg{ev: Event{Kind: EventApproval, Prompt: &PromptEvent{Command: "rm -rf build"}}})
	if model.mode != modeApproval {
		t.Fatalf("mode = %v", model.mode)
	}
	if !strings.Contains(model.View(), "once") {
		t.Fatalf("approval hint missing: %q", model.View())
	}

	_, cmd := model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'a'}})
	if cmd == nil {
		t.Fatal("approval key produced no command")
	}
	cmd()

	approvals := client.callsTo("approval.respond")
	if len(approvals) != 1 {
		t.Fatalf("approval.respond calls = %d", len(approvals))
	}
	if !strings.Contains(string(approvals[0].Params), `"always"`) {
		t.Fatalf("params = %s", approvals[0].Params)
	}
	if model.mode != modeChat {
		t.Fatalf("mode = %v", model.mode)
	}
}

func TestTUICtrlCInterruptsWhileStreaming(t *testing.T) {
	model, client := newTestTUI(t)

	model.streaming = true
	_, cmd := model.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	if cmd == nil {
		t.Fatal("ctrl+c produced no command")
	}
	cmd()

	if len(client.callsTo("session.interrupt")) != 1 {
		t.Fatalf("session.interrupt calls = %d", len(client.callsTo("session.interrupt")))
	}
}

func TestTUISlashCommandRuns(t *testing.T) {
	model, client := newTestTUI(t)
	client.on("slash.exec", func(json.RawMessage) (json.RawMessage, error) {
		return json.RawMessage(`{"output":"ok from backend"}`), nil
	})

	model.input.SetValue("/compress")
	_, cmd := model.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("enter produced no command")
	}
	msg, ok := cmd().(slashDoneMsg)
	if !ok {
		t.Fatalf("message = %T", msg)
	}
	model.Update(msg)

	if !strings.Contains(model.transcript.String(), "ok from backend") {
		t.Fatalf("transcript = %q", model.transcript.String())
	}
}
