package host

import (
	"reflect"
	"testing"
)

func TestParseGlobalArgs(t *testing.T) {
	tests := []struct {
		name    string
		args    []string
		ok      bool
		profile string
		rest    []string
	}{
		{name: "host", args: []string{"host", "env"}, ok: true, rest: []string{"host", "env"}},
		{name: "profile short", args: []string{"-p", "work", "host", "env"}, ok: true, profile: "work", rest: []string{"host", "env"}},
		{name: "profile long", args: []string{"--profile", "work", "host"}, ok: true, profile: "work", rest: []string{"host"}},
		{name: "profile equals", args: []string{"--profile=work", "host"}, ok: true, profile: "work", rest: []string{"host"}},
		{name: "value flag skipped", args: []string{"-m", "gpt-5", "host", "env"}, ok: true, rest: []string{"host", "env"}},
		{name: "optional value consumed", args: []string{"-c", "host"}, ok: true, rest: nil},
		{name: "double dash", args: []string{"--", "host"}, ok: true, rest: []string{"host"}},
		{name: "unknown flag", args: []string{"--frobnicate", "host"}, ok: false},
		{name: "profile without value", args: []string{"--profile"}, ok: false},
		{name: "empty", args: nil, ok: true, rest: nil},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseGlobalArgs(tc.args)
			if got.OK != tc.ok {
				t.Fatalf("OK = %v, want %v", got.OK, tc.ok)
			}
			if got.Profile != tc.profile {
				t.Fatalf("profile = %q, want %q", got.Profile, tc.profile)
			}
			if !reflect.DeepEqual(got.Rest, tc.rest) {
				t.Fatalf("rest = %#v, want %#v", got.Rest, tc.rest)
			}
		})
	}
}

func TestValidateProfileName(t *testing.T) {
	for _, ok := range []string{"work", "a", "team-1", "x_y", "default", "DEFAULT"} {
		if err := ValidateProfileName(ok); err != nil {
			t.Fatalf("%q rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "-work", "Work!", "has space", "no:xdist", "a2345678901234567890123456789012345678901234567890123456789012345"} {
		if err := ValidateProfileName(bad); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}
