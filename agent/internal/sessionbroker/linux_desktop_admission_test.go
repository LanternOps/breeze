package sessionbroker

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func desktopHelperAuth(ticket, logindSession string) ipc.AuthRequest {
	return ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		HelperRole:      ipc.HelperRoleUser,
		BinaryKind:      ipc.HelperBinaryDesktopHelper,
		SpawnTicket:     ticket,
		LogindSessionID: logindSession,
	}
}

func TestLinuxDesktopAdmission_Decision(t *testing.T) {
	userHelper := ipc.AuthRequest{HelperRole: ipc.HelperRoleUser, BinaryKind: ipc.HelperBinaryUserHelper}
	userHelperWithTicket := userHelper
	userHelperWithTicket.SpawnTicket = "t"
	userHelperWithSession := userHelper
	userHelperWithSession.LogindSessionID = "3"
	assistWithTicket := ipc.AuthRequest{HelperRole: ipc.HelperRoleAssist, BinaryKind: ipc.HelperBinaryAssistHelper, SpawnTicket: "t", LogindSessionID: "3"}
	systemDesktopWithTicket := ipc.AuthRequest{HelperRole: ipc.HelperRoleSystem, BinaryKind: ipc.HelperBinaryDesktopHelper, SpawnTicket: "t", LogindSessionID: "3"}

	cases := []struct {
		name       string
		goos       string
		req        ipc.AuthRequest
		wantLinux  bool
		wantReject string
	}{
		{"linux desktop helper with ticket", "linux", desktopHelperAuth("t", "3"), true, ""},
		{"linux desktop helper without ticket", "linux", desktopHelperAuth("", "3"), false, "requires a spawn ticket"},
		{"linux desktop helper without session", "linux", desktopHelperAuth("t", ""), false, "requires a logind session"},
		{"linux desktop helper with nothing", "linux", desktopHelperAuth("", ""), false, "requires a spawn ticket"},
		{"linux user helper unchanged", "linux", userHelper, false, ""},
		{"linux user helper presenting a ticket", "linux", userHelperWithTicket, false, "only valid for a Linux desktop helper"},
		{"linux user helper presenting a session", "linux", userHelperWithSession, false, "only valid for a Linux desktop helper"},
		{"linux assist presenting a ticket", "linux", assistWithTicket, false, "only valid for a Linux desktop helper"},
		{"linux system desktop helper presenting a ticket", "linux", systemDesktopWithTicket, false, "only valid for a Linux desktop helper"},
		{"darwin desktop helper without ticket", "darwin", desktopHelperAuth("", ""), false, ""},
		{"darwin desktop helper with ticket is ignored", "darwin", desktopHelperAuth("t", "3"), false, ""},
		{"windows user helper with ticket is ignored", "windows", userHelperWithTicket, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			isLinux, reject := linuxDesktopAdmission(tc.goos, tc.req.HelperRole, tc.req)
			if isLinux != tc.wantLinux {
				t.Errorf("isLinuxDesktop = %v, want %v", isLinux, tc.wantLinux)
			}
			if tc.wantReject == "" && reject != "" {
				t.Errorf("reject = %q, want none", reject)
			}
			if tc.wantReject != "" && !strings.Contains(reject, tc.wantReject) {
				t.Errorf("reject = %q, want it to contain %q", reject, tc.wantReject)
			}
		})
	}
}

// The macOS desktop helper needs no ticket and keeps its existing grant.
func TestAdmitLinuxDesktopHelper_DarwinUnchanged(t *testing.T) {
	isLinux, reject := linuxDesktopAdmission("darwin", ipc.HelperRoleUser, desktopHelperAuth("", ""))
	if isLinux || reject != "" {
		t.Fatalf("darwin desktop helper: isLinux=%v reject=%q, want neither", isLinux, reject)
	}
	b := &Broker{helperPathsFn: func() []string { return nil }}
	got := b.scopesForRole(ipc.HelperRoleUser, ipc.HelperBinaryUserHelper, "darwin", "")
	if strings.Join(got, ",") != strings.Join(userHelperScopes, ",") {
		t.Fatalf("darwin user helper scopes = %v, want %v", got, userHelperScopes)
	}
}

func liveWaylandState() LogindSessionState {
	return LogindSessionState{UID: 1000, Type: "wayland", State: "active", Class: "user", Exists: true}
}

