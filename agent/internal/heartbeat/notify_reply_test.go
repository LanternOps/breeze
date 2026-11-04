package heartbeat

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// answeringNotifyHelper is a notify-scoped helper session whose inbound side is
// pumped by RecvLoop exactly as the broker pumps it: a reply that matches no
// registered waiter falls through to onMessage, which in production is
// dispatchHelperMessage's "dropping unsolicited or unauthorized helper message"
// WARN. Here onMessage records it instead, so the test can see the drop.
//
// The helper end answers every TypeNotify on the envelope id it was given, as
// userhelper.Client.handleNotify does, and reports each id on answered.
type answeringNotifyHelper struct {
	session     *sessionbroker.Session
	client      *ipc.Conn
	answered    chan string
	unsolicited chan *ipc.Envelope
}

func newAnsweringNotifyHelper(t *testing.T, winSession string) *answeringNotifyHelper {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	h := &answeringNotifyHelper{
		client:      ipc.NewConn(clientConn),
		answered:    make(chan string, 8),
		unsolicited: make(chan *ipc.Envelope, 8),
	}
	h.session = sessionbroker.NewSession(ipc.NewConn(serverConn), 501, "S-1-5-21-dana", "dana", "", "sess-notify-"+winSession, []string{"notify"})
	h.session.HelperRole = ipc.HelperRoleUser
	h.session.WinSessionID = winSession
	go h.session.RecvLoop(func(_ *sessionbroker.Session, env *ipc.Envelope) { h.unsolicited <- env })
	go func() {
		for {
			env, err := h.client.Recv()
			if err != nil {
				return
			}
			if env.Type != ipc.TypeNotify {
				continue
			}
			if err := h.client.SendTyped(env.ID, ipc.TypeNotifyResult, ipc.NotifyResult{Delivered: true}); err != nil {
				return
			}
			h.answered <- env.ID
		}
	}()
	t.Cleanup(func() {
		_ = h.session.Close()
		_ = h.client.Close()
	})
	return h
}

// assertOnlyProbeUnsolicited waits for the helper's answer, then sends a
// notify_result nobody asked for. A session's inbound messages are handled in
// order, so the probe is decisive without a sleep: if the answer had matched
// no waiter, it would reach onMessage before the probe does.
func (h *answeringNotifyHelper) assertOnlyProbeUnsolicited(t *testing.T, prefix string) {
	t.Helper()
	select {
	case id := <-h.answered:
		if !strings.HasPrefix(id, prefix) {
			t.Fatalf("notify envelope id = %q, want prefix %q", id, prefix)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the helper never received the notice")
	}
	if err := h.client.SendTyped("probe-never-sent", ipc.TypeNotifyResult, ipc.NotifyResult{Delivered: true}); err != nil {
		t.Fatalf("send probe: %v", err)
	}
	select {
	case env := <-h.unsolicited:
		if env.ID != "probe-never-sent" {
			t.Fatalf("the helper's answer to the notice (id %q, type %s) matched no waiter and fell through to the unsolicited path, where production logs \"dropping unsolicited or unauthorized helper message\" at WARN", env.ID, env.Type)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("the probe never reached the unsolicited path")
	}
}

// TestSessionNoticeReplyIsConsumed is #10224: the remote-session start/end
// notice (sendSessionNotify) and the PAM outcome notices that share its sender
// went out as fire-and-forget SendNotify with a real envelope id but nothing
// registered for the reply. The helper's handleNotify always answers on that
// id, so every notice ended in a WARN drop — the bug class #9266 fixed for the
// reboot broadcast and #10209 for the restart prompt.
func TestSessionNoticeReplyIsConsumed(t *testing.T) {
	for _, tc := range []struct {
		name             string
		targetWinSession string
	}{
		{name: "legacy machine-global target", targetWinSession: ""},
		{name: "strict Windows-session target", targetWinSession: "2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			helper := newAnsweringNotifyHelper(t, "2")
			h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, helper.session)}

			if err := h.sendSessionNotifyTitled("Breeze Agent", "Remote session ended", tc.targetWinSession); err != nil {
				t.Fatalf("sendSessionNotifyTitled: %v", err)
			}
			helper.assertOnlyProbeUnsolicited(t, "session-notify-")
		})
	}
}

// TestLegacyNoticeToastReplyIsConsumed covers notifyOwner, the legacy toast a
// prompt-host notice falls back to per owner (#10190 W04). Same bug class.
func TestLegacyNoticeToastReplyIsConsumed(t *testing.T) {
	helper := newAnsweringNotifyHelper(t, "2")
	h := &Heartbeat{sessionBroker: newTestBrokerWithSessions(t, helper.session)}

	if err := h.notifyOwner(noticeOwner(helper.session), ipc.NotifyRequest{Title: "Breeze Agent", Body: "Remote session ended"}); err != nil {
		t.Fatalf("notifyOwner: %v", err)
	}
	helper.assertOnlyProbeUnsolicited(t, "notice-legacy-")
}

// TestRandomNotifyIDIsUniqueBackToBack: the notice ids now register a waiter,
// and startCommand refuses a duplicate in-flight id (ErrDuplicateCommand), so
// two notices raised inside one clock tick — a session's start notice and a
// PAM outcome, or two PAM outcomes — must not share an id or the second is
// never shown. A time-of-day string alone collides on a coarse clock.
func TestRandomNotifyIDIsUniqueBackToBack(t *testing.T) {
	seen := make(map[string]bool, 1000)
	for i := 0; i < 1000; i++ {
		id := randomNotifyID()
		if seen[id] {
			t.Fatalf("randomNotifyID returned %q twice in %d back-to-back calls", id, i+1)
		}
		seen[id] = true
	}
}

// TestNoFireAndForgetTypeNotify keeps the bug class closed. The helper answers
// every TypeNotify, so a TypeNotify sent through Session.SendNotify (which
// registers nothing) always ends in an unsolicited-message WARN. TypeNotify
// goes out through Session.SendNotification (reply consumed) or
// SendCommand/SendCommandAndWait (reply returned to the caller).
func TestNoFireAndForgetTypeNotify(t *testing.T) {
	root := ".." // agent/internal
	var offenders []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) < 2 {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "SendNotify" {
				return true
			}
			if arg, ok := call.Args[1].(*ast.SelectorExpr); ok && arg.Sel.Name == "TypeNotify" {
				offenders = append(offenders, fset.Position(call.Pos()).String())
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk agent/internal: %v", err)
	}
	if len(offenders) > 0 {
		t.Fatalf("TypeNotify sent fire-and-forget via SendNotify; the helper's notify_result will be dropped as unsolicited at WARN. Use Session.SendNotification:\n  %s", strings.Join(offenders, "\n  "))
	}
}
