// Package protocol implements the Alice JSON-RPC wire contract shared by the
// TUI, the desktop app and the dashboard.
//
// The contract is documented in docs/protocol/json-rpc.md and pinned by
// tests/tui_gateway/test_rpc_contract_doc.py. This package is the Go side of
// that contract: frame encoding/decoding and NDJSON framing, with no knowledge
// of any individual RPC method.
package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Version is the only JSON-RPC version the gateway speaks.
const Version = "2.0"

// EventMethod is the value of `method` on server-pushed event frames.
const EventMethod = "event"

// Standard JSON-RPC error codes. Application errors use positive codes and are
// defined by the handler that raises them.
const (
	CodeInvalidRequest = -32600
	CodeMethodNotFound = -32601
	CodeInvalidParams  = -32602
)

// Request is an inbound RPC call.
//
// ID is kept as raw JSON because the contract allows strings and numbers and
// the server must echo it back byte-for-byte.
type Request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// Validate mirrors tui_gateway.server._normalize_request: a non-empty method
// and an object (or absent/null) params.
func (r *Request) Validate() *RPCError {
	if strings.TrimSpace(r.Method) == "" {
		return &RPCError{
			Code:    CodeInvalidRequest,
			Message: "invalid request: method must be a non-empty string",
		}
	}
	params := bytes.TrimSpace(r.Params)
	if len(params) > 0 && !bytes.Equal(params, []byte("null")) && params[0] != '{' {
		return &RPCError{
			Code:    CodeInvalidParams,
			Message: "invalid params: expected an object",
		}
	}
	return nil
}

// RPCError is the error object inside a failed response.
type RPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string {
	return fmt.Sprintf("jsonrpc error %d: %s", e.Code, e.Message)
}

// Response is the reply to a Request. Exactly one of Result or Error is set.
type Response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *RPCError       `json:"error,omitempty"`
}

// Failed reports whether the response carries an error.
func (r *Response) Failed() bool { return r.Error != nil }

// Decode unmarshals the result into v.
func (r *Response) Decode(v any) error {
	if r.Error != nil {
		return r.Error
	}
	if len(r.Result) == 0 {
		return nil
	}
	return json.Unmarshal(r.Result, v)
}

// Event is an unsolicited server frame. The contract puts the event name in
// params.type and the conversation id in params.session_id; every other key is
// event-specific and preserved in Fields.
type Event struct {
	Type      string
	SessionID string
	Fields    map[string]json.RawMessage
}

// String returns a string field from the event payload.
func (e Event) String(key string) (string, bool) {
	raw, ok := e.Fields[key]
	if !ok {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// Decode unmarshals one event field into v.
func (e Event) Decode(key string, v any) error {
	raw, ok := e.Fields[key]
	if !ok {
		return fmt.Errorf("event %q has no field %q", e.Type, key)
	}
	return json.Unmarshal(raw, v)
}

// Payload decodes params.payload.
//
// The gateway nests every event body under `payload`; `type` and `session_id`
// are the only siblings. Returns nil for events with no body.
func (e Event) Payload() map[string]json.RawMessage {
	raw, ok := e.Fields["payload"]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

// UnmarshalJSON decodes the params object, keeping unknown keys.
func (e *Event) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if raw, ok := fields["type"]; ok {
		if err := json.Unmarshal(raw, &e.Type); err != nil {
			return fmt.Errorf("event type: %w", err)
		}
		delete(fields, "type")
	}
	if raw, ok := fields["session_id"]; ok {
		if err := json.Unmarshal(raw, &e.SessionID); err != nil {
			return fmt.Errorf("event session_id: %w", err)
		}
		delete(fields, "session_id")
	}
	e.Fields = fields
	return nil
}

// MarshalJSON re-emits the event with type and session_id first-class.
func (e Event) MarshalJSON() ([]byte, error) {
	fields := make(map[string]json.RawMessage, len(e.Fields)+2)
	for k, v := range e.Fields {
		fields[k] = v
	}
	if e.Type != "" {
		raw, err := json.Marshal(e.Type)
		if err != nil {
			return nil, err
		}
		fields["type"] = raw
	}
	if e.SessionID != "" {
		raw, err := json.Marshal(e.SessionID)
		if err != nil {
			return nil, err
		}
		fields["session_id"] = raw
	}
	return json.Marshal(fields)
}

// FrameKind identifies which shape a decoded frame has.
type FrameKind int

const (
	KindRequest FrameKind = iota
	KindResponse
	KindEvent
)

// Frame is one decoded wire frame.
type Frame struct {
	Kind     FrameKind
	Request  *Request
	Response *Response
	Event    *Event
}

// DecodeFrame classifies and decodes a single NDJSON line.
//
// Shape rules (see docs/protocol/json-rpc.md):
//   - method == "event"                          -> Event
//   - has id and (result or error)               -> Response
//   - has a non-empty method                     -> Request
func DecodeFrame(data []byte) (Frame, error) {
	var probe struct {
		Method string          `json:"method"`
		ID     json.RawMessage `json:"id"`
		Result json.RawMessage `json:"result"`
		Error  json.RawMessage `json:"error"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return Frame{}, fmt.Errorf("decode frame: %w", err)
	}

	switch {
	case probe.Method == EventMethod:
		if len(probe.Params) == 0 {
			return Frame{}, fmt.Errorf("decode frame: event without params")
		}
		var ev Event
		if err := json.Unmarshal(probe.Params, &ev); err != nil {
			return Frame{}, fmt.Errorf("decode event: %w", err)
		}
		return Frame{Kind: KindEvent, Event: &ev}, nil

	case len(probe.ID) > 0 && (len(probe.Result) > 0 || len(probe.Error) > 0):
		var resp Response
		if err := json.Unmarshal(data, &resp); err != nil {
			return Frame{}, fmt.Errorf("decode response: %w", err)
		}
		return Frame{Kind: KindResponse, Response: &resp}, nil

	case probe.Method != "":
		var req Request
		if err := json.Unmarshal(data, &req); err != nil {
			return Frame{}, fmt.Errorf("decode request: %w", err)
		}
		return Frame{Kind: KindRequest, Request: &req}, nil

	default:
		return Frame{}, fmt.Errorf("decode frame: not a request, response or event")
	}
}
