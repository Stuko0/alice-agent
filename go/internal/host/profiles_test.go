package host

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultRoot(t *testing.T) {
	tests := []struct {
		name string
		r    Resolver
		want string
	}{
		{
			name: "native posix",
			r:    Resolver{GOOS: "linux", HomeDir: "/home/u"},
			want: "/home/u/.alice",
		},
		{
			name: "native windows",
			r:    Resolver{GOOS: "windows", HomeDir: `C:\Users\u`, LocalAppData: `C:\Users\u\AppData\Local`},
			want: filepath.Join(`C:\Users\u\AppData\Local`, "alice"),
		},
		{
			name: "ALICE_HOME under native collapses to native",
			r:    Resolver{GOOS: "linux", HomeDir: "/home/u", AliceHomeEnv: "/home/u/.alice/profiles/work"},
			want: "/home/u/.alice",
		},
		{
			name: "custom deployment keeps ALICE_HOME",
			r:    Resolver{GOOS: "linux", HomeDir: "/home/u", AliceHomeEnv: "/opt/data"},
			want: "/opt/data",
		},
		{
			name: "custom profile path collapses to root",
			r:    Resolver{GOOS: "linux", HomeDir: "/home/u", AliceHomeEnv: "/opt/data/profiles/work"},
			want: "/opt/data",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.r.DefaultRoot(); got != tc.want {
				t.Fatalf("DefaultRoot = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestHomeStickyProfile(t *testing.T) {
	root := t.TempDir()
	profileDir := filepath.Join(root, ".alice", "profiles", "work")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		t.Fatal(err)
	}

	r := Resolver{
		GOOS:     "linux",
		HomeDir:  root,
		ReadFile: func(string) ([]byte, error) { return []byte("work\n"), nil },
	}
	home, source := r.Home()
	if home != profileDir {
		t.Fatalf("home = %q, want %q", home, profileDir)
	}
	if source != "profile:work" {
		t.Fatalf("source = %q", source)
	}
}

func TestHomeExplicitProfileWins(t *testing.T) {
	root := t.TempDir()
	profileDir := filepath.Join(root, ".alice", "profiles", "work")

	r := Resolver{
		GOOS:               "linux",
		HomeDir:            root,
		Profile:            "work",
		HomeOverride:       profileDir,
		HomeOverrideSource: "profile:work",
		ReadFile:           func(string) ([]byte, error) { return []byte("other"), nil },
	}
	home, source := r.Home()
	if home != profileDir || source != "profile:work" {
		t.Fatalf("home=%q source=%q", home, source)
	}
}

func TestHomeTrustsProfileALICEHOME(t *testing.T) {
	profileDir := "/opt/data/profiles/work"
	r := Resolver{
		GOOS:         "linux",
		HomeDir:      "/home/u",
		AliceHomeEnv: profileDir,
		// A sticky file must not override an ALICE_HOME that already points
		// at a profile.
		ReadFile: func(string) ([]byte, error) { return []byte("other"), nil },
	}
	home, source := r.Home()
	if home != profileDir || source != "ALICE_HOME" {
		t.Fatalf("home=%q source=%q", home, source)
	}
}

func TestHomeSupervisedChildIgnoresStickyProfile(t *testing.T) {
	r := Resolver{
		GOOS:            "linux",
		HomeDir:         "/home/u",
		SupervisedChild: true,
		ReadFile:        func(string) ([]byte, error) { return []byte("work"), nil },
	}
	home, source := r.Home()
	if home != "/home/u/.alice" || source != "default" {
		t.Fatalf("home=%q source=%q", home, source)
	}
}

func TestResolveProfile(t *testing.T) {
	root := t.TempDir()
	workDir := filepath.Join(root, ".alice", "profiles", "work")
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		t.Fatal(err)
	}

	r := Resolver{GOOS: "linux", HomeDir: root, Stat: os.Stat}

	got, err := r.ResolveProfile("work")
	if err != nil || got != workDir {
		t.Fatalf("work = %q, %v", got, err)
	}

	got, err = r.ResolveProfile("DEFAULT")
	if err != nil || got != filepath.Join(root, ".alice") {
		t.Fatalf("default = %q, %v", got, err)
	}

	if _, err := r.ResolveProfile("missing"); err == nil {
		t.Fatal("expected an error for a missing profile")
	}
	if _, err := r.ResolveProfile("bad/name"); err == nil {
		t.Fatal("expected an error for an invalid profile name")
	}
}
