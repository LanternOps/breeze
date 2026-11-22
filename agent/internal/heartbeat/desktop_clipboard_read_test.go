package heartbeat

import (
	"bytes"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// clipboardProbe is one helper on the far side of the broker: it records what
// the agent sends it, and as a user helper answers clipboard_get with reply.
type clipboardProbe struct {
	session *sessionbroker.Session
	client  *ipc.Conn

	mu    sync.Mutex
	got   []*ipc.Envelope
	gets  int
	reply func(env *ipc.Envelope) *ipc.Envelope
}

func newClipboardProbe(t *testing.T, role ipc.HelperRole, winSession, id string, scopes []string) *clipboardProbe {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	p := &clipboardProbe{client: ipc.NewConn(clientConn)}
	p.session = sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "S-1-5-21-"+id, "alice", "", id, scopes)
	p.session.HelperRole = role
	p.session.WinSessionID = winSession
	go p.session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go func() {
		for {
			env, err := p.client.Recv()
			if err != nil {
				return
			}
			p.mu.Lock()
			p.got = append(p.got, env)
			reply := p.reply
			if env.Type == ipc.TypeClipboardGet {
				p.gets++
			}
			p.mu.Unlock()
			if env.Type == ipc.TypeClipboardGet && reply != nil {
				_ = p.client.Send(reply(env))
			}
		}
	}()
	t.Cleanup(func() {
		_ = p.session.Close()
		_ = p.client.Close()
	})
	return p
}

func (p *clipboardProbe) answerClipboardGet(payload map[string]any, helperErr string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reply = func(env *ipc.Envelope) *ipc.Envelope {
		raw, _ := json.Marshal(payload)
		return &ipc.Envelope{ID: env.ID, Type: ipc.TypeClipboardData, Payload: raw, Error: helperErr}
	}
}

func (p *clipboardProbe) clipboardGets() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.gets
}

// result waits for the read result the agent sent this probe for id.
func (p *clipboardProbe) result(t *testing.T, id string) ipc.DesktopClipboardReadResult {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		for _, env := range p.got {
			if env.ID == id && env.Type == ipc.TypeDesktopClipboardReadResult {
				p.mu.Unlock()
				var res ipc.DesktopClipboardReadResult
				if err := json.Unmarshal(env.Payload, &res); err != nil {
					t.Fatalf("result payload: %v", err)
				}
				return res
			}
		}
		p.mu.Unlock()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no %s for %s", ipc.TypeDesktopClipboardReadResult, id)
	return ipc.DesktopClipboardReadResult{}
}

var systemHelperScopesForTest = []string{"notify", "tray", "clipboard", "desktop"}
var userHelperScopesForTest = []string{"notify", "clipboard", "run_as_user"}

func clipboardReadEnvelope(t *testing.T, id, desktopSessionID string) *ipc.Envelope {
	t.Helper()
	raw, err := json.Marshal(ipc.DesktopClipboardReadRequest{SessionID: desktopSessionID})
	if err != nil {
		t.Fatal(err)
	}
	return &ipc.Envelope{ID: id, Type: ipc.TypeDesktopClipboardRead, Payload: raw}
}

// The #8393 path: the system helper owning desk-1 asks, the user helper in the
// same Windows session reads the PNG, and the system helper gets the image.
func TestDesktopClipboardReadReturnsUserHelperImage(t *testing.T) {
	sys := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-1", systemHelperScopesForTest)
	user := newClipboardProbe(t, ipc.HelperRoleUser, "1", "user-1", userHelperScopesForTest)
	png := []byte("\x89PNG\r\n\x1a\nimg")
	user.answerClipboardGet(map[string]any{"type": "image", "image": png, "imageFormat": "png"}, "")

	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, sys.session, user.session)}
	h.rememberDesktopOwner("desk-1", sys.session.SessionID)

	h.handleDesktopClipboardRead(sys.session, clipboardReadEnvelope(t, "clip-read-1", "desk-1"))

	got, err := clipboard.ContentFromRelayResult(sys.result(t, "clip-read-1"))
	if err != nil {
		t.Fatalf("result: %v", err)
	}
	if got.Type != clipboard.ContentTypeImage || got.ImageFormat != "png" || !bytes.Equal(got.Image, png) {
		t.Fatalf("got %+v, want the user helper's PNG", got)
	}
}