func TestLinuxDesktopSessionLive(t *testing.T) {
	binding := LinuxDesktopBinding{UID: 1000, Username: "alice", LogindSessionID: "3", Generation: 1}
	mutate := func(f func(*LogindSessionState)) LogindSessionState {
		st := liveWaylandState()
		f(&st)
		return st
	}
	cases := []struct {
		name    string
		st      LogindSessionState
		binding LinuxDesktopBinding
		wantOK  bool
	}{
		{"active local wayland user session", liveWaylandState(), binding, true},
		{"inactive", mutate(func(s *LogindSessionState) { s.State = "online" }), binding, false},
		{"closing", mutate(func(s *LogindSessionState) { s.State = "closing" }), binding, false},
		{"empty state", mutate(func(s *LogindSessionState) { s.State = "" }), binding, false},
		{"x11", mutate(func(s *LogindSessionState) { s.Type = "x11" }), binding, false},
		{"tty", mutate(func(s *LogindSessionState) { s.Type = "tty" }), binding, false},
		{"remote", mutate(func(s *LogindSessionState) { s.Remote = true }), binding, false},
		{"different uid", mutate(func(s *LogindSessionState) { s.UID = 1001 }), binding, false},
		{"missing session", mutate(func(s *LogindSessionState) { s.Exists = false }), binding, false},
		{"greeter class", mutate(func(s *LogindSessionState) { s.Class = "greeter" }), binding, false},
		{"lock-screen class", mutate(func(s *LogindSessionState) { s.Class = "lock-screen" }), binding, false},
		{"properties unknown", mutate(func(s *LogindSessionState) { s.PropertiesUnknown = true }), binding, false},
		{"uid 0 binding", mutate(func(s *LogindSessionState) { s.UID = 0 }), LinuxDesktopBinding{UID: 0, LogindSessionID: "3", Generation: 1}, false},
		{"second wayland session", mutate(func(s *LogindSessionState) { s.OtherGraphicalSessions = 1 }), binding, false},
		{"second x11 session", mutate(func(s *LogindSessionState) { s.OtherGraphicalSessions = 2 }), binding, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason, ok := linuxDesktopSessionLive(tc.st, tc.binding)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v (reason %q), want %v", ok, reason, tc.wantOK)
			}
			if !ok && reason == "" {
				t.Fatal("rejected without a reason")
			}
		})
	}
}

func TestLinuxDesktopHelperScopesAreDesktopOnly(t *testing.T) {
	if len(linuxDesktopHelperScopes) != 1 || linuxDesktopHelperScopes[0] != "desktop" {
		t.Fatalf("linuxDesktopHelperScopes = %v, want [desktop]", linuxDesktopHelperScopes)
	}
}

func TestParseLogindShowSession(t *testing.T) {
	full := "Id=3\nUser=1000\nType=wayland\nState=active\nClass=user\nRemote=no\n"
	st := parseLogindShowSession("3", full)
	want := LogindSessionState{UID: 1000, Type: "wayland", State: "active", Class: "user", Exists: true}
	if st != want {
		t.Fatalf("parse = %+v, want %+v", st, want)
	}

	if st := parseLogindShowSession("3", "Id=3\nUser=1000\nType=wayland\nClass=user\nRemote=no\n"); !st.PropertiesUnknown {
		t.Fatalf("missing State not flagged unknown: %+v", st)
	}
	if st := parseLogindShowSession("3", "Id=3\nUser=abc\nType=wayland\nState=active\nClass=user\nRemote=no\n"); !st.PropertiesUnknown {
		t.Fatalf("bad User not flagged unknown: %+v", st)
	}
	if st := parseLogindShowSession("3", "Id=4\nUser=1000\nType=wayland\nState=active\nClass=user\nRemote=no\n"); st.Exists {
		t.Fatalf("other session id read as existing: %+v", st)
	}
	if st := parseLogindShowSession("3", "Id=3\nUser=1000\nType=wayland\nState=active\nClass=user\nRemote=yes\n"); !st.Remote {
		t.Fatalf("Remote=yes not read: %+v", st)
	}
	if st := parseLogindShowSession("3", ""); st.Exists || !st.PropertiesUnknown {
		t.Fatalf("empty output = %+v, want missing + unknown", st)
	}
}

func TestParseLogindUserSessions(t *testing.T) {
	ids, ok := parseLogindUserSessions("Sessions=3 c2 7\n")
	if !ok || strings.Join(ids, ",") != "3,c2,7" {
		t.Fatalf("parse = %v, %v", ids, ok)
	}
	if _, ok := parseLogindUserSessions("Sessions=3 ../x\n"); ok {
		t.Fatal("unsafe session id accepted")
	}
	if _, ok := parseLogindUserSessions("Other=1\n"); ok {
		t.Fatal("missing Sessions property accepted")
	}
	if ids, ok := parseLogindUserSessions("Sessions=\n"); !ok || len(ids) != 0 {
		t.Fatalf("empty Sessions = %v, %v; want none, ok", ids, ok)
	}
}

func TestIsLocalGraphicalLogindSession(t *testing.T) {
	cases := map[string]bool{
		"Type=wayland\nRemote=no\n": true,
		"Type=x11\nRemote=no\n":     true,
		"Type=mir\nRemote=no\n":     true,
		"Type=tty\nRemote=no\n":     false,
		"Type=x11\nRemote=yes\n":    false,
	}
	for out, want := range cases {
		got, ok := isLocalGraphicalLogindSession(out)
		if !ok || got != want {
			t.Errorf("isLocalGraphicalLogindSession(%q) = %v, %v; want %v, true", out, got, ok, want)
		}
	}
	if _, ok := isLocalGraphicalLogindSession("Remote=no\n"); ok {
		t.Error("output without Type accepted")
	}
}

func TestSetLinuxWaylandCaptureAuthorized(t *testing.T) {
	b := New("/tmp/test-capture-authorized.sock", nil)
	if b.linuxWaylandCaptureAuthorizer()() {
		t.Fatal("a new broker must not authorize Linux desktop helper capture")
	}
	b.SetLinuxWaylandCaptureAuthorized(func() bool { return true })
	if !b.linuxWaylandCaptureAuthorizer()() {
		t.Fatal("the installed authorizer was not used")
	}
	// nil fails closed rather than leaving a nil func to call.
	b.SetLinuxWaylandCaptureAuthorized(nil)
	if b.linuxWaylandCaptureAuthorizer()() {
		t.Fatal("a nil authorizer must deny capture")
	}
}
