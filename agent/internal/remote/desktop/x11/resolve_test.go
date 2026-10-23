package x11

import (
	"reflect"
	"testing"
)

func TestParseXSocketInodes(t *testing.T) {
	out := "Num RefCount Protocol Flags Type St Inode Path\n" +
		"0000000000000000: 00000002 00000000 00010000 0001 01 12345 /tmp/.X11-unix/X1\n" +
		"0000000000000000: 00000002 00000000 00010000 0001 01 12346 @/tmp/.X11-unix/X1\n" +
		"0000000000000000: 00000002 00000000 00010000 0001 01 12347 /tmp/.X11-unix/X10\n" +
		"0000000000000000: 00000002 00000000 00000000 0001 03 12348 /tmp/.X11-unix/X1\n" +
		"0000000000000000: 00000002 00000000 00010000 0002 01 12349 /tmp/.X11-unix/X1\n" +
		"0000000000000000: 00000002 00000000 invalid 0001 01 12350 /tmp/.X11-unix/X1\n" +
		"0000000000000000: 00000002 00000000 00010000 0001 01 invalid /tmp/.X11-unix/X1\n" +
		"0000000000000000: 00000002 00000000 00010000 0001 01 0 /tmp/.X11-unix/X1\n" +
		"short line\n"
	want := map[string]struct{}{"12345": {}, "12346": {}}
	if got := parseXSocketInodes(out, "1"); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseXSocketInodes = %v, want %v", got, want)
	}
	if got := parseXSocketInodes("", "1"); len(got) != 0 {
		t.Fatalf("empty input returned %v", got)
	}
}

func TestHasXSocket(t *testing.T) {
	inodes := map[string]struct{}{"12345": {}}
	for _, tc := range []struct {
		name  string
		links []string
		want  bool
	}{
		{"matching fd", []string{"/dev/tty2", "socket:[12345]"}, true},
		{"different inode", []string{"socket:[99999]"}, false},
		{"not a socket", []string{"pipe:[12345]", "/tmp/socket:[12345]"}, false},
		{"malformed link", []string{"socket:[12345", "socket:[12345]extra"}, false},
		{"empty listing", nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := hasXSocket(tc.links, inodes); got != tc.want {
				t.Fatalf("hasXSocket = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestParseAuthArg(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want string
	}{
		{"xorg with -auth", []string{"/usr/lib/xorg/Xorg", ":10", "-auth", "/run/user/1001/gdm/Xauthority", "-nolisten", "tcp"}, "/run/user/1001/gdm/Xauthority"},
		{"xrdp Xorg auth", []string{"Xorg", ":10", "-auth", ".Xauthority", "-config", "xrdp/xorg.conf"}, ".Xauthority"},
		{"no auth arg", []string{"Xorg", ":0", "-nolisten", "tcp"}, ""},
		{"auth is last with no value", []string{"Xorg", ":0", "-auth"}, ""},
		{"empty argv", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseAuthArg(tc.argv); got != tc.want {
				t.Fatalf("parseAuthArg = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseLoginctlSessions(t *testing.T) {
	// `loginctl list-sessions --no-legend` style, plus we resolve details per
	// session; here we test the summary parser tolerant of the columnar output.
	out := "  c39 1001 todd  seat0 tty2\n" +
		"  c87    0 root       tty1\n"
	got := parseLoginctlSessions(out)
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d (%v)", len(got), got)
	}
	if got[0].id != "c39" || got[0].uid != 1001 || got[0].user != "todd" {
		t.Fatalf("first session mismatch: %+v", got[0])
	}
	if got[1].uid != 0 || got[1].user != "root" {
		t.Fatalf("second session mismatch: %+v", got[1])
	}
}
