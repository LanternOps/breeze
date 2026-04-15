package sessionbroker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

// syncBuffer is a goroutine-safe wrapper around bytes.Buffer so multiple
// concurrent writers (e.g. the acquiring goroutine and the holding goroutine
// in TestTimedRWMutexWarnsOnSlowAcquire) can emit logs without racing on
// bytes.Buffer's internal grow/write state.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.String()
}

// captureLogs redirects the global logger to a buffer for the duration of the
// test via t.Cleanup. Returns the buffer — call String() to inspect.
func captureLogs(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() {
		// Best-effort restore: reset to stdout so other tests see normal logs.
		logging.Init("text", "info", nil)
	})
	return buf
}

// withShortLockThreshold temporarily shortens slowLockThreshold for the test
// and restores it via t.Cleanup.
func withShortLockThreshold(t *testing.T, d time.Duration) {
	t.Helper()
	prev := setSlowLockThreshold(d)
	t.Cleanup(func() {
		setSlowLockThreshold(prev)
	})
}

func newTestUserSession(t *testing.T, sessionID, username string, lastSeen time.Time) (*Session, *ipc.Conn) {
	t.Helper()

	serverConn, clientConn := createSocketPair(t)
	session := NewSession(ipc.NewConn(serverConn), 1000, "1000", username, "x11:0", sessionID, []string{"notify", "tray", "run_as_user"})
	session.HelperRole = ipc.HelperRoleUser
	session.ConnectedAt = lastSeen.Add(-time.Minute)
	session.LastSeen = lastSeen

	return session, ipc.NewConn(clientConn)
}

func TestSessionForUserPrefersMostRecentUserSession(t *testing.T) {
	now := time.Now()

	systemSession, systemClient := newTestUserSession(t, "system-helper", "alice", now.Add(-30*time.Minute))
	defer systemClient.Close()
	systemSession.HelperRole = ipc.HelperRoleSystem
	userSessionOld, oldClient := newTestUserSession(t, "user-helper-old", "alice", now.Add(-20*time.Minute))
	defer oldClient.Close()
	userSessionNew, newClient := newTestUserSession(t, "user-helper-new", "alice", now.Add(-5*time.Minute))
	defer newClient.Close()

	b := &Broker{
		sessions: map[string]*Session{
			systemSession.SessionID:  systemSession,
			userSessionOld.SessionID: userSessionOld,
			userSessionNew.SessionID: userSessionNew,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	got := b.SessionForUser("alice")
	if got != userSessionNew {
		t.Fatalf("SessionForUser returned %q, want %q", got.SessionID, userSessionNew.SessionID)
	}
}

func TestLaunchProcessViaUserHelperBroadcastsToAllUserSessions(t *testing.T) {
	now := time.Now()

	olderSession, olderClient := newTestUserSession(t, "launch-helper-old", "alice", now.Add(-20*time.Minute))
	newerSession, newerClient := newTestUserSession(t, "launch-helper-new", "alice", now.Add(-2*time.Minute))
	defer olderSession.Close()
	defer newerSession.Close()
	defer olderClient.Close()
	defer newerClient.Close()

	go olderSession.RecvLoop(func(*Session, *ipc.Envelope) {})
	go newerSession.RecvLoop(func(*Session, *ipc.Envelope) {})

	b := &Broker{
		sessions: map[string]*Session{
			olderSession.SessionID: olderSession,
			newerSession.SessionID: newerSession,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	seen := make(chan string, 2)
	startResponder := func(label string, client *ipc.Conn) {
		t.Helper()
		go func() {
			client.SetReadDeadline(time.Now().Add(5 * time.Second))
			env, err := client.Recv()
			if err != nil {
				return
			}
			seen <- label

			var req ipc.LaunchProcessRequest
			if err := json.Unmarshal(env.Payload, &req); err != nil {
				t.Errorf("unmarshal launch request for %s: %v", label, err)
			}
			respPayload, _ := json.Marshal(ipc.LaunchProcessResult{OK: true, PID: 4242})
			if err := client.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeLaunchResult, Payload: respPayload}); err != nil {
				t.Errorf("send launch response for %s: %v", label, err)
			}
		}()
	}

	startResponder("older", olderClient)
	startResponder("newer", newerClient)

	if err := b.LaunchProcessViaUserHelper("/usr/local/bin/breeze-agent"); err != nil {
		t.Fatalf("LaunchProcessViaUserHelper: %v", err)
	}

	got := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case label := <-seen:
			got[label] = true
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for helper launch commands")
		}
	}
	if !got["older"] || !got["newer"] {
		t.Fatalf("expected both helpers to receive launch command, got %+v", got)
	}
}

