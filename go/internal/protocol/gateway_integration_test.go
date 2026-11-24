package protocol_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Stuko0/alice-agent/go/internal/protocol"
)

// This file is an opt-in conformance test against the real Python gateway.
// `go test ./...` stays hermetic and fast; run this with:
//
//	ALICE_GO_INTEGRATION=1 go test ./internal/protocol -run Gateway -v
//
// It is the proof that the Go side of the contract matches the Python side:
// gateway.ready, a normal response, an unknown method and a rejected params
// shape, then a clean shutdown on stdin EOF.

const frameTimeout = 45 * time.Second

func TestGatewayHandshake(t *testing.T) {
	if os.Getenv("ALICE_GO_INTEGRATION") != "1" {
		t.Skip("set ALICE_GO_INTEGRATION=1 to run against the Python gateway")
	}

	repoRoot, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	python := findPython(t, repoRoot)

	cmd := exec.Command(python, "-m", "tui_gateway.entry")
	cmd.Dir = repoRoot
	cmd.Env = append(os.Environ(),
		"ALICE_HOME="+t.TempDir(),
		"PYTHONUNBUFFERED=1",
	)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		t.Fatalf("start gateway: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	t.Cleanup(func() {
		_ = stdin.Close()
		select {
		case <-exited:
		case <-time.After(10 * time.Second):
			_ = cmd.Process.Kill()
		}
	})

	frames := readFrames(stdout)
	writer := protocol.NewWriter(stdin)

	// 1. The gateway announces itself before accepting requests.
	ready := nextFrame(t, frames)
	if ready.Kind != protocol.KindEvent || ready.Event.Type != "gateway.ready" {
		t.Fatalf("first frame = %+v, want gateway.ready event", ready)
	}

	// 2. A normal request gets a response with the same id.
	if err := writer.Write(protocol.Request{
		JSONRPC: protocol.Version,
		ID:      json.RawMessage(`"r1"`),
		Method:  "session.list",
		Params:  json.RawMessage(`{}`),
	}); err != nil {
		t.Fatalf("write session.list: %v", err)
	}
	resp := nextResponse(t, frames, `"r1"`)
	if resp.Failed() {
		t.Fatalf("session.list failed: %+v", resp.Error)
	}

	// 3. Unknown methods are -32601.
	if err := writer.Write(protocol.Request{
		JSONRPC: protocol.Version,
		ID:      json.RawMessage(`"r2"`),
		Method:  "does.not.exist",
	}); err != nil {
		t.Fatalf("write unknown method: %v", err)
	}
	resp = nextResponse(t, frames, `"r2"`)
	if resp.Error == nil || resp.Error.Code != protocol.CodeMethodNotFound {
		t.Fatalf("unknown method error = %+v", resp.Error)
	}

	// 4. Non-object params are -32602.
	if err := writer.WriteRaw([]byte(
		`{"jsonrpc":"2.0","id":"r3","method":"session.list","params":[]}`,
	)); err != nil {
		t.Fatalf("write bad params: %v", err)
	}
	resp = nextResponse(t, frames, `"r3"`)
	if resp.Error == nil || resp.Error.Code != protocol.CodeInvalidParams {
		t.Fatalf("bad params error = %+v", resp.Error)
	}

	// 5. Closing stdin is a clean shutdown (exit 0).
	if err := stdin.Close(); err != nil {
		t.Fatalf("close stdin: %v", err)
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("gateway exited with %v\nstderr:\n%s", err, tail(stderr.String()))
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("gateway did not exit after stdin EOF\nstderr:\n%s", tail(stderr.String()))
	}
}

func findPython(t *testing.T, repoRoot string) string {
	t.Helper()
	if explicit := os.Getenv("ALICE_PYTHON"); explicit != "" {
		return explicit
	}
	names := []string{filepath.Join(".venv", "bin", "python")}
	if runtime.GOOS == "windows" {
		names = []string{filepath.Join(".venv", "Scripts", "python.exe")}
	}
	for _, name := range names {
		candidate := filepath.Join(repoRoot, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	t.Skipf("no .venv Python under %s; set ALICE_PYTHON to run the integration test", repoRoot)
	return ""
}

func readFrames(r io.Reader) <-chan protocol.Frame {
	out := make(chan protocol.Frame, 32)
	reader := protocol.NewReader(r)
	go func() {
		defer close(out)
		for {
			frame, err := reader.Next()
			if err != nil {
				if !errors.Is(err, io.EOF) {
					// Surfaced as a timeout/failure by the nextFrame helper.
					_ = err
				}
				return
			}
			out <- frame
		}
	}()
	return out
}

func nextFrame(t *testing.T, frames <-chan protocol.Frame) protocol.Frame {
	t.Helper()
	select {
	case frame, ok := <-frames:
		if !ok {
			t.Fatal("gateway closed stdout before the expected frame")
		}
		return frame
	case <-time.After(frameTimeout):
		t.Fatal("timed out waiting for a frame from the gateway")
	}
	return protocol.Frame{}
}

func nextResponse(t *testing.T, frames <-chan protocol.Frame, id string) *protocol.Response {
	t.Helper()
	deadline := time.After(frameTimeout)
	for {
		select {
		case frame, ok := <-frames:
			if !ok {
				t.Fatalf("gateway closed stdout while waiting for response %s", id)
			}
			if frame.Kind == protocol.KindResponse && string(frame.Response.ID) == id {
				return frame.Response
			}
			// Events (or other responses) can interleave; keep reading.
		case <-deadline:
			t.Fatalf("timed out waiting for response %s", id)
		}
	}
}

func tail(s string) string {
	s = strings.TrimSpace(s)
	const max = 4000
	if len(s) <= max {
		return s
	}
	return "..." + s[len(s)-max:]
}
