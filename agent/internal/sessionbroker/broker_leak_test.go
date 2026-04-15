package sessionbroker

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// withKeepaliveTiming overrides the package-level keepalive ping interval and
// timeout for a single test and restores them on cleanup.
//
// Tests that call this MUST NOT call t.Parallel(): the overrides are
// package-level vars and would race under parallel execution.
func withKeepaliveTiming(t *testing.T, interval, timeout time.Duration) {
	t.Helper()
	prevInterval := keepalivePingInterval
	prevTimeout := keepaliveTimeout
	keepalivePingInterval = interval
	keepaliveTimeout = timeout
	t.Cleanup(func() {
		keepalivePingInterval = prevInterval
		keepaliveTimeout = prevTimeout
	})
}

// newPairedSession builds a broker-side Session plus a client ipc.Conn for
// tests that need to drive the server-initiated keepalive path. The client
// side intentionally does NOT auto-reply to pings so the timeout can fire.
func newPairedSession(t *testing.T, sessionID, identity string) (*Session, *ipc.Conn) {
	t.Helper()
	return createTestSessionWith(t, sessionID, identity)
}

func createTestSessionWith(t *testing.T, sessionID, identity string) (*Session, *ipc.Conn) {
	t.Helper()
	serverConn, clientConn := createSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := NewSession(serverIPC, 1000, identity, "testuser", "x11:0", sessionID, []string{"notify", "tray", "desktop"})
	return session, clientIPC
}

// Stranded capture sessions (no pongs) must be closed by the keepalive loop.
func TestKeepaliveReapsStrandedSession(t *testing.T) {
	// 20ms ping cadence, 30ms pong timeout — keeps the whole test under 100ms.
	withKeepaliveTiming(t, 20*time.Millisecond, 30*time.Millisecond)

	session, clientIPC := newPairedSession(t, "leak-1", "2000")
	defer clientIPC.Close()

	// Force lastPongAt into the past so the first tick triggers the timeout
	// without having to wait for natural drift.
	session.lastPongAt.Store(time.Now().Add(-time.Second).UnixNano())

	// Drain client writes so the broker's first Send doesn't block on the
	// socket buffer. We ignore read errors — the socket will close mid-test.
	go func() {
		for {
			if _, err := clientIPC.Recv(); err != nil {
				return
			}
		}
	}()

	b := &Broker{
		sessions:     map[string]*Session{session.SessionID: session},
		byIdentity:   map[string][]*Session{session.IdentityKey: {session}},
		staleHelpers: make(map[string][]int),
	}

	done := make(chan struct{})
	go func() {
		b.runKeepalive(session)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		_ = session.Close()
		t.Fatal("runKeepalive did not exit after pong timeout")
	}

	if !session.IsClosed() {
		t.Fatal("stranded session should have been Close()d by keepalive")
	}
}

// A healthy session whose client reports pongs must NOT be closed.
func TestKeepaliveKeepsHealthySessionAlive(t *testing.T) {
	withKeepaliveTiming(t, 20*time.Millisecond, 80*time.Millisecond)

	session, clientIPC := newPairedSession(t, "healthy-1", "3000")
	defer clientIPC.Close()

	// Fake a fresh pong immediately so the age check never trips.
	session.NotePong()

	// Pretend the client is responsive: refresh lastPongAt whenever we see a
	// ping. We DO NOT actually call conn.Send from the test — the real
	// receive path on the server consumes pongs, but here we only need the
	// age to stay fresh.
	stopDrain := make(chan struct{})
	go func() {
		for {
			select {
			case <-stopDrain:
				return
			default:
			}
			env, err := clientIPC.Recv()
			if err != nil {
				return
			}
			if env.Type == ipc.TypePing {
				session.NotePong()
			}
		}
	}()
	defer close(stopDrain)

	b := &Broker{
		sessions:     map[string]*Session{session.SessionID: session},
		byIdentity:   map[string][]*Session{session.IdentityKey: {session}},
		staleHelpers: make(map[string][]int),
	}

	keepaliveDone := make(chan struct{})
	go func() {
		b.runKeepalive(session)
		close(keepaliveDone)
	}()

	// Run for ~3 ping intervals, then Close() the session and verify
	// runKeepalive exits cleanly via Done().
	time.Sleep(80 * time.Millisecond)

	if session.IsClosed() {
		t.Fatal("healthy session must not be closed by keepalive")
	}

	_ = session.Close()

	select {
	case <-keepaliveDone:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("runKeepalive did not exit after session.Close()")
	}
}

// When the cap is hit, a new connection for the same identity must evict the
// oldest-idle existing session rather than being rejected.
func TestAdmitOrEvictEvictsIdleSession(t *testing.T) {
	now := time.Now()
	identity := "evict-id"

	sessions := make([]*Session, 0, MaxConnectionsPerIdentity)
	for i := 0; i < MaxConnectionsPerIdentity; i++ {
		s, client := newPairedSession(t, strings.Repeat("x", i+1), identity)
		defer client.Close()
		// All sessions start recent.
		s.LastSeen = now
		sessions = append(sessions, s)
	}
	// Mark index 2 as the oldest-idle (past EvictIdleThreshold).
	victim := sessions[2]
	victim.LastSeen = now.Add(-(EvictIdleThreshold + 10*time.Second))

	b := &Broker{
		sessions:     make(map[string]*Session),
		byIdentity:   map[string][]*Session{identity: sessions},
		staleHelpers: make(map[string][]int),
	}
	for _, s := range sessions {
		b.sessions[s.SessionID] = s
	}

	if !b.admitOrEvict(identity) {
		t.Fatal("admitOrEvict returned false, expected eviction to make room")
	}
	if !victim.IsClosed() {
		t.Fatal("oldest-idle session should have been closed")
	}
	if got := len(b.byIdentity[identity]); got != MaxConnectionsPerIdentity-1 {
		t.Fatalf("byIdentity len after eviction = %d, want %d", got, MaxConnectionsPerIdentity-1)
	}
	if _, stillPresent := b.sessions[victim.SessionID]; stillPresent {
		t.Fatal("evicted session should have been removed from b.sessions")
	}
}

