package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

func TestRequestValidate(t *testing.T) {
	tests := []struct {
		name string
		req  Request
		code int // 0 == valid
	}{
		{name: "object params", req: Request{Method: "session.create", Params: json.RawMessage(`{"cwd":"/repo"}`)}},
		{name: "absent params", req: Request{Method: "session.list"}},
		{name: "null params", req: Request{Method: "session.list", Params: json.RawMessage(`null`)}},
		{name: "empty method", req: Request{Method: "  "}, code: CodeInvalidRequest},
		{name: "array params", req: Request{Method: "session.list", Params: json.RawMessage(`[1,2]`)}, code: CodeInvalidParams},
		{name: "string params", req: Request{Method: "session.list", Params: json.RawMessage(`"nope"`)}, code: CodeInvalidParams},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.req.Validate()
			if tc.code == 0 {
				if err != nil {
					t.Fatalf("expected valid, got %v", err)
				}
				return
			}
			if err == nil || err.Code != tc.code {
				t.Fatalf("expected code %d, got %v", tc.code, err)
			}
		})
	}
}

func TestDecodeFrameRequestPreservesID(t *testing.T) {
	for _, id := range []string{`"req-1"`, `7`} {
		line := []byte(`{"jsonrpc":"2.0","id":` + id + `,"method":"session.create","params":{"cwd":"/repo"}}`)
		frame, err := DecodeFrame(line)
		if err != nil {
			t.Fatalf("id %s: %v", id, err)
		}
		if frame.Kind != KindRequest || frame.Request == nil {
			t.Fatalf("id %s: kind = %v", id, frame.Kind)
		}
		if string(frame.Request.ID) != id {
			t.Fatalf("id = %s, want %s", frame.Request.ID, id)
		}
		if frame.Request.Method != "session.create" {
			t.Fatalf("method = %q", frame.Request.Method)
		}
	}
}

func TestDecodeFrameResponse(t *testing.T) {
	ok := []byte(`{"jsonrpc":"2.0","id":"1","result":{"session_id":"s-abc"}}`)
	frame, err := DecodeFrame(ok)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Kind != KindResponse || frame.Response.Failed() {
		t.Fatalf("kind=%v failed=%v", frame.Kind, frame.Response.Failed())
	}
	var result struct {
		SessionID string `json:"session_id"`
	}
	if err := frame.Response.Decode(&result); err != nil {
		t.Fatal(err)
	}
	if result.SessionID != "s-abc" {
		t.Fatalf("session = %q", result.SessionID)
	}

	bad := []byte(`{"jsonrpc":"2.0","id":"1","error":{"code":4009,"message":"session busy"}}`)
	frame, err = DecodeFrame(bad)
	if err != nil {
		t.Fatal(err)
	}
	if !frame.Response.Failed() || frame.Response.Error.Code != 4009 {
		t.Fatalf("error = %+v", frame.Response.Error)
	}
	if err := frame.Response.Decode(&result); err == nil {
		t.Fatal("Decode should return the RPC error")
	}
}

func TestDecodeFrameEvent(t *testing.T) {
	line := []byte(`{"jsonrpc":"2.0","method":"event","params":{"type":"tool.complete","session_id":"s-1","name":"terminal","result":{"ok":true}}}`)
	frame, err := DecodeFrame(line)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Kind != KindEvent || frame.Event == nil {
		t.Fatalf("kind = %v", frame.Kind)
	}
	if frame.Event.Type != "tool.complete" || frame.Event.SessionID != "s-1" {
		t.Fatalf("event = %+v", frame.Event)
	}
	if name, ok := frame.Event.String("name"); !ok || name != "terminal" {
		t.Fatalf("name = %q ok=%v", name, ok)
	}
	var result struct {
		OK bool `json:"ok"`
	}
	if err := frame.Event.Decode("result", &result); err != nil || !result.OK {
		t.Fatalf("result = %+v err=%v", result, err)
	}

	// gateway.ready has no session_id.
	ready := []byte(`{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"skin":"default"}}}`)
	frame, err = DecodeFrame(ready)
	if err != nil {
		t.Fatal(err)
	}
	if frame.Event.Type != "gateway.ready" || frame.Event.SessionID != "" {
		t.Fatalf("ready = %+v", frame.Event)
	}
}