func TestLaunchProcessViaUserHelperForSessionTargetsMatchingHelper(t *testing.T) {
	now := time.Now()

	sessionA, clientA := newTestUserSession(t, "helper-a", "alice", now.Add(-10*time.Minute))
	sessionB, clientB := newTestUserSession(t, "helper-b", "bob", now.Add(-2*time.Minute))
	sessionA.IdentityKey = "501"
	sessionB.IdentityKey = "502"
	defer sessionA.Close()
	defer sessionB.Close()
	defer clientA.Close()
	defer clientB.Close()

	go sessionA.RecvLoop(func(*Session, *ipc.Envelope) {})
	go sessionB.RecvLoop(func(*Session, *ipc.Envelope) {})

	b := &Broker{
		sessions: map[string]*Session{
			sessionA.SessionID: sessionA,
			sessionB.SessionID: sessionB,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	seen := make(chan string, 1)
	go func() {
		clientB.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientB.Recv()
		if err != nil {
			return
		}
		var req ipc.LaunchProcessRequest
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			t.Errorf("unmarshal targeted launch request: %v", err)
			return
		}
		if len(req.Args) != 2 || req.Args[0] != "--config" || req.Args[1] != "/tmp/helper.yaml" {
			t.Errorf("launch args = %+v, want [--config /tmp/helper.yaml]", req.Args)
		}
		seen <- "b"
		respPayload, _ := json.Marshal(ipc.LaunchProcessResult{OK: true, PID: 4242})
		if err := clientB.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeLaunchResult, Payload: respPayload}); err != nil {
			t.Errorf("send launch response: %v", err)
		}
	}()

	if err := b.LaunchProcessViaUserHelperForSession("502", "/usr/local/bin/breeze-helper", "--config", "/tmp/helper.yaml"); err != nil {
		t.Fatalf("LaunchProcessViaUserHelperForSession: %v", err)
	}

	select {
	case <-seen:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for targeted helper launch")
	}
}

// Previously the reaper skipped capture-capable sessions. Issue #443: a
// streaming helper Touches on every frame, so a genuinely idle capture
// session over IdleTimeout is stranded and must be reaped.
func TestReapIdleSessionsReapsStrandedCaptureSessions(t *testing.T) {
	session, clientIPC := createTestSession(t)
	defer clientIPC.Close()

	session.Capabilities = &ipc.Capabilities{CanCapture: true}
	session.LastSeen = time.Now().Add(-(IdleTimeout + time.Minute))

	b := &Broker{
		sessions: map[string]*Session{
			session.SessionID: session,
		},
		byIdentity:   map[string][]*Session{session.IdentityKey: []*Session{session}},
		staleHelpers: make(map[string][]int),
	}

	b.reapIdleSessions()

	if got := b.SessionCount(); got != 0 {
		t.Fatalf("SessionCount after reap = %d, want 0 (capture session must be reaped when stranded)", got)
	}
	if !session.IsClosed() {
		t.Fatal("stranded capture session should have been Close()d by reaper")
	}
}

