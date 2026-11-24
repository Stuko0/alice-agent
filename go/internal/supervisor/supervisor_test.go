package supervisor

import (
	"context"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestHelperProcess is not a real test: it is the child that Run supervises,
// re-exec'd from the test binary. It only acts when ALICE_SUPERVISOR_HELPER=1.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("ALICE_SUPERVISOR_HELPER") != "1" {
		return
	}
	if d := os.Getenv("HELPER_SLEEP"); d != "" {
		if dur, err := time.ParseDuration(d); err == nil {
			time.Sleep(dur)
		}
	}
	code := 0
	if c := os.Getenv("HELPER_EXIT"); c != "" {
		code, _ = strconv.Atoi(c)
	}
	os.Exit(code)
}

func helperEnv(sleep string, exit int) []string {
	env := make([]string, 0, len(os.Environ())+3)
	for _, kv := range os.Environ() {
		switch {
		case strings.HasPrefix(kv, "ALICE_SUPERVISOR_HELPER="),
			strings.HasPrefix(kv, "HELPER_SLEEP="),
			strings.HasPrefix(kv, "HELPER_EXIT="):
			continue
		}
		env = append(env, kv)
	}
	env = append(env,
		"ALICE_SUPERVISOR_HELPER=1",
		"HELPER_EXIT="+strconv.Itoa(exit),
	)
	if sleep != "" {
		env = append(env, "HELPER_SLEEP="+sleep)
	}
	return env
}

func helperSpec(sleep string, exit int) Spec {
	return Spec{
		Name:        os.Args[0],
		Args:        []string{"-test.run=TestHelperProcess", "--"},
		Env:         helperEnv(sleep, exit),
		Stdout:      io.Discard,
		Stderr:      io.Discard,
		MaxRestarts: 2,
		BackoffBase: 10 * time.Millisecond,
		BackoffMax:  20 * time.Millisecond,
	}
}

func TestSuccessDoesNotRestart(t *testing.T) {
	result := Run(context.Background(), helperSpec("", 0))
	if result.Err != nil {
		t.Fatalf("err = %v", result.Err)
	}
	if result.Restarts != 0 || result.LastExit != 0 {
		t.Fatalf("result = %+v", result)
	}
}

func TestFailureRestartsWithBackoffThenGivesUp(t *testing.T) {
	started := time.Now()
	result := Run(context.Background(), helperSpec("", 3))
	elapsed := time.Since(started)

	if result.Err == nil {
		t.Fatal("expected an error after exhausting restarts")
	}
	if result.Restarts != 2 {
		t.Fatalf("restarts = %d, want 2", result.Restarts)
	}
	if result.LastExit != 3 {
		t.Fatalf("last exit = %d, want 3", result.LastExit)
	}
	// 10ms + 20ms of scheduled backoff; allow scheduler slack.
	if elapsed < 25*time.Millisecond {
		t.Fatalf("elapsed = %s, backoff did not run", elapsed)
	}
}

func TestStopOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan Result, 1)
	go func() { done <- Run(ctx, helperSpec("10s", 0)) }()

	time.Sleep(150 * time.Millisecond)
	cancel()

	select {
	case result := <-done:
		if result.Err != nil {
			t.Fatalf("err = %v", result.Err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after the context was cancelled")
	}
}

func TestStartFailureSurfaces(t *testing.T) {
	result := Run(context.Background(), Spec{Name: "/definitely/not/a/binary"})
	if result.Err == nil {
		t.Fatal("expected a start error")
	}
}
