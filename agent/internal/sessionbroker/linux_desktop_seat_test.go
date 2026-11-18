package sessionbroker

import "testing"

func TestParseLogindSeatActiveSession(t *testing.T) {
	cases := []struct {
		name   string
		out    string
		wantID string
		wantOK bool
	}{
		{"active", "ActiveSession=3\n", "3", true},
		{"active with noise", "Id=seat0\nActiveSession=c2\n", "c2", true},
		{"no active session", "ActiveSession=\n", "", true},
		{"property missing", "Id=seat0\n", "", false},
		{"malformed id", "ActiveSession=3;rm\n", "", false},
		{"overlong id", "ActiveSession=" + "a12345678901234567890123456789012\n", "", false},
		{"empty output", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			id, ok := parseLogindSeatActiveSession(tc.out)
			if id != tc.wantID || ok != tc.wantOK {
				t.Fatalf("parseLogindSeatActiveSession(%q) = %q, %v; want %q, %v", tc.out, id, ok, tc.wantID, tc.wantOK)
			}
		})
	}
}

func TestActiveSeatDetectedSession(t *testing.T) {
	st := parseLogindShowSession("3", "Id=3\nUser=1000\nType=wayland\nState=active\nClass=user\nRemote=no\n")
	got := activeSeatDetectedSession("3", st)
	if got == nil {
		t.Fatal("activeSeatDetectedSession returned nil for a complete answer")
	}
	if got.Session != "3" || got.UID != 1000 || got.LogindType != "wayland" || got.State != "active" ||
		got.Class != "user" || got.IsRemote || got.Seat != linuxDesktopSeat || got.PropertiesUnknown {
		t.Fatalf("unexpected detected session: %+v", *got)
	}

	// An incomplete answer is carried as PropertiesUnknown, never as facts.
	partial := parseLogindShowSession("3", "Id=3\nType=x11\n")
	got = activeSeatDetectedSession("3", partial)
	if got == nil || !got.PropertiesUnknown {
		t.Fatalf("incomplete logind answer must be PropertiesUnknown, got %+v", got)
	}

	// logind answered for a different id: there is no such session.
	if got := activeSeatDetectedSession("3", parseLogindShowSession("3", "Id=4\nUser=1000\nType=x11\nState=active\nClass=user\nRemote=no\n")); got != nil {
		t.Fatalf("a mismatched id must yield no session, got %+v", *got)
	}
}
