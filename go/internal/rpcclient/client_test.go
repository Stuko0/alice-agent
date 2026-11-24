package rpcclient

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/Stuko0/alice-agent/go/internal/protocol"
)

func pipeClient(t *testing.T, handle func(*protocol.Reader, *protocol.Writer)) *Client {
	t.Helper()
	clientConn, serverConn := net.Pipe()
	t.Cleanup(func() { _ = serverConn.Close() })

	reader := protocol.NewReader(serverConn)
	writer := protocol.NewWriter(serverConn)

	go func() {
		_ = writer.WriteRaw([]byte(
			`{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"skin":"default"}}}`,
		))
		handle(reader, writer)
	}()

	return newClient(clientConn, clientConn, func() error { return clientConn.Close() }, 8)
}

func TestCallInterleavesEventsAndMatchesID(t *testing.T) {
	c := pipeClient(t, func(reader *protocol.Reader, writer *protocol.Writer) {
		for {
			frame, err := reader.Next()
			if err != nil {
				return
			}
			if frame.Kind != protocol.KindRequest {
				continue
			}
			_ = writer.WriteEvent(protocol.Event{
				Type:      "message.delta",
				SessionID: "s-1",
				Fields:    map[string]json.RawMessage{"text": json.RawMessage(`"hi"`)},
			})
			_ = writer.Write(protocol.Response{
				JSONRPC: protocol.Version,
				ID:      frame.Request.ID,
				Result:  json.RawMessage(`{"session_id":"s-abc"}`),
			})
		}
	})
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := c.waitReady(ctx); err != nil {
		t.Fatalf("waitReady: %v", err)
	}

	var out struct {
		SessionID string `json:"session_id"`
	}
	if err := c.CallInto(ctx, "session.create", map[string]string{"cwd": "/repo"}, &out); err != nil {
		t.Fatalf("call: %v", err)
	}
	if out.SessionID != "s-abc" {
		t.Fatalf("session = %q", out.SessionID)
	}

	select {
	case ev := <-c.Events():
		if ev.Type != "message.delta" || ev.SessionID != "s-1" {
			t.Fatalf("event = %+v", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("event was not delivered")
	}
}

func TestCallReturnsRPCError(t *testing.T) {
	c := pipeClient(t, func(reader *protocol.Reader, writer *protocol.Writer) {
		frame, err := reader.Next()
		if err != nil || frame.Kind != protocol.KindRequest {
			return
		}
		_ = writer.Write(protocol.Response{
			JSONRPC: protocol.Version,
			ID:      frame.Request.ID,
			Error:   &protocol.RPCError{Code: protocol.CodeMethodNotFound, Message: "unknown method"},
		})
	})
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.waitReady(ctx); err != nil {
		t.Fatalf("waitReady: %v", err)
	}

	_, err := c.Call(ctx, "does.not.exist", nil)
	var rpcErr *protocol.RPCError
	if !errors.As(err, &rpcErr) || rpcErr.Code != protocol.CodeMethodNotFound {
		t.Fatalf("err = %v", err)
	}
}