func TestEventRoundTrip(t *testing.T) {
	original := Event{
		Type:      "message.delta",
		SessionID: "s-1",
		Fields:    map[string]json.RawMessage{"text": json.RawMessage(`"Hel"`)},
	}
	data, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	var decoded Event
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Type != original.Type || decoded.SessionID != original.SessionID {
		t.Fatalf("decoded = %+v", decoded)
	}
	if got, _ := decoded.String("text"); got != "Hel" {
		t.Fatalf("text = %q", got)
	}
}

func TestDecodeFrameRejectsGarbage(t *testing.T) {
	for _, line := range []string{
		`not json`,
		`{"jsonrpc":"2.0"}`,
		`{"jsonrpc":"2.0","method":"event"}`,
		`[]`,
	} {
		if _, err := DecodeFrame([]byte(line)); err == nil {
			t.Fatalf("expected an error for %s", line)
		}
	}
}

func TestNDJSONReader(t *testing.T) {
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"session.list"}`,
		``,
		`{"jsonrpc":"2.0","id":1,"result":{"ok":true}}`,
		`{"jsonrpc":"2.0","method":"event","params":{"type":"message.delta","text":"x"}}`,
	}, "\n")

	reader := NewReader(strings.NewReader(input))
	kinds := []FrameKind{}
	for {
		frame, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		kinds = append(kinds, frame.Kind)
	}
	want := []FrameKind{KindRequest, KindResponse, KindEvent}
	if len(kinds) != len(want) {
		t.Fatalf("kinds = %v", kinds)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Fatalf("kinds = %v, want %v", kinds, want)
		}
	}
}

func TestNDJSONWriter(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	if err := w.Write(Request{JSONRPC: Version, ID: json.RawMessage(`"a"`), Method: "session.list"}); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(buf.Bytes(), []byte("\n")) {
		t.Fatal("frame must end with a newline")
	}
	if bytes.Count(buf.Bytes(), []byte("\n")) != 1 {
		t.Fatalf("expected exactly one newline, got %q", buf.String())
	}
}

func TestNDJSONWriterSerializesConcurrentWrites(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := w.Write(Response{
				JSONRPC: Version,
				ID:      json.RawMessage(`1`),
				Result:  json.RawMessage(`{"ok":true}`),
			}); err != nil {
				t.Errorf("write: %v", err)
			}
		}()
	}
	wg.Wait()

	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != 50 {
		t.Fatalf("wrote %d lines, want 50", len(lines))
	}
	for _, line := range lines {
		if !json.Valid([]byte(line)) {
			t.Fatalf("corrupted line: %q", line)
		}
	}
}

func TestWriteEventProducesFullFrame(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)

	err := w.WriteEvent(Event{
		Type:      "tool.complete",
		SessionID: "s-1",
		Fields:    map[string]json.RawMessage{"name": json.RawMessage(`"terminal"`)},
	})
	if err != nil {
		t.Fatal(err)
	}

	frame, err := DecodeFrame(buf.Bytes())
	if err != nil {
		t.Fatalf("decode: %v (%s)", err, buf.String())
	}
	if frame.Kind != KindEvent || frame.Event.Type != "tool.complete" || frame.Event.SessionID != "s-1" {
		t.Fatalf("event = %+v", frame.Event)
	}
	if name, _ := frame.Event.String("name"); name != "terminal" {
		t.Fatalf("name = %q", name)
	}
}

func TestWriteRejectsBareEvent(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	if err := w.Write(Event{Type: "message.delta"}); err == nil {
		t.Fatal("Write must reject a bare Event; use WriteEvent")
	}
}
