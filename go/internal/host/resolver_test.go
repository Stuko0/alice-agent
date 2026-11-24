package host

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func missing(string) (os.FileInfo, error) { return nil, os.ErrNotExist }

func noExecutable() (string, error) { return "", os.ErrNotExist }
func noWorkdir() (string, error)    { return "", os.ErrNotExist }
func noLookPath(string) (string, error) {
	return "", os.ErrNotExist
}

func TestHomePrefersALICEHOME(t *testing.T) {
	r := Resolver{GOOS: "linux", HomeDir: "/home/u", AliceHomeEnv: "/opt/alice/"}
	got, source := r.Home()
	if got != "/opt/alice" {
		t.Fatalf("home = %q, want /opt/alice", got)
	}
	if source != "ALICE_HOME" {
		t.Fatalf("source = %q, want ALICE_HOME", source)
	}
}

func TestHomePosixDefault(t *testing.T) {
	r := Resolver{GOOS: "linux", HomeDir: "/home/u"}
	got, source := r.Home()
	if got != filepath.Join("/home/u", ".alice") {
		t.Fatalf("home = %q", got)
	}
	if source != "default" {
		t.Fatalf("source = %q, want default", source)
	}
}

func TestHomeWindowsUsesLocalAppData(t *testing.T) {
	r := Resolver{GOOS: "windows", HomeDir: `C:\Users\u`, LocalAppData: `C:\Users\u\AppData\Local`}
	got, _ := r.Home()
	if got != filepath.Join(`C:\Users\u\AppData\Local`, "alice") {
		t.Fatalf("home = %q", got)
	}
}

func TestHomeWindowsFallsBackToProfile(t *testing.T) {
	r := Resolver{GOOS: "windows", HomeDir: `C:\Users\u`}
	got, _ := r.Home()
	if got != filepath.Join(`C:\Users\u`, "AppData", "Local", "alice") {
		t.Fatalf("home = %q", got)
	}
}

func TestPythonHonoursALICEPYTHON(t *testing.T) {
	r := Resolver{GOOS: "linux", PythonEnv: "/custom/python"}
	rt, err := r.Python()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rt.Python != "/custom/python" || rt.Source != "ALICE_PYTHON" {
		t.Fatalf("got %+v", rt)
	}
	if len(rt.Args) != 2 || rt.Args[0] != "-m" || rt.Args[1] != "alice_cli.main" {
		t.Fatalf("args = %v", rt.Args)
	}
}

func TestPythonFindsCheckoutVenv(t *testing.T) {
	root := t.TempDir()
	python := filepath.Join(root, ".venv", "bin", "python")
	touch(t, python)

	r := Resolver{
		GOOS:       "linux",
		HomeDir:    t.TempDir(),
		Executable: func() (string, error) { return filepath.Join(root, "go", "bin", "alice"), nil },
		WorkingDir: noWorkdir,
		LookPath:   noLookPath,
		Stat:       os.Stat,
	}
	rt, err := r.Python()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rt.Python != python {
		t.Fatalf("python = %q, want %q", rt.Python, python)
	}
	if rt.Source != "checkout" {
		t.Fatalf("source = %q, want checkout", rt.Source)
	}
}

func TestPythonFindsWindowsCheckoutVenv(t *testing.T) {
	root := t.TempDir()
	python := filepath.Join(root, ".venv", "Scripts", "python.exe")
	touch(t, python)

	r := Resolver{
		GOOS:       "windows",
		HomeDir:    t.TempDir(),
		Executable: func() (string, error) { return filepath.Join(root, "go", "bin", "alice.exe"), nil },
		WorkingDir: noWorkdir,
		LookPath:   noLookPath,
		Stat:       os.Stat,
	}
	rt, err := r.Python()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rt.Python != python {
		t.Fatalf("python = %q, want %q", rt.Python, python)
	}
}

func TestPythonFindsALICEHOMEVenv(t *testing.T) {
	home := t.TempDir()
	python := filepath.Join(home, "alice-agent", "venv", "bin", "python")
	touch(t, python)

	r := Resolver{
		GOOS:         "linux",
		HomeDir:      t.TempDir(),
		AliceHomeEnv: home,
		Executable:   noExecutable,
		WorkingDir:   noWorkdir,
		LookPath:     noLookPath,
		Stat:         os.Stat,
	}
	rt, err := r.Python()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rt.Python != python || rt.Source != "ALICE_HOME" {
		t.Fatalf("got %+v", rt)
	}
}

func TestPythonFallsBackToPath(t *testing.T) {
	r := Resolver{
		GOOS:       "linux",
		HomeDir:    t.TempDir(),
		Executable: noExecutable,
		WorkingDir: noWorkdir,
		LookPath: func(name string) (string, error) {
			if name == "python3" {
				return "/usr/bin/python3", nil
			}
			return "", os.ErrNotExist
		},
		Stat: func(path string) (os.FileInfo, error) {
			if path == "/usr/bin/python3" {
				return fakeInfo{}, nil
			}
			return nil, os.ErrNotExist
		},
	}
	rt, err := r.Python()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rt.Python != "/usr/bin/python3" || rt.Source != "PATH" {
		t.Fatalf("got %+v", rt)
	}
}

func TestPythonReportsWhenNothingIsFound(t *testing.T) {
	r := Resolver{
		GOOS:       "linux",
		HomeDir:    t.TempDir(),
		Executable: noExecutable,
		WorkingDir: noWorkdir,
		LookPath:   noLookPath,
		Stat:       missing,
	}
	if _, err := r.Python(); err == nil {
		t.Fatal("expected an error, got nil")
	}
}

type fakeInfo struct{}

func (fakeInfo) Name() string       { return "python" }
func (fakeInfo) Size() int64        { return 0 }
func (fakeInfo) Mode() os.FileMode  { return 0o755 }
func (fakeInfo) ModTime() time.Time { return time.Time{} }
func (fakeInfo) IsDir() bool        { return false }
func (fakeInfo) Sys() any           { return nil }