// RTF the user helper reads survives the proxy, which used to drop it.
func TestDesktopClipboardReadKeepsRTF(t *testing.T) {
	sys := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-1", systemHelperScopesForTest)
	user := newClipboardProbe(t, ipc.HelperRoleUser, "1", "user-1", userHelperScopesForTest)
	rtf := []byte(`{\rtf1 hi}`)
	user.answerClipboardGet(map[string]any{"type": "rtf", "rtf": rtf}, "")

	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, sys.session, user.session)}
	h.rememberDesktopOwner("desk-1", sys.session.SessionID)
	h.handleDesktopClipboardRead(sys.session, clipboardReadEnvelope(t, "clip-read-1", "desk-1"))

	got, err := clipboard.ContentFromRelayResult(sys.result(t, "clip-read-1"))
	if err != nil || got.Type != clipboard.ContentTypeRTF || !bytes.Equal(got.RTF, rtf) {
		t.Fatalf("got %+v, %v; want the RTF", got, err)
	}
}

func TestDesktopClipboardReadUserHelperSeesNothing(t *testing.T) {
	sys := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-1", systemHelperScopesForTest)
	user := newClipboardProbe(t, ipc.HelperRoleUser, "1", "user-1", userHelperScopesForTest)
	user.answerClipboardGet(nil, clipboard.ErrNoSupportedFormat.Error())

	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, sys.session, user.session)}
	h.rememberDesktopOwner("desk-1", sys.session.SessionID)
	h.handleDesktopClipboardRead(sys.session, clipboardReadEnvelope(t, "clip-read-1", "desk-1"))

	if res := sys.result(t, "clip-read-1"); !res.NoSupportedFormat {
		t.Fatalf("result = %+v, want NoSupportedFormat", res)
	}
}

// Only the helper hosting the desktop session may read the user's clipboard
// through the service.
func TestDesktopClipboardReadRejectsNonOwner(t *testing.T) {
	owner := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-owner", systemHelperScopesForTest)
	other := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-other", systemHelperScopesForTest)
	user := newClipboardProbe(t, ipc.HelperRoleUser, "1", "user-1", userHelperScopesForTest)
	user.answerClipboardGet(map[string]any{"type": "text", "text": "secret"}, "")

	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, owner.session, other.session, user.session)}
	h.rememberDesktopOwner("desk-1", owner.session.SessionID)

	h.handleDesktopClipboardRead(other.session, clipboardReadEnvelope(t, "clip-read-1", "desk-1"))
	res := other.result(t, "clip-read-1")
	if res.Error == "" || res.Type != "" || res.Text != "" {
		t.Fatalf("non-owner got %+v, want an error and no content", res)
	}
	// A session nobody owns is refused the same way.
	h.handleDesktopClipboardRead(owner.session, clipboardReadEnvelope(t, "clip-read-2", "desk-unknown"))
	if res := owner.result(t, "clip-read-2"); res.Error == "" || res.Text != "" {
		t.Fatalf("unowned session got %+v, want an error", res)
	}
	if n := user.clipboardGets(); n != 0 {
		t.Fatalf("user helper asked %d time(s) for a refused read", n)
	}
}

