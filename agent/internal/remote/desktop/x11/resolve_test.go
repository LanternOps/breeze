package x11

import "testing"

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
