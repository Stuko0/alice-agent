package cli

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/Stuko0/alice-agent/go/internal/rpcclient"
)

// Opt-in end-to-end test against the real Python gateway:
//
//	ALICE_CLI_E2E=1 go test ./internal/cli -run Gateway -v
//
// It makes one real model call (cheap model configured by the user's config),
// so it is never part of `go test ./...`.
func TestGatewayPromptE2E(t *testing.T) {
	if os.Getenv("ALICE_CLI_E2E") != "1" {
		t.Skip("set ALICE_CLI_E2E=1 to run a real turn against the gateway")
	}

	repoRoot, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	client, err := rpcclient.Start(ctx, rpcclient.Options{
		Python: e2ePython(t, repoRoot),
		Dir:    repoRoot,
	})
	if err != nil {
		t.Fatalf("start gateway: %v", err)
	}
	defer client.Close()

	engine := NewEngine(client)
	defer engine.Close()

	session, err := engine.NewSession(ctx)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Logf("session %s model %s", session.ID, engine.Model())

	if err := engine.Submit(ctx, "responde solo con la palabra: ok"); err != nil {
		t.Fatalf("submit: %v", err)
	}

	for {
		select {
		case ev, ok := <-engine.Events():
			if !ok {
				t.Fatal("event stream closed")
			}
			t.Logf("event kind=%d text=%q session=%s", ev.Kind, ev.Text, engine.SessionID())
			switch ev.Kind {
			case EventMessageComplete:
				return
			case EventError:
				t.Fatalf("backend error: %s", ev.Text)
			}
		case <-ctx.Done():
			t.Fatal("timed out waiting for the turn")
		}
	}
}

func e2ePython(t *testing.T, repoRoot string) string {
	t.Helper()
	if explicit := os.Getenv("ALICE_PYTHON"); explicit != "" {
		return explicit
	}
	name := filepath.Join(".venv", "bin", "python")
	if runtime.GOOS == "windows" {
		name = filepath.Join(".venv", "Scripts", "python.exe")
	}
	candidate := filepath.Join(repoRoot, name)
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate
	}
	t.Skipf("no .venv Python under %s", repoRoot)
	return ""
}

var _ = exec.Command

func TestGatewayRawEventShape(t *testing.T) {
	if os.Getenv("ALICE_CLI_E2E") != "1" {
		t.Skip("set ALICE_CLI_E2E=1 to inspect raw gateway events")
	}

	repoRoot, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	client, err := rpcclient.Start(ctx, rpcclient.Options{Python: e2ePython(t, repoRoot), Dir: repoRoot})
	if err != nil {
		t.Fatalf("start gateway: %v", err)
	}
	defer client.Close()

	var created struct {
		SessionID string `json:"session_id"`
	}
	if err := client.CallInto(ctx, "session.create", map[string]any{"cols": 80, "source": "go-cli"}, &created); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := client.CallInto(ctx, "prompt.submit", map[string]any{
		"session_id": created.SessionID,
		"text":       "responde solo con la palabra: ok",
	}, nil); err != nil {
		t.Fatalf("submit: %v", err)
	}

	for {
		select {
		case ev := <-client.Events():
			t.Logf("type=%s sid=%s fields=%v", ev.Type, ev.SessionID, ev.Fields)
			if ev.Type == "message.complete" {
				return
			}
		case <-ctx.Done():
			t.Fatal("timed out")
		}
	}
}
