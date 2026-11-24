package cli

import (
	"encoding/json"

	"github.com/Stuko0/alice-agent/go/internal/protocol"
)

// EventKind is the flattened set of gateway events the CLI renders.
type EventKind int

const (
	EventTextDelta EventKind = iota
	EventReasoningDelta
	EventReasoningAvailable
	EventThinkingDelta
	EventMessageStart
	EventMessageComplete
	EventToolGenerating
	EventToolStart
	EventToolComplete
	EventApproval
	EventClarify
	EventSudo
	EventSecret
	EventSessionInfo
	EventError
)

// Event is a UI-agnostic gateway event.
type Event struct {
	Kind   EventKind
	Text   string
	Tool   *ToolEvent
	Prompt *PromptEvent
	Info   json.RawMessage
}

// ToolEvent carries the parts of a tool call the CLI shows.
type ToolEvent struct {
	ID        string
	Name      string
	Context   string
	Summary   string
	DurationS float64
	Result    json.RawMessage
}

// PromptEvent is a blocking prompt (approval, clarify, sudo, secret).
type PromptEvent struct {
	RequestID string
	Command   string
	ToolID    string
	Question  string
	Choices   []string
	EnvVar    string
	Metadata  json.RawMessage
}

// translate maps one protocol frame to a typed CLI event. ok is false for
// events the CLI does not render.
//
// The gateway nests the event body under params.payload; see
// docs/protocol/json-rpc.md and protocol.Event.Payload.
func translate(ev protocol.Event) (Event, bool) {
	body := ev.Payload()

	switch ev.Type {
	case "message.start":
		return Event{Kind: EventMessageStart}, true
	case "message.delta":
		return Event{Kind: EventTextDelta, Text: payloadString(body, "text")}, true
	case "message.complete":
		return Event{Kind: EventMessageComplete, Text: payloadString(body, "text")}, true
	case "reasoning.delta":
		return Event{Kind: EventReasoningDelta, Text: payloadString(body, "text")}, true
	case "reasoning.available":
		return Event{Kind: EventReasoningAvailable, Text: payloadString(body, "text")}, true
	case "thinking.delta":
		return Event{Kind: EventThinkingDelta, Text: payloadString(body, "text")}, true
	case "tool.generating":
		return Event{Kind: EventToolGenerating, Tool: &ToolEvent{Name: payloadString(body, "name")}}, true
	case "tool.start":
		return Event{Kind: EventToolStart, Tool: &ToolEvent{
			ID:      payloadString(body, "tool_id"),
			Name:    payloadString(body, "name"),
			Context: payloadString(body, "context"),
		}}, true
	case "tool.complete":
		return Event{Kind: EventToolComplete, Tool: &ToolEvent{
			ID:        payloadString(body, "tool_id"),
			Name:      payloadString(body, "name"),
			Summary:   payloadString(body, "summary"),
			DurationS: payloadFloat(body, "duration_s"),
			Result:    body["result"],
		}}, true
	case "approval.request":
		return Event{Kind: EventApproval, Prompt: &PromptEvent{
			Command: payloadString(body, "command"),
			ToolID:  payloadString(body, "tool_id"),
		}}, true
	case "clarify.request":
		prompt := &PromptEvent{
			RequestID: payloadString(body, "request_id"),
			Question:  payloadString(body, "question"),
		}
		if raw, ok := body["choices"]; ok {
			_ = json.Unmarshal(raw, &prompt.Choices)
		}
		return Event{Kind: EventClarify, Prompt: prompt}, true
	case "sudo.request":
		return Event{Kind: EventSudo, Prompt: &PromptEvent{
			RequestID: payloadString(body, "request_id"),
		}}, true
	case "secret.request":
		return Event{Kind: EventSecret, Prompt: &PromptEvent{
			RequestID: payloadString(body, "request_id"),
			Question:  payloadString(body, "prompt"),
			EnvVar:    payloadString(body, "env_var"),
			Metadata:  body["metadata"],
		}}, true
	case "session.info":
		return Event{Kind: EventSessionInfo, Info: ev.Fields["payload"]}, true
	case "error":
		return Event{Kind: EventError, Text: payloadString(body, "message")}, true
	default:
		return Event{}, false
	}
}

func payloadString(body map[string]json.RawMessage, key string) string {
	raw, ok := body[key]
	if !ok {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

func payloadFloat(body map[string]json.RawMessage, key string) float64 {
	raw, ok := body[key]
	if !ok {
		return 0
	}
	var f float64
	if json.Unmarshal(raw, &f) != nil {
		return 0
	}
	return f
}
