package host

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

type fakeRunner struct {
	argv []string
	code int
	err  error
}

func (f *fakeRunner) Run(argv []string, _ io.Reader, _, _ io.Writer) (int, error) {
	f.argv = append([]string(nil), argv...)
	return f.code, f.err
}

func testResolver() Resolver {
	return Resolver{
		GOOS:         "linux",
		HomeDir:      "/home/u",
		AliceHomeEnv: "/home/u/.alice",
		PythonEnv:    "/py/python",
	}
}

func TestDelegatesUnknownCommandsVerbatim(t *testing.T) {
	fr := &fakeRunner{}
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:     []string{"gateway", "status", "--json"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: testResolver(),
		Runner:   fr,
	})
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errb.String())
	}

	want := []string{"/py/python", "-m", "alice_cli.main", "gateway", "status", "--json"}
	if strings.Join(fr.argv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %v, want %v", fr.argv, want)
	}
}

func TestDelegatesVersionInsteadOfReimplementingIt(t *testing.T) {
	fr := &fakeRunner{}
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:     []string{"version"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: testResolver(),
		Runner:   fr,
	})
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if len(fr.argv) == 0 || fr.argv[len(fr.argv)-1] != "version" {
		t.Fatalf("version was not delegated: %v", fr.argv)
	}
}

func TestDelegatesWithNoArguments(t *testing.T) {
	fr := &fakeRunner{}
	var out, errb bytes.Buffer

	Main(Options{Stdout: &out, Stderr: &errb, Resolver: testResolver(), Runner: fr})

	want := []string{"/py/python", "-m", "alice_cli.main"}
	if strings.Join(fr.argv, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("argv = %v, want %v", fr.argv, want)
	}
}

func TestPropagatesChildExitCode(t *testing.T) {
	fr := &fakeRunner{code: 3}
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:     []string{"gateway"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: testResolver(),
		Runner:   fr,
	})
	if code != 3 {
		t.Fatalf("exit = %d, want 3", code)
	}
}

func TestLaunchFailureBecomes127(t *testing.T) {
	fr := &fakeRunner{err: errors.New("boom")}
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:     []string{"gateway"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: testResolver(),
		Runner:   fr,
	})
	if code != 127 {
		t.Fatalf("exit = %d, want 127", code)
	}
	if !strings.Contains(errb.String(), "failed to launch") {
		t.Fatalf("stderr = %q", errb.String())
	}
}

func TestMissingPythonIsReported(t *testing.T) {
	r := Resolver{
		GOOS:       "linux",
		HomeDir:    t.TempDir(),
		Executable: noExecutable,
		WorkingDir: noWorkdir,
		LookPath:   noLookPath,
		Stat:       missing,
	}
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:     []string{"gateway"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: r,
		Runner:   &fakeRunner{},
	})
	if code != 127 {
		t.Fatalf("exit = %d, want 127", code)
	}
	if !strings.Contains(errb.String(), "no Python interpreter found") {
		t.Fatalf("stderr = %q", errb.String())
	}
}

func TestHostEnvEmitsJSON(t *testing.T) {
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:      []string{"host", "env"},
		Stdout:    &out,
		Stderr:    &errb,
		Resolver:  testResolver(),
		Runner:    &fakeRunner{},
		Version:   "1.2.3",
		Commit:    "abc1234",
		BuildDate: "2026-11-24T00:00:00Z",
	})
	if code != 0 {
		t.Fatalf("exit = %d, stderr = %s", code, errb.String())
	}

	var got envReport
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, out.String())
	}
	if got.HostVersion != "1.2.3" || got.Commit != "abc1234" {
		t.Fatalf("build info = %+v", got)
	}
	if got.AliceHome != "/home/u/.alice" || got.AliceHomeSource != "ALICE_HOME" {
		t.Fatalf("home = %+v", got)
	}
	if got.Python != "/py/python" || got.PythonSource != "ALICE_PYTHON" {
		t.Fatalf("python = %+v", got)
	}
}

func TestHostEnvReportsPythonFailure(t *testing.T) {
	r := Resolver{
		GOOS:       "linux",
		HomeDir:    t.TempDir(),
		Executable: noExecutable,
		WorkingDir: noWorkdir,
		LookPath:   noLookPath,
		Stat:       missing,
	}
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:     []string{"host", "env"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: r,
		Runner:   &fakeRunner{},
	})
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}

	var got envReport
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if got.PythonError == "" {
		t.Fatal("expected python_error to be set")
	}
}

func TestHostUnknownSubcommand(t *testing.T) {
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:     []string{"host", "nope"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: testResolver(),
		Runner:   &fakeRunner{},
	})
	if code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
}

func TestHostHelp(t *testing.T) {
	var out, errb bytes.Buffer

	code := Main(Options{
		Args:     []string{"host", "help"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: testResolver(),
		Runner:   &fakeRunner{},
	})
	if code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(out.String(), "alice host") {
		t.Fatalf("stdout = %q", out.String())
	}
}
