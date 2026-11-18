package sessionbroker

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestUILocaleRecordedAndSanitizedAtAuth(t *testing.T) {
	cases := map[string]string{
		"de-DE":                           "de-DE",
		"  fr_CA.UTF-8 ":                  "fr_CA.UTF-8",
		"sr_RS@latin":                     "sr_RS@latin",
		"":                                "",
		"de-DE\n<b>":                      "",
		"ja-JP\u202e":                     "",
		strings.Repeat("a", 36):           "",
		"en-x-" + strings.Repeat("a", 31): "",
	}
	for in, want := range cases {
		s := &Session{}
		applyAuthAdvertisements(s, ipc.HelperRoleAssist, ipc.AuthRequest{ProtocolVersion: 1, UILocale: in})
		if got := s.UILocale(); got != want {
			t.Errorf("UILocale(%q) = %q, want %q", in, got, want)
		}
		s2 := &Session{}
		s2.ApplyPromptAuthForTest(ipc.HelperRoleAssist, ipc.AuthRequest{ProtocolVersion: 1, UILocale: in})
		if got := s2.UILocale(); got != want {
			t.Errorf("test seam UILocale(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestUILocaleInWinSessionSkipsSystemAndOtherSessions(t *testing.T) {
	b := &Broker{sessions: map[string]*Session{}}
	t0 := time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)
	add := func(id string, role ipc.HelperRole, ws, loc string, at time.Time) {
		s := &Session{SessionID: id, HelperRole: role, WinSessionID: ws, ConnectedAt: at}
		s.ApplyPromptAuthForTest(role, ipc.AuthRequest{ProtocolVersion: 1, UILocale: loc})
		b.sessions[id] = s
	}
	add("sys-2", ipc.HelperRoleSystem, "2", "en-US", t0.Add(time.Hour))
	add("user-2-old", ipc.HelperRoleUser, "2", "it-IT", t0)
	add("assist-2", ipc.HelperRoleAssist, "2", "de-DE", t0.Add(time.Minute))
	add("assist-3", ipc.HelperRoleAssist, "3", "fr-FR", t0.Add(2*time.Hour))
	add("user-4", ipc.HelperRoleUser, "4", "", t0)
	if got := b.UILocaleInWinSession("2"); got != "de-DE" {
		t.Fatalf("session 2 = %q, want the newest user-context de-DE", got)
	}
	if got := b.UILocaleInWinSession("4"); got != "" {
		t.Fatalf("session 4 = %q, want none", got)
	}
	if got := b.UILocaleInWinSession(""); got != "" {
		t.Fatalf("empty session = %q", got)
	}
}
