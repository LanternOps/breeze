package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestShouldPushHelperToken(t *testing.T) {
	if !shouldPushHelperToken([]string{"assist"}) {
		t.Fatal("assist scope should receive helper token")
	}
	if shouldPushHelperToken([]string{"watchdog"}) {
		t.Fatal("watchdog scope must NOT receive helper token")
	}
	if shouldPushHelperToken([]string{"notify", "clipboard", "run_as_user"}) {
		t.Fatal("user scope must NOT receive helper token")
	}
	if shouldPushHelperToken(nil) {
		t.Fatal("no scopes must NOT receive helper token")
	}
	_ = ipc.TypeHelperTokenUpdate // compile-time guard: ensures TypeHelperTokenUpdate stays defined
}

// helperTokenSession bundles a server-side broker Session with its in-memory
// client peer so a test can observe what the broker actually wrote on the wire.
type helperTokenSession struct {
	session *sessionbroker.Session
	client  *ipc.Conn
}

// newHelperTokenSession wires an in-memory socket pair into a broker Session
// with the given broker session ID and scopes. The server-side RecvLoop is
// started so SendNotify writes flow to the client peer.
func newHelperTokenSession(t *testing.T, id string, scopes []string) helperTokenSession {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(serverIPC, 0, id, "tester", "", id, scopes)
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	return helperTokenSession{session: session, client: clientIPC}
}

// awaitHelperToken reads one frame from the client peer (with a short deadline)
// and returns the carried token if it is a TypeHelperTokenUpdate, or "" if the
// read times out / a different frame arrives. The bool reports whether ANY
// frame was received before the deadline.
func awaitHelperToken(t *testing.T, c *ipc.Conn) (token string, gotFrame bool) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	env, err := c.Recv()
	if err != nil {
		return "", false
	}
	if env.Type != ipc.TypeHelperTokenUpdate {
		return "", true
	}
	var upd ipc.HelperTokenUpdate
	if err := json.Unmarshal(env.Payload, &upd); err != nil {
		t.Fatalf("unmarshal helper token update: %v", err)
	}
	return upd.Token, true
}

// TestSendHelperTokenUpdateOnlyReachesAssistSessions guards the wiring (not just
// the shouldPushHelperToken predicate): a rotated helper token pushed via
// sendHelperTokenUpdate must land ONLY on the assist-scoped session. The
// watchdog and user sessions must receive nothing. This catches a future
// refactor that broadens the recipient set. Runs on any OS — assist-scope
// routing is not Windows-gated (only the SID identity check at admit time is).
func TestSendHelperTokenUpdateOnlyReachesAssistSessions(t *testing.T) {
	assist := newHelperTokenSession(t, "assist-1", []string{ipc.ScopeAssist})
	watchdog := newHelperTokenSession(t, "watchdog-1", []string{"watchdog"})
	user := newHelperTokenSession(t, "user-1", []string{"notify", "clipboard", "run_as_user"})

	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, assist.session, watchdog.session, user.session),
	}

	const secret = "brz_secret"
	h.sendHelperTokenUpdate(secret)

	if token, _ := awaitHelperToken(t, assist.client); token != secret {
		t.Fatalf("assist session: expected helper token %q, got %q", secret, token)
	}
	if _, gotFrame := awaitHelperToken(t, watchdog.client); gotFrame {
		t.Fatal("watchdog session received a frame; helper token must never reach watchdog")
	}
	if _, gotFrame := awaitHelperToken(t, user.client); gotFrame {
		t.Fatal("user session received a frame; helper token must never reach user helper")
	}
}

// TestHelperTokenNotDeliveredToNonConsoleAssist proves the #1009 fix at the
// heartbeat wiring layer: on a multi-user host an assist session that is NOT in
// the active console session must never receive the device helper token, even
// though it carries assist scope. The console assist session still receives it.
//
// The active console session id is injected via the broker's test seam so this
// runs deterministically on darwin without Windows APIs.
func TestHelperTokenNotDeliveredToNonConsoleAssist(t *testing.T) {
	const secret = "brz_secret"

	consoleAssist := newHelperTokenSession(t, "assist-console", []string{ipc.ScopeAssist})
	consoleAssist.session.WinSessionID = "1"

	otherAssist := newHelperTokenSession(t, "assist-other", []string{ipc.ScopeAssist})
	otherAssist.session.WinSessionID = "3"

	broker := newTestBrokerWithSessions(t, consoleAssist.session, otherAssist.session)
	broker.SetConsoleSessionIDFunc(func() string { return "1" })
	broker.SetGOOSForTest("windows") // exercise the multi-user console-session binding

	h := &Heartbeat{sessionBroker: broker}
	h.setHelperToken(secret)
	h.sendHelperTokenUpdate(secret)

	if token, _ := awaitHelperToken(t, consoleAssist.client); token != secret {
		t.Fatalf("console assist: expected helper token %q, got %q", secret, token)
	}
	if _, gotFrame := awaitHelperToken(t, otherAssist.client); gotFrame {
		t.Fatal("non-console assist session received a frame; helper token must never leave the console session")
	}
}

// TestHandleHelperSessionAuthenticatedPushesOnlyToAssist proves the connect-time
// push path: a freshly authenticated assist session receives the retained token,
// while a watchdog session does not — even when both are driven through the same
// SessionAuthenticatedHandler entry point.
func TestHandleHelperSessionAuthenticatedPushesOnlyToAssist(t *testing.T) {
	const secret = "brz_secret"

	assist := newHelperTokenSession(t, "assist-auth", []string{ipc.ScopeAssist})
	watchdog := newHelperTokenSession(t, "watchdog-auth", []string{"watchdog"})

	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, assist.session, watchdog.session),
	}
	h.setHelperToken(secret)

	h.handleHelperSessionAuthenticated(assist.session)
	if token, _ := awaitHelperToken(t, assist.client); token != secret {
		t.Fatalf("authenticated assist session: expected helper token %q, got %q", secret, token)
	}

	h.handleHelperSessionAuthenticated(watchdog.session)
	if _, gotFrame := awaitHelperToken(t, watchdog.client); gotFrame {
		t.Fatal("authenticated watchdog session received a frame; helper token must never reach watchdog")
	}
}
