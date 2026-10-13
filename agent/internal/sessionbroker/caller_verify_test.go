package sessionbroker

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestCallerVerifyExpectedResponse(t *testing.T) {
	if got := expectedResponseType(ipc.TypeCallerVerifyRequest); got != ipc.TypeCallerVerifyResponse {
		t.Fatalf("response type = %q", got)
	}
}

func TestCallerVerifyResponseValidator(t *testing.T) {
	req := ipc.CallerVerifyRequest{Choices: []string{"42", "17", "86"}}
	validate := responseValidator(ipc.TypeCallerVerifyRequest, req)
	if validate == nil {
		t.Fatal("caller_verify_request must install a response validator")
	}
	for _, tc := range []struct {
		payload string
		ok      bool
	}{
		{`{"choice":"42"}`, true},
		{`{"choice":"not_me","helperVersion":"1.0.0"}`, true},
		{`{"choice":"timeout"}`, true},
		{`{"choice":"99"}`, false},
		{`{"choice":"allow"}`, false},
		{`{"choice":""}`, false},
		{`not json`, false},
	} {
		err := validate(&ipc.Envelope{Type: ipc.TypeCallerVerifyResponse, Payload: json.RawMessage(tc.payload)})
		if (err == nil) != tc.ok {
			t.Errorf("payload %s: err=%v want ok=%v", tc.payload, err, tc.ok)
		}
	}
}

func TestSanitizeCapabilitiesCallerVerifyOnlyForConsentAssist(t *testing.T) {
	caps := &ipc.Capabilities{CallerVerify: true}
	assist := NewSession(nil, 0, "S-1-5-21-1", "alex", "", "a", []string{ipc.ScopeConsentUI})
	assist.HelperRole = ipc.HelperRoleAssist
	if !sanitizeCapabilitiesForSession(assist, caps).CallerVerify {
		t.Fatal("assist helper with consent_ui must keep callerVerify")
	}
	noScope := NewSession(nil, 0, "S-1-5-21-1", "alex", "", "b", nil)
	noScope.HelperRole = ipc.HelperRoleAssist
	if sanitizeCapabilitiesForSession(noScope, caps).CallerVerify {
		t.Fatal("assist helper without consent_ui must not advertise callerVerify")
	}
	native := NewSession(nil, 0, "S-1-5-21-1", "alex", "", "c", []string{ipc.ScopeConsentUI, ipc.ScopeConsentUIFallback, "notify"})
	native.HelperRole = ipc.HelperRoleUser
	if sanitizeCapabilitiesForSession(native, caps).CallerVerify {
		t.Fatal("a native user helper must never advertise callerVerify")
	}
}

func withCallerOwnsLogin(t *testing.T, fn func(identityKey, username string) bool) {
	t.Helper()
	original := callerOwnsLogin
	callerOwnsLogin = fn
	t.Cleanup(func() { callerOwnsLogin = original })
}

func TestCallerVerifySessionWindows(t *testing.T) {
	withCallerOwnsLogin(t, func(sid, user string) bool { return sid == "S-1-5-21-1" && user == "alex" })
	for _, tc := range []struct {
		name          string
		user          string
		session       string
		sessionType   string
		state         string
		native        bool
		assist        bool
		capable       bool
		unverifiedWin bool
		wrongSID      bool
		listErr       bool
		want          string
	}{
		{name: "explicit", user: "alex", session: "7", assist: true, capable: true},
		{name: "case-insensitive", user: "ALEX", session: "7", assist: true, capable: true},
		{name: "missing user", user: "nobody", session: "7", native: true, assist: true, capable: true, want: "no_session_for_user"},
		{name: "empty user", user: "", session: "7", assist: true, capable: true, want: "no_session_for_user"},
		{name: "detector error", user: "alex", session: "7", assist: true, capable: true, listErr: true, want: "no_session_for_user"},
		{name: "non-console session", user: "alex", session: "8", native: true, assist: true, capable: true, want: "session_not_console"},
		{name: "rdp on console id", user: "alex", session: "7", sessionType: "rdp", assist: true, capable: true, want: "session_not_console"},
		{name: "disconnected", user: "alex", session: "7", state: "disconnected", assist: true, capable: true, want: "session_not_console"},
		{name: "old helper", user: "alex", session: "7", assist: true, capable: false, want: "helper_outdated"},
		{name: "native and assist", user: "alex", session: "7", native: true, assist: true, capable: true},
		{name: "native only", user: "alex", session: "7", native: true, capable: true, want: "helper_outdated"},
		{name: "wrong SID", user: "alex", session: "7", assist: true, capable: true, wrongSID: true, want: "helper_outdated"},
		{name: "self-reported win session", user: "alex", session: "7", assist: true, capable: true, unverifiedWin: true, want: "helper_outdated"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := New("test", nil)
			b.SetGOOSForTest("windows")
			b.SetConsoleSessionIDFunc(func() string { return "7" })
			sessionType := tc.sessionType
			if sessionType == "" {
				sessionType = "console"
			}
			state := tc.state
			if state == "" {
				state = "active"
			}
			det := admissionTestDetector{sessions: []DetectedSession{{Username: "alex", Session: tc.session, Type: sessionType, State: state}}}
			if tc.listErr {
				det = admissionTestDetector{err: errors.New("wts failed")}
			}
			add := func(role ipc.HelperRole, scope string) *Session {
				s := NewSession(nil, 0, "S-1-5-21-1", "helper-claimed-name", "", string(role)+tc.name, []string{scope})
				s.WinSessionID = tc.session
				s.WinSessionVerified = !tc.unverifiedWin
				s.HelperRole = role
				s.SetCapabilities(&ipc.Capabilities{CallerVerify: tc.capable})
				if tc.wrongSID {
					s.IdentityKey = "S-1-5-21-2"
				}
				addCallerSession(b, s)
				return s
			}
			if tc.native {
				add(ipc.HelperRoleUser, ipc.ScopeConsentUIFallback)
			}
			var assist *Session
			if tc.assist {
				assist = add(ipc.HelperRoleAssist, ipc.ScopeConsentUI)
			}
			s, login, reason := b.CallerVerifySession(tc.user, det)
			if reason != tc.want {
				t.Fatalf("reason=%q want=%q", reason, tc.want)
			}
			if reason == "" {
				if s == nil || s != assist || s.HelperRole != ipc.HelperRoleAssist {
					t.Fatal("selected the wrong helper")
				}
				// The reported login is the detector's, never the helper's claim.
				if login.Username != "alex" {
					t.Fatalf("login username = %q", login.Username)
				}
			} else if s != nil {
				t.Fatal("a refusal must not return a session")
			}
		})
	}
}