func TestBetterSession(t *testing.T) {
	now := time.Now()

	tests := []struct {
		name      string
		candidate *Session
		current   *Session
		want      bool
	}{
		{
			name:      "nil candidate returns false",
			candidate: nil,
			current:   &Session{SessionID: "current", LastSeen: now, ConnectedAt: now},
			want:      false,
		},
		{
			name:      "nil current returns true",
			candidate: &Session{SessionID: "candidate", LastSeen: now, ConnectedAt: now},
			current:   nil,
			want:      true,
		},
		{
			name:      "both nil returns false",
			candidate: nil,
			current:   nil,
			want:      false,
		},
		{
			name:      "candidate with more recent LastSeen wins",
			candidate: &Session{SessionID: "newer", LastSeen: now, ConnectedAt: now},
			current:   &Session{SessionID: "older", LastSeen: now.Add(-5 * time.Minute), ConnectedAt: now},
			want:      true,
		},
		{
			name:      "current with more recent LastSeen wins",
			candidate: &Session{SessionID: "older", LastSeen: now.Add(-5 * time.Minute), ConnectedAt: now},
			current:   &Session{SessionID: "newer", LastSeen: now, ConnectedAt: now},
			want:      false,
		},
		{
			name:      "same LastSeen, candidate with more recent ConnectedAt wins",
			candidate: &Session{SessionID: "newer-conn", LastSeen: now, ConnectedAt: now},
			current:   &Session{SessionID: "older-conn", LastSeen: now, ConnectedAt: now.Add(-10 * time.Minute)},
			want:      true,
		},
		{
			name:      "same LastSeen, current with more recent ConnectedAt wins",
			candidate: &Session{SessionID: "older-conn", LastSeen: now, ConnectedAt: now.Add(-10 * time.Minute)},
			current:   &Session{SessionID: "newer-conn", LastSeen: now, ConnectedAt: now},
			want:      false,
		},
		{
			name:      "same LastSeen and ConnectedAt, lexicographically smaller SessionID wins",
			candidate: &Session{SessionID: "aaa-session", LastSeen: now, ConnectedAt: now},
			current:   &Session{SessionID: "zzz-session", LastSeen: now, ConnectedAt: now},
			want:      true,
		},
		{
			name:      "same LastSeen and ConnectedAt, lexicographically larger SessionID loses",
			candidate: &Session{SessionID: "zzz-session", LastSeen: now, ConnectedAt: now},
			current:   &Session{SessionID: "aaa-session", LastSeen: now, ConnectedAt: now},
			want:      false,
		},
		{
			name:      "identical sessions returns false (not strictly less)",
			candidate: &Session{SessionID: "same-id", LastSeen: now, ConnectedAt: now},
			current:   &Session{SessionID: "same-id", LastSeen: now, ConnectedAt: now},
			want:      false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := betterSession(tc.candidate, tc.current)
			if got != tc.want {
				t.Errorf("betterSession() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestPreferredSessionWithScopePrefersNewestUserHelper(t *testing.T) {
	now := time.Now()

	systemSession, systemClient := newTestUserSession(t, "scope-system", "alice", now.Add(-30*time.Minute))
	defer systemClient.Close()
	systemSession.HelperRole = ipc.HelperRoleSystem

	olderUser, olderClient := newTestUserSession(t, "scope-user-old", "alice", now.Add(-20*time.Minute))
	defer olderClient.Close()

	newerUser, newerClient := newTestUserSession(t, "scope-user-new", "bob", now.Add(-5*time.Minute))
	defer newerClient.Close()

	b := &Broker{
		sessions: map[string]*Session{
			systemSession.SessionID: systemSession,
			olderUser.SessionID:     olderUser,
			newerUser.SessionID:     newerUser,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	got := b.PreferredSessionWithScope("run_as_user")
	if got != newerUser {
		t.Fatalf("PreferredSessionWithScope returned %q, want %q", got.SessionID, newerUser.SessionID)
	}
}

func TestPreferredDesktopSession_LoginWindowConsole_PrefersLoginWindowHelper(t *testing.T) {
	now := time.Now()

	userSession := &Session{
		SessionID:      "user-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextUserSession,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now.Add(-10 * time.Minute),
		LastSeen:       now,
	}
	loginSession := &Session{
		SessionID:      "login-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextLoginWindow,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now.Add(-1 * time.Minute),
		LastSeen:       now,
	}

	b := &Broker{
		sessions: map[string]*Session{
			userSession.SessionID:  userSession,
			loginSession.SessionID: loginSession,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	// Without console user set, user_session wins (existing behavior).
	got := b.PreferredDesktopSession()
	if got.SessionID != "user-sess" {
		t.Fatalf("without console user: got %q, want user-sess", got.SessionID)
	}

	// With console at login window, login_window helper should win.
	b.SetConsoleUser("loginwindow")
	got = b.PreferredDesktopSession()
	if got.SessionID != "login-sess" {
		t.Fatalf("with loginwindow console: got %q, want login-sess", got.SessionID)
	}
}

func TestPreferredDesktopSession_LoggedInConsole_PrefersUserSession(t *testing.T) {
	now := time.Now()

	userSession := &Session{
		SessionID:      "user-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextUserSession,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now.Add(-10 * time.Minute),
		LastSeen:       now,
	}
	loginSession := &Session{
		SessionID:      "login-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextLoginWindow,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now.Add(-1 * time.Minute),
		LastSeen:       now,
	}

	b := &Broker{
		sessions: map[string]*Session{
			userSession.SessionID:  userSession,
			loginSession.SessionID: loginSession,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	// With a real user logged in, user_session should still win.
	b.SetConsoleUser("alice")
	got := b.PreferredDesktopSession()
	if got.SessionID != "user-sess" {
		t.Fatalf("with alice console: got %q, want user-sess", got.SessionID)
	}
}

func TestPreferredDesktopSession_LoginWindowConsole_OnlyLoginHelpers(t *testing.T) {
	now := time.Now()

	// Only a user_session helper connected, but console is at login window.
	userSession := &Session{
		SessionID:      "user-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextUserSession,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now,
		LastSeen:       now,
	}

	b := &Broker{
		sessions: map[string]*Session{
			userSession.SessionID: userSession,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	b.SetConsoleUser("loginwindow")
	got := b.PreferredDesktopSession()
	// Should still return the user_session as fallback — better than nil.
	if got == nil {
		t.Fatal("should return user_session as fallback when no login_window helper exists")
	}
}

func TestPreferredDesktopSession_LoginWindow_DeterministicRegardlessOfOrder(t *testing.T) {
	now := time.Now()

	userSession := &Session{
		SessionID:      "user-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextUserSession,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now.Add(-10 * time.Minute),
		LastSeen:       now,
	}
	loginSession := &Session{
		SessionID:      "login-sess",
		BinaryKind:     ipc.HelperBinaryDesktopHelper,
		DesktopContext: ipc.DesktopContextLoginWindow,
		Capabilities:   &ipc.Capabilities{CanCapture: true},
		AllowedScopes:  []string{"desktop"},
		ConnectedAt:    now.Add(-1 * time.Minute),
		LastSeen:       now,
	}

	// Run 50 iterations — Go map iteration is random, so if the old
	// iteration-order-dependent bug were still present, some iterations
	// would pick the wrong session.
	for i := 0; i < 50; i++ {
		b := &Broker{
			sessions: map[string]*Session{
				userSession.SessionID:  userSession,
				loginSession.SessionID: loginSession,
			},
			byIdentity:   make(map[string][]*Session),
			staleHelpers: make(map[string][]int),
		}
		b.SetConsoleUser("loginwindow")

		got := b.PreferredDesktopSession()
		if got.SessionID != "login-sess" {
			t.Fatalf("iteration %d: got %q, want login-sess", i, got.SessionID)
		}
	}
}

func TestCloseSessionsByDesktopContext(t *testing.T) {
	now := time.Now()

	userSess, userClient := createSocketPair(t)
	defer userClient.Close()
	userSession := NewSession(ipc.NewConn(userSess), 1000, "1000", "alice", "", "user-desktop", []string{"desktop"})
	userSession.BinaryKind = ipc.HelperBinaryDesktopHelper
	userSession.DesktopContext = ipc.DesktopContextUserSession
	userSession.Capabilities = &ipc.Capabilities{CanCapture: true}
	userSession.ConnectedAt = now

	loginSess, loginClient := createSocketPair(t)
	defer loginClient.Close()
	loginSession := NewSession(ipc.NewConn(loginSess), 0, "0", "loginwindow", "", "login-desktop", []string{"desktop"})
	loginSession.BinaryKind = ipc.HelperBinaryDesktopHelper
	loginSession.DesktopContext = ipc.DesktopContextLoginWindow
	loginSession.Capabilities = &ipc.Capabilities{CanCapture: true}
	loginSession.ConnectedAt = now

	notifySess, notifyClient := createSocketPair(t)
	defer notifyClient.Close()
	notifySession := NewSession(ipc.NewConn(notifySess), 1000, "1000", "alice", "", "notify-only", []string{"notify"})
	notifySession.ConnectedAt = now

	b := &Broker{
		sessions: map[string]*Session{
			userSession.SessionID:   userSession,
			loginSession.SessionID:  loginSession,
			notifySession.SessionID: notifySession,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	closed := b.CloseSessionsByDesktopContext(ipc.DesktopContextUserSession)
	if closed != 1 {
		t.Fatalf("CloseSessionsByDesktopContext returned %d, want 1", closed)
	}

	// Verify user session was closed. Note: without RecvLoop running,
	// removeSession won't fire, so we check the session's closed field
	// directly instead of using SessionByID.
	userSession.mu.Lock()
	userClosed := userSession.closed
	userSession.mu.Unlock()
	if !userClosed {
		t.Fatal("user-desktop session should be closed")
	}

	// Verify login and notify sessions were NOT closed.
	loginSession.mu.Lock()
	loginClosed := loginSession.closed
	loginSession.mu.Unlock()
	if loginClosed {
		t.Fatal("login-desktop session should not be closed")
	}

	notifySession.mu.Lock()
	notifyClosed := notifySession.closed
	notifySession.mu.Unlock()
	if notifyClosed {
		t.Fatal("notify-only session should not be closed")
	}
}

func TestCloseSessionsByDesktopContext_MultipleMatches(t *testing.T) {
	now := time.Now()

	sess1Conn, sess1Client := createSocketPair(t)
	defer sess1Client.Close()
	sess1 := NewSession(ipc.NewConn(sess1Conn), 1000, "1000", "alice", "", "user-desktop-1", []string{"desktop"})
	sess1.DesktopContext = ipc.DesktopContextUserSession
	sess1.ConnectedAt = now

	sess2Conn, sess2Client := createSocketPair(t)
	defer sess2Client.Close()
	sess2 := NewSession(ipc.NewConn(sess2Conn), 1000, "1000", "alice", "", "user-desktop-2", []string{"desktop"})
	sess2.DesktopContext = ipc.DesktopContextUserSession
	sess2.ConnectedAt = now

	loginConn, loginClient := createSocketPair(t)
	defer loginClient.Close()
	loginSess := NewSession(ipc.NewConn(loginConn), 0, "0", "loginwindow", "", "login-desktop", []string{"desktop"})
	loginSess.DesktopContext = ipc.DesktopContextLoginWindow
	loginSess.ConnectedAt = now

	b := &Broker{
		sessions: map[string]*Session{
			sess1.SessionID:    sess1,
			sess2.SessionID:    sess2,
			loginSess.SessionID: loginSess,
		},
		byIdentity:   make(map[string][]*Session),
		staleHelpers: make(map[string][]int),
	}

	closed := b.CloseSessionsByDesktopContext(ipc.DesktopContextUserSession)
	if closed != 2 {
		t.Fatalf("CloseSessionsByDesktopContext returned %d, want 2", closed)
	}

	sess1.mu.Lock()
	s1Closed := sess1.closed
	sess1.mu.Unlock()
	sess2.mu.Lock()
	s2Closed := sess2.closed
	sess2.mu.Unlock()
	if !s1Closed || !s2Closed {
		t.Fatalf("both user sessions should be closed: sess1=%v, sess2=%v", s1Closed, s2Closed)
	}

	loginSess.mu.Lock()
	lClosed := loginSess.closed
	loginSess.mu.Unlock()
	if lClosed {
		t.Fatal("login session should not be closed")
	}

	// No-match case: returns 0 without panic.
	if b.CloseSessionsByDesktopContext("nonexistent") != 0 {
		t.Fatal("expected 0 for nonexistent context")
	}
}

// BenchmarkFindCapableSessionUnderConcurrentConnections measures FindCapableSession
// throughput while K goroutines simultaneously simulate the write-lock storm
// (removeSession) from the reconnect loop described in issue #387.
//
// Before the atomic-snapshot refactor, FindCapableSession acquired b.mu.RLock()
// and was starved when write-lock goroutines competed. After the refactor it
// reads from an atomic pointer, so throughput should be unaffected by writers.
func BenchmarkFindCapableSessionUnderConcurrentConnections(b *testing.B) {
	const nSessions = 5
	const nWriters = 10 // simulates reconnect storm goroutines

	// Build broker via New() so the snapshot is initialised.
	broker := New("/tmp/bench.sock", nil)

	// Populate sessions with capture capability.
	// Sessions are created with a nil conn because FindCapableSession only reads
	// metadata fields (Capabilities, WinSessionID) — no IPC I/O is performed.
	for i := range nSessions {
		s := &Session{
			SessionID:     fmt.Sprintf("sess-%d", i),
			IdentityKey:   fmt.Sprintf("%d", 1000+i),
			AllowedScopes: systemHelperScopes,
			Capabilities:  &ipc.Capabilities{CanCapture: true, CanClipboard: true},
			WinSessionID:  "1",
		}
		broker.mu.Lock()
		broker.sessions[s.SessionID] = s
		broker.byIdentity[s.IdentityKey] = append(broker.byIdentity[s.IdentityKey], s)
		broker.publishSnapshotLocked()
		broker.mu.Unlock()
	}

	// Launch write-storm goroutines that repeatedly add and remove a session
	// to simulate the handleConnection/removeSession lock contention.
	stop := make(chan struct{})
	var wg sync.WaitGroup
	for w := range nWriters {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				sessID := fmt.Sprintf("storm-%d", id)
				idKey := fmt.Sprintf("storm-identity-%d", id)
				s := &Session{
					SessionID:   sessID,
					IdentityKey: idKey,
				}
				broker.mu.Lock()
				broker.sessions[sessID] = s
				broker.byIdentity[idKey] = []*Session{s}
				broker.publishSnapshotLocked()
				broker.mu.Unlock()

				broker.mu.Lock()
				delete(broker.sessions, sessID)
				delete(broker.byIdentity, idKey)
				broker.publishSnapshotLocked()
				broker.mu.Unlock()
			}
		}(w)
	}

	b.ResetTimer()
	for range b.N {
		s := broker.FindCapableSession("capture", "1")
		if s == nil {
			// The benchmark pre-registers five capture-capable sessions in
			// WinSessionID "1"; the write-storm goroutines only churn their
			// own "storm-*" sessions without touching the pre-registered
			// ones, so FindCapableSession must never return nil. A nil
			// result indicates a regression in the atomic-snapshot path.
			b.Fatal("FindCapableSession returned nil under concurrent writes")
		}
	}
	b.StopTimer()

	close(stop)
	wg.Wait()
}

// TestSnapshotReadAfterWrite verifies that a Broker constructed via New()
// registers a session under b.mu.Lock() + publishSnapshotLocked(), and that
// read-only hot-path APIs (SessionCount, AllSessions, FindCapableSession)
// immediately observe the new session via the atomic snapshot path — not
// via the locked-fallback path.
func TestSnapshotReadAfterWrite(t *testing.T) {
	broker := New("/tmp/snapshot-test.sock", nil)

	// Before registering anything, the snapshot is present but empty.
	if snap := broker.snap.Load(); snap == nil {
		t.Fatal("New() must initialise broker.snap")
	}
	if got := broker.SessionCount(); got != 0 {
		t.Fatalf("empty broker SessionCount = %d, want 0", got)
	}

	// Register a session via the same locked + publish pattern that
	// handleConnection uses internally.
	session := &Session{
		SessionID:     "snap-sess-1",
		IdentityKey:   "1001",
		Username:      "alice",
		WinSessionID:  "1",
		AllowedScopes: systemHelperScopes,
		Capabilities:  &ipc.Capabilities{CanCapture: true, CanClipboard: true, CanNotify: true},
		HelperRole:    ipc.HelperRoleSystem,
	}
	broker.mu.Lock()
	broker.sessions[session.SessionID] = session
	broker.byIdentity[session.IdentityKey] = append(broker.byIdentity[session.IdentityKey], session)
	broker.publishSnapshotLocked()
	broker.mu.Unlock()

	// SessionCount must go through the atomic snapshot (snap.Load() branch).
	if got := broker.SessionCount(); got != 1 {
		t.Fatalf("SessionCount after register = %d, want 1", got)
	}

	// AllSessions must see the session.
	infos := broker.AllSessions()
	if len(infos) != 1 || infos[0].SessionID != session.SessionID {
		t.Fatalf("AllSessions = %+v, want one session %q", infos, session.SessionID)
	}

	// FindCapableSession must see it via the capture capability.
	got := broker.FindCapableSession("capture", "1")
	if got == nil || got.SessionID != session.SessionID {
		t.Fatalf("FindCapableSession(capture, 1) = %v, want %q", got, session.SessionID)
	}

	// Verify we really exercised the snapshot path — the snapshot must be
	// non-nil and the snapFallbackWarned flag must NOT have been tripped.
	if broker.snap.Load() == nil {
		t.Fatal("expected non-nil snapshot after register")
	}
	if broker.snapFallbackWarned.Load() {
		t.Fatal("snapshot fallback should not have been triggered on a New()-constructed broker")
	}

	// Remove the session and verify snapshot reflects the removal.
	broker.mu.Lock()
	delete(broker.sessions, session.SessionID)
	delete(broker.byIdentity, session.IdentityKey)
	broker.publishSnapshotLocked()
	broker.mu.Unlock()

	if got := broker.SessionCount(); got != 0 {
		t.Fatalf("SessionCount after remove = %d, want 0", got)
	}
	if broker.FindCapableSession("capture", "1") != nil {
		t.Fatal("FindCapableSession should return nil after removal")
	}
}

// TestTimedRWMutexWarnsOnLongHold verifies that holding a write lock past
// slowLockThreshold emits a WARN log with held_ms and caller fields. Uses a
// short test threshold (25ms) so the test runs fast.
func TestTimedRWMutexWarnsOnLongHold(t *testing.T) {
	withShortLockThreshold(t, 25*time.Millisecond)
	buf := captureLogs(t)

	var mu timedRWMutex
	mu.Lock()
	time.Sleep(60 * time.Millisecond) // > 25ms threshold
	mu.Unlock()

	output := buf.String()
	if !strings.Contains(output, "broker write-lock held too long") {
		t.Fatalf("expected hold-time warning in log output, got:\n%s", output)
	}
	if !strings.Contains(output, "held_ms=") {
		t.Fatalf("expected held_ms field in log output, got:\n%s", output)
	}
	if !strings.Contains(output, "caller=") {
		t.Fatalf("expected caller field in log output, got:\n%s", output)
	}
}

// TestTimedRWMutexNoWarnOnFastHold verifies that a short write-lock hold
// does NOT emit a warning.
func TestTimedRWMutexNoWarnOnFastHold(t *testing.T) {
	withShortLockThreshold(t, 100*time.Millisecond)
	buf := captureLogs(t)

	var mu timedRWMutex
	mu.Lock()
	// No sleep — hold is effectively zero.
	mu.Unlock()

	if strings.Contains(buf.String(), "broker write-lock held too long") {
		t.Fatalf("unexpected hold-time warning on fast hold:\n%s", buf.String())
	}
}

// TestTimedRWMutexWarnsOnSlowAcquire verifies that slow Lock acquisition
// (contention wait) still emits the existing wait-time warning.
func TestTimedRWMutexWarnsOnSlowAcquire(t *testing.T) {
	withShortLockThreshold(t, 25*time.Millisecond)
	buf := captureLogs(t)

	var mu timedRWMutex
	// Acquire-and-hold on a goroutine to starve the second acquire.
	started := make(chan struct{})
	release := make(chan struct{})
	go func() {
		mu.Lock()
		close(started)
		<-release
		mu.Unlock()
	}()
	<-started
	// Second acquire must wait until we release; wait ~60ms before releasing.
	time.AfterFunc(60*time.Millisecond, func() { close(release) })
	mu.Lock()
	mu.Unlock()

	output := buf.String()
	if !strings.Contains(output, "broker write-lock acquisition slow") {
		t.Fatalf("expected acquisition-slow warning, got:\n%s", output)
	}
	if !strings.Contains(output, "waited_ms=") {
		t.Fatalf("expected waited_ms field, got:\n%s", output)
	}
}
