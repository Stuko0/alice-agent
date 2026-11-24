package host

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func doctorResolver(t *testing.T) (Resolver, string) {
	t.Helper()
	home := t.TempDir()
	return Resolver{
		GOOS:         "linux",
		HomeDir:      home,
		AliceHomeEnv: home,
		PythonEnv:    "/fake/python",
		Stat:         os.Stat,
		ReadFile:     os.ReadFile,
	}, home
}

func fakeImport() func(context.Context, string) ([]byte, error) {
	return func(context.Context, string) ([]byte, error) { return nil, nil }
}

func TestDoctorReportWarnsOnFreshHome(t *testing.T) {
	resolver, _ := doctorResolver(t)
	env := doctorEnv{resolver: resolver, runImport: fakeImport()}

	var out, errb bytes.Buffer
	code := env.report(&out, &errb, false)
	if code != 0 {
		t.Fatalf("exit = %d, want 0 (warnings are not failures)\n%s", code, out.String())
	}
	if !bytes.Contains(out.Bytes(), []byte("2 warn")) {
		t.Fatalf("output = %s", out.String())
	}
}

func TestDoctorReportAllOK(t *testing.T) {
	resolver, home := doctorResolver(t)
	for _, name := range []string{"config.yaml", "state.db"} {
		if err := os.WriteFile(filepath.Join(home, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	env := doctorEnv{resolver: resolver, runImport: fakeImport()}

	var out, errb bytes.Buffer
	code := env.report(&out, &errb, false)
	if code != 0 {
		t.Fatalf("exit = %d\n%s", code, out.String())
	}
	if !bytes.Contains(out.Bytes(), []byte("0 warn")) {
		t.Fatalf("output = %s", out.String())
	}
}

func TestDoctorReportFailsWhenImportFails(t *testing.T) {
	resolver, _ := doctorResolver(t)
	env := doctorEnv{
		resolver: resolver,
		runImport: func(context.Context, string) ([]byte, error) {
			return []byte("ModuleNotFoundError: alice_cli"), errors.New("exit status 1")
		},
	}

	var out, errb bytes.Buffer
	code := env.report(&out, &errb, false)
	if code != 1 {
		t.Fatalf("exit = %d, want 1\n%s", code, out.String())
	}
	if !bytes.Contains(out.Bytes(), []byte("1 fail")) {
		t.Fatalf("output = %s", out.String())
	}
}

func TestDoctorJSON(t *testing.T) {
	resolver, home := doctorResolver(t)
	for _, name := range []string{"config.yaml", "state.db"} {
		if err := os.WriteFile(filepath.Join(home, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	env := doctorEnv{resolver: resolver, runImport: fakeImport()}

	var out, errb bytes.Buffer
	if code := env.report(&out, &errb, true); code != 0 {
		t.Fatalf("exit = %d", code)
	}

	var report struct {
		OK     int           `json:"ok"`
		Warn   int           `json:"warn"`
		Fail   int           `json:"fail"`
		Checks []doctorCheck `json:"checks"`
	}
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("invalid JSON: %v\n%s", err, out.String())
	}
	if report.Fail != 0 || report.OK != 4 || len(report.Checks) != 4 {
		t.Fatalf("report = %+v", report)
	}
}

func TestDoctorRejectsUnknownFlag(t *testing.T) {
	var out, errb bytes.Buffer
	code := hostDoctor(Options{
		Args:     []string{"--bogus"},
		Stdout:   &out,
		Stderr:   &errb,
		Resolver: Resolver{GOOS: "linux"},
	}, []string{"--bogus"})
	if code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
}