// If every existing session is recent, admitOrEvict must refuse to
// evict and the caller will reject with "max connections exceeded".
func TestAdmitOrEvictRejectsWhenAllRecent(t *testing.T) {
	now := time.Now()
	identity := "noevict-id"

	sessions := make([]*Session, 0, MaxConnectionsPerIdentity)
	for i := 0; i < MaxConnectionsPerIdentity; i++ {
		s, client := newPairedSession(t, "recent-"+strings.Repeat("y", i+1), identity)
		defer client.Close()
		s.LastSeen = now // all fresh
		sessions = append(sessions, s)
	}

	b := &Broker{
		sessions:     make(map[string]*Session),
		byIdentity:   map[string][]*Session{identity: sessions},
		staleHelpers: make(map[string][]int),
	}
	for _, s := range sessions {
		b.sessions[s.SessionID] = s
	}

	if b.admitOrEvict(identity) {
		t.Fatal("admitOrEvict returned true, expected rejection when all sessions are recent")
	}
	for _, s := range sessions {
		if s.IsClosed() {
			t.Fatal("no session should be closed when none are idle")
		}
	}
}

// After repeated send failures (above the threshold), the keepalive loop
// must close the session. A single failure is tolerated because the wedge
// detector is the pong-age check, not the send side.
func TestKeepaliveClosesAfterRepeatedSendFailures(t *testing.T) {
	// Very short interval so we fire multiple ticks fast; timeout is far in
	// the future so only the send-failure path can close the session.
	withKeepaliveTiming(t, 10*time.Millisecond, time.Hour)

	session, clientIPC := newPairedSession(t, "sendfail-1", "4000")

	// Close the client side immediately so every server-side SendTyped
	// fails with a broken-pipe / closed-connection error.
	_ = clientIPC.Close()

	b := &Broker{
		sessions:     map[string]*Session{session.SessionID: session},
		byIdentity:   map[string][]*Session{session.IdentityKey: {session}},
		staleHelpers: make(map[string][]int),
	}

	done := make(chan struct{})
	go func() {
		b.runKeepalive(session)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		_ = session.Close()
		t.Fatal("runKeepalive did not exit after repeated send failures")
	}

	if !session.IsClosed() {
		t.Fatal("session should have been closed after repeated send failures")
	}
}

// The RecvLoop → dispatchHelperMessage path must route ipc.TypePong to
// s.NotePong(). Verifies the real dispatch switch, not a test copy of it,
// so a regression (typo in the case label, accidental reordering above
// HandleResponse, dispatch routed elsewhere) would fail this test.
func TestRecvLoopDispatchesPongToNotePong(t *testing.T) {
	session, clientIPC := newPairedSession(t, "pong-dispatch", "5000")
	defer clientIPC.Close()

	// Seed lastPongAt far in the past so we can detect a successful
	// NotePong() by observing LastPongAge drop back near zero.
	session.lastPongAt.Store(time.Now().Add(-time.Hour).UnixNano())
	if age := session.LastPongAge(); age < 59*time.Minute {
		t.Fatalf("precondition: expected seeded stale pong age, got %v", age)
	}

	b := &Broker{
		sessions:     map[string]*Session{session.SessionID: session},
		byIdentity:   map[string][]*Session{session.IdentityKey: {session}},
		staleHelpers: make(map[string][]int),
	}

	recvDone := make(chan struct{})
	go func() {
		session.RecvLoop(b.dispatchHelperMessage)
		close(recvDone)
	}()

	// Client-side: emit a broker-initiated keepalive pong envelope. The
	// broker's dispatch must route it through the TypePong case and call
	// NotePong(), which resets lastPongAt to ~now.
	if err := clientIPC.SendTyped("keepalive", ipc.TypePong, nil); err != nil {
		t.Fatalf("client SendTyped TypePong: %v", err)
	}

	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if session.LastPongAge() < time.Second {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if age := session.LastPongAge(); age > time.Second {
		t.Fatalf("LastPongAge did not reset after RecvLoop dispatched TypePong; got %v", age)
	}

	_ = session.Close()
	select {
	case <-recvDone:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("RecvLoop did not exit after session.Close()")
	}
}

// Under-cap identities should always admit without touching anything.
func TestAdmitOrEvictUnderCapAdmits(t *testing.T) {
	identity := "under-cap"
	s, client := newPairedSession(t, "solo", identity)
	defer client.Close()

	b := &Broker{
		sessions:     map[string]*Session{s.SessionID: s},
		byIdentity:   map[string][]*Session{identity: {s}},
		staleHelpers: make(map[string][]int),
	}

	if !b.admitOrEvict(identity) {
		t.Fatal("admitOrEvict returned false under cap")
	}
	if s.IsClosed() {
		t.Fatal("under-cap admit must not close any existing session")
	}
}