func TestDesktopClipboardReadRejectsInvalidRequest(t *testing.T) {
	sys := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-1", systemHelperScopesForTest)
	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, sys.session)}

	h.handleDesktopClipboardRead(sys.session, clipboardReadEnvelope(t, "clip-read-1", "bad id with spaces"))
	if res := sys.result(t, "clip-read-1"); res.Error == "" {
		t.Fatalf("invalid session id: result = %+v, want an error", res)
	}
	h.handleDesktopClipboardRead(sys.session, &ipc.Envelope{ID: "clip-read-2", Type: ipc.TypeDesktopClipboardRead, Payload: []byte(`{`)})
	if res := sys.result(t, "clip-read-2"); res.Error == "" {
		t.Fatalf("bad payload: result = %+v, want an error", res)
	}
}

// No user helper in the session (login screen): Unavailable, so the system
// helper keeps what SYSTEM saw.
func TestDesktopClipboardReadWithoutUserHelper(t *testing.T) {
	sys := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-1", systemHelperScopesForTest)
	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, sys.session)}
	h.rememberDesktopOwner("desk-1", sys.session.SessionID)

	h.handleDesktopClipboardRead(sys.session, clipboardReadEnvelope(t, "clip-read-1", "desk-1"))
	if res := sys.result(t, "clip-read-1"); !res.Unavailable {
		t.Fatalf("result = %+v, want Unavailable", res)
	}
}

// Another Windows session's user helper is never read: on a multi-session host
// that would hand one user's clipboard to a session viewing another user.
func TestDesktopClipboardReadNeverCrossesWindowsSessions(t *testing.T) {
	sys := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-1", systemHelperScopesForTest)
	otherUser := newClipboardProbe(t, ipc.HelperRoleUser, "2", "user-2", userHelperScopesForTest)
	otherUser.answerClipboardGet(map[string]any{"type": "text", "text": "bob's secret"}, "")

	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, sys.session, otherUser.session)}
	h.rememberDesktopOwner("desk-1", sys.session.SessionID)

	h.handleDesktopClipboardRead(sys.session, clipboardReadEnvelope(t, "clip-read-1", "desk-1"))
	if res := sys.result(t, "clip-read-1"); !res.Unavailable || res.Text != "" {
		t.Fatalf("result = %+v, want Unavailable and no content", res)
	}
	if n := otherUser.clipboardGets(); n != 0 {
		t.Fatalf("another session's user helper was asked %d time(s)", n)
	}
}

// A user helper without the clipboard scope is not read.
func TestDesktopClipboardReadNeedsClipboardScope(t *testing.T) {
	sys := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-1", systemHelperScopesForTest)
	user := newClipboardProbe(t, ipc.HelperRoleUser, "1", "user-1", []string{"notify"})
	user.answerClipboardGet(map[string]any{"type": "text", "text": "x"}, "")

	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, sys.session, user.session)}
	h.rememberDesktopOwner("desk-1", sys.session.SessionID)
	h.handleDesktopClipboardRead(sys.session, clipboardReadEnvelope(t, "clip-read-1", "desk-1"))
	if res := sys.result(t, "clip-read-1"); !res.Unavailable {
		t.Fatalf("result = %+v, want Unavailable", res)
	}
}

// The broker hands the request to the helper-message dispatch, which must
// route it (off its own goroutine) to the read.
func TestHandleUserHelperMessageRoutesDesktopClipboardRead(t *testing.T) {
	sys := newClipboardProbe(t, ipc.HelperRoleSystem, "1", "sys-1", systemHelperScopesForTest)
	user := newClipboardProbe(t, ipc.HelperRoleUser, "1", "user-1", userHelperScopesForTest)
	user.answerClipboardGet(map[string]any{"type": "text", "text": "hi"}, "")

	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, sys.session, user.session)}
	h.rememberDesktopOwner("desk-1", sys.session.SessionID)

	h.handleUserHelperMessage(sys.session, clipboardReadEnvelope(t, "clip-read-1", "desk-1"))
	got, err := clipboard.ContentFromRelayResult(sys.result(t, "clip-read-1"))
	if err != nil || got.Text != "hi" {
		t.Fatalf("got %+v, %v; want the user helper's text", got, err)
	}
}