func TestCallerVerifyAmbiguousConsoleLoginRefused(t *testing.T) {
	withCallerOwnsLogin(t, func(string, string) bool { return true })
	b := New("test", nil)
	b.SetGOOSForTest("darwin")
	det := admissionTestDetector{sessions: []DetectedSession{
		{UID: 501, Username: "alex", Session: "console", Type: "console", State: "active"},
		{UID: 502, Username: "alex", Session: "console", Type: "console", State: "active"},
	}}
	if _, _, reason := b.CallerVerifySession("alex", det); reason != "session_not_console" {
		t.Fatalf("ambiguous console login must be refused, got %q", reason)
	}
}

func TestCallerVerifyUnixConsoleAndCapabilityRace(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		t.Run(goos, func(t *testing.T) {
			b := New("unix", nil)
			b.SetGOOSForTest(goos)
			s := NewSession(nil, 501, "501", "helper-claimed-name", "", "assist-"+goos, []string{ipc.ScopeConsentUI})
			s.HelperRole = ipc.HelperRoleAssist
			s.SetCapabilities(&ipc.Capabilities{CallerVerify: true})
			addCallerSession(b, s)
			login := DetectedSession{UID: 501, Username: "alex", Session: "c2", Type: "console", State: "active", Seat: "seat0", Display: "wayland"}
			det := admissionTestDetector{sessions: []DetectedSession{login}}
			got, _, reason := b.CallerVerifySession("alex", det)
			if got != s || reason != "" {
				t.Fatalf("console helper not selected: %q", reason)
			}
			// Unix usernames are case-sensitive.
			if _, _, reason = b.CallerVerifySession("Alex", det); reason != "no_session_for_user" {
				t.Fatalf("case-folded unix username accepted: %q", reason)
			}
			det.sessions[0].IsRemote = true
			if _, _, reason = b.CallerVerifySession("alex", det); reason != "session_not_console" {
				t.Fatalf("remote session accepted: %q", reason)
			}
			det.sessions[0].IsRemote = false
			if goos == "linux" {
				det.sessions[0].Seat = ""
				if _, _, reason = b.CallerVerifySession("alex", det); reason != "session_not_console" {
					t.Fatalf("seatless linux session accepted: %q", reason)
				}
				det.sessions[0].Seat = "seat0"
			}
			s.UID = 502
			if _, _, reason = b.CallerVerifySession("alex", det); reason != "helper_outdated" {
				t.Fatalf("helper of another uid selected: %q", reason)
			}
			s.UID = 501
			var wg sync.WaitGroup
			wg.Add(2)
			go func() {
				defer wg.Done()
				for i := 0; i < 100; i++ {
					s.SetCapabilities(&ipc.Capabilities{CallerVerify: i%2 == 0})
				}
			}()
			go func() {
				defer wg.Done()
				for i := 0; i < 100; i++ {
					_, _, _ = b.CallerVerifySession("alex", det)
					_ = b.CallerVerifyUsers(det)
				}
			}()
			wg.Wait()
		})
	}
}

func TestCallerVerifyUsersReportsOnlyReadyConsoleLogins(t *testing.T) {
	b := New("unix", nil)
	b.SetGOOSForTest("darwin")
	ready := NewSession(nil, 501, "501", "x", "", "ready", []string{ipc.ScopeConsentUI})
	ready.HelperRole = ipc.HelperRoleAssist
	ready.SetCapabilities(&ipc.Capabilities{CallerVerify: true})
	addCallerSession(b, ready)
	det := admissionTestDetector{sessions: []DetectedSession{
		{UID: 501, Username: "alex", Session: "console", Type: "console", State: "active"},
		{UID: 502, Username: "sam", Session: "s", Type: "ssh", State: "active", IsRemote: true},
	}}
	got := b.CallerVerifyUsers(det)
	if len(got) != 1 || got[0] != "alex" {
		t.Fatalf("users = %v", got)
	}
	ready.SetCapabilities(&ipc.Capabilities{})
	if got := b.CallerVerifyUsers(det); len(got) != 0 {
		t.Fatalf("old helper reported ready: %v", got)
	}
	if got := b.CallerVerifyUsers(nil); len(got) != 0 {
		t.Fatalf("nil detector reported users: %v", got)
	}
}

func addCallerSession(b *Broker, s *Session) {
	b.mu.Lock()
	b.sessions[s.SessionID] = s
	b.publishSnapshotLocked()
	b.mu.Unlock()
}
