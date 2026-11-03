package sessionbroker

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// TestSendNotificationConsumesNotifyResult is #10224 at the broker layer: a
// single-session notice sent with SendNotification registers the reply the
// helper always sends, so the answer is consumed and never reaches
// dispatchHelperMessage's unsolicited drop.
func TestSendNotificationConsumesNotifyResult(t *testing.T) {
	for _, tc := range []struct {
		name    string
		result  ipc.NotifyResult
		wantLog string
	}{
		{name: "delivered", result: ipc.NotifyResult{Delivered: true}, wantLog: "notification delivered"},
		{name: "not delivered", result: ipc.NotifyResult{Delivered: false}, wantLog: "notification not delivered"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			buf := captureLogs(t)
			b := New("send-notification-result", nil)
			p := newNotifyProbe(t, b, "notify-session", []string{"notify"})
			go p.session.RecvLoop(b.dispatchHelperMessage)

			if err := p.session.SendNotification("session-notify-1", ipc.NotifyRequest{Title: "Breeze Agent", Body: "Remote session ended"}); err != nil {
				t.Fatalf("SendNotification: %v", err)
			}
			if id := replyToBroadcast(t, p, tc.result); id != "session-notify-1" {
				t.Fatalf("envelope id = %q, want the caller's id", id)
			}
			waitForLog(t, buf, tc.wantLog)

			// Ordered inbound: the probe's drop is logged after any drop of
			// the real answer would have been.
			if err := p.client.SendTyped("never-sent", ipc.TypeNotifyResult, ipc.NotifyResult{Delivered: true}); err != nil {
				t.Fatalf("send probe: %v", err)
			}
			out := waitForLog(t, buf, "dropping unsolicited or unauthorized helper message")
			if n := strings.Count(out, "dropping unsolicited or unauthorized helper message"); n != 1 {
				t.Fatalf("%d unsolicited drops logged, want exactly 1 (the probe); the notice's answer was dropped:\n%s", n, out)
			}
		})
	}
}

// TestSendNotificationReplyPastTimeoutIsStillDropped keeps the waiter bounded:
// an answer after the wait gave up matches nothing and is still refused.
func TestSendNotificationReplyPastTimeoutIsStillDropped(t *testing.T) {
	buf := captureLogs(t)
	prev := broadcastNotifyResultTimeout
	broadcastNotifyResultTimeout = 50 * time.Millisecond
	t.Cleanup(func() { broadcastNotifyResultTimeout = prev })

	b := New("send-notification-late", nil)
	p := newNotifyProbe(t, b, "notify-session", []string{"notify"})
	go p.session.RecvLoop(b.dispatchHelperMessage)

	if err := p.session.SendNotification("late-1", ipc.NotifyRequest{Body: "x"}); err != nil {
		t.Fatalf("SendNotification: %v", err)
	}
	env, err := p.client.Recv()
	if err != nil || env.Type != ipc.TypeNotify {
		t.Fatalf("recv notify: env=%v err=%v", env, err)
	}
	waitForLog(t, buf, "no notify_result for notification")
	if err := p.client.SendTyped(env.ID, ipc.TypeNotifyResult, ipc.NotifyResult{Delivered: true}); err != nil {
		t.Fatalf("send late reply: %v", err)
	}
	waitForLog(t, buf, "dropping unsolicited or unauthorized helper message")
}

// TestSendNotificationRejectsDuplicateInFlightID: the id registers a waiter, so
// reusing one still in flight is refused rather than mis-routing the answer.
func TestSendNotificationRejectsDuplicateInFlightID(t *testing.T) {
	b := New("send-notification-dup", nil)
	p := newNotifyProbe(t, b, "notify-session", []string{"notify"})
	go p.session.RecvLoop(b.dispatchHelperMessage)

	if err := p.session.SendNotification("dup-1", ipc.NotifyRequest{Body: "x"}); err != nil {
		t.Fatalf("first SendNotification: %v", err)
	}
	if err := p.session.SendNotification("dup-1", ipc.NotifyRequest{Body: "y"}); !errors.Is(err, ErrDuplicateCommand) {
		t.Fatalf("second SendNotification err = %v, want ErrDuplicateCommand", err)
	}
}

// TestSendNotificationOnClosedSession reports the failure to the caller and
// leaves nothing registered.
func TestSendNotificationOnClosedSession(t *testing.T) {
	b := New("send-notification-closed", nil)
	p := newNotifyProbe(t, b, "notify-session", []string{"notify"})
	_ = p.session.Close()
	if err := p.session.SendNotification("closed-1", ipc.NotifyRequest{Body: "x"}); err == nil {
		t.Fatal("SendNotification on a closed session returned nil")
	}
}
