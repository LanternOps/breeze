package sessionbroker

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// withDecisionReplyGrace shortens notifyDecisionReplyGrace for one test. Tests
// that call this must not call t.Parallel().
func withDecisionReplyGrace(t *testing.T, d time.Duration) {
	t.Helper()
	prev := notifyDecisionReplyGrace
	notifyDecisionReplyGrace = d
	t.Cleanup(func() { notifyDecisionReplyGrace = prev })
}

// dialogHelper models the real helper's handleNotify end to end on a session
// whose inbound side is pumped by dispatchHelperMessage, so a reply nobody is
// waiting for produces the production WARN line.
//
// A request carrying Actions is the restart prompt: it is answered only after
// the dialog's own countdown (req.TimeoutMs) plus renderLag has elapsed, which
// is what MessageBoxTimeoutW does when nobody clicks — the countdown starts
// when the dialog is created, after the request was received and decoded. A
// request without Actions is a toast and is answered at once. answered gets one
// value per reply sent, so a test can order its own messages after them.
func dialogHelper(t *testing.T, b *Broker, renderLag time.Duration, clicked string) (*notifyProbe, <-chan string) {
	t.Helper()
	p := newNotifyProbe(t, b, "dialog-session", []string{"notify"})
	go p.session.RecvLoop(b.dispatchHelperMessage)

	answered := make(chan string, 16)
	go func() {
		for {
			env, err := p.client.Recv()
			if err != nil {
				return
			}
			if env.Type != ipc.TypeNotify {
				continue
			}
			var req ipc.NotifyRequest
			if err := json.Unmarshal(env.Payload, &req); err != nil {
				continue
			}
			res := ipc.NotifyResult{Delivered: true}
			if len(req.Actions) > 0 {
				time.Sleep(time.Duration(req.TimeoutMs)*time.Millisecond + renderLag)
				res.ActionClicked = clicked
			}
			if err := p.client.SendTyped(env.ID, ipc.TypeNotifyResult, res); err != nil {
				return
			}
			answered <- env.ID
		}
	}()
	return p, answered
}

// TestDecisionReplyAtTheDialogCountdownIsConsumed is #10182 on current main.
//
// The broker used to wait for the decision exactly as long as it told the
// dialog to count down. The helper's countdown starts later (it has to receive,
// decode and draw the dialog first), so the helper's "the countdown expired"
// answer always landed just after the broker had stopped waiting: the waiter
// was gone, and dispatchHelperMessage logged "dropping unsolicited or
// unauthorized helper message type=notify_result" at WARN on every unanswered
// prompt. A click in the dialog's last moments was thrown away the same way,
// and the reboot went ahead although the user had postponed it.
func TestDecisionReplyAtTheDialogCountdownIsConsumed(t *testing.T) {
	for _, tc := range []struct {
		name    string
		clicked string
	}{
		{name: "countdown expired, no click", clicked: ""},
		{name: "clicked in the last moment", clicked: "Postpone 1 hour"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			buf := captureLogs(t)
			b := New("notify-decision-at-countdown", nil)
			dialogHelper(t, b, 50*time.Millisecond, tc.clicked)

			const window = 200 * time.Millisecond
			res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
				Title:     "Restart Scheduled",
				Actions:   []string{"Restart now", "Postpone 1 hour"},
				TimeoutMs: int(window.Milliseconds()),
			}, window)
			if err != nil {
				t.Fatalf("RequestNotificationDecision = %v; the helper answered when its dialog closed and the broker had already stopped listening", err)
			}
			if !res.Delivered {
				t.Error("Delivered = false, but the helper reported the dialog was shown")
			}
			if res.ActionClicked != tc.clicked {
				t.Errorf("ActionClicked = %q, want %q", res.ActionClicked, tc.clicked)
			}
			if out := buf.String(); strings.Contains(out, "dropping unsolicited") {
				t.Fatalf("the helper's on-time answer was dropped as unsolicited:\n%s", out)
			}
		})
	}
}

// TestAnsweredPromptAndLeadToastLeaveNothingUnsolicited is the flow #10182
// reports: the user clicks Postpone, the re-planned schedule's lead rung warns
// with a toast (#4941), and the helper answers both. Neither answer may reach
// the unsolicited drop. (The toast's reply was the WARN on agent 0.124.0, which
// predates #9266's fix — this pins that it stays fixed.)
//
// The negative is made decisive without a sleep: after both replies, the test
// sends a notify_result nobody asked for. A session's inbound messages are
// handled in order, so by the time that one's drop is logged, any drop of an
// earlier reply would already be in the log too — and exactly one drop line
// must be there.
func TestAnsweredPromptAndLeadToastLeaveNothingUnsolicited(t *testing.T) {
	buf := captureLogs(t)
	b := New("notify-answered-then-toast", nil)
	p, answered := dialogHelper(t, b, 0, "Postpone 1 hour")

	res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Title:   "Restart Scheduled",
		Actions: []string{"Restart now", "Postpone 1 hour"},
		// The click lands immediately; the helper sleeps TimeoutMs before
		// answering, so zero models "answered at once".
		TimeoutMs: 0,
	}, 2*time.Second)
	if err != nil {
		t.Fatalf("RequestNotificationDecision: %v", err)
	}
	if res.ActionClicked != "Postpone 1 hour" {
		t.Fatalf("ActionClicked = %q, want the postponement", res.ActionClicked)
	}
	<-answered

	// The lead rung of the re-planned schedule.
	b.BroadcastNotification("Restart Postponed", "Your device will restart in 1 hour", "normal")
	select {
	case <-answered:
	case <-time.After(2 * time.Second):
		t.Fatal("the helper never answered the lead-rung toast")
	}

	if err := p.client.SendTyped("never-sent", ipc.TypeNotifyResult, ipc.NotifyResult{Delivered: true}); err != nil {
		t.Fatalf("send unsolicited notify_result: %v", err)
	}
	out := waitForLog(t, buf, "dropping unsolicited or unauthorized helper message")
	if n := strings.Count(out, "dropping unsolicited or unauthorized helper message"); n != 1 {
		t.Fatalf("%d unsolicited drops logged, want exactly 1 (the probe); an answered prompt or its lead toast was dropped:\n%s", n, out)
	}
}

// TestDecisionReplyPastTheGraceIsStillDropped keeps the guard honest: the grace
// is for an answer that arrives as the dialog closes, not an open door. A reply
// that turns up after the broker gave up for good still matches no waiter and
// is still refused, and the caller sees the timeout.
func TestDecisionReplyPastTheGraceIsStillDropped(t *testing.T) {
	buf := captureLogs(t)
	withDecisionReplyGrace(t, 50*time.Millisecond)
	b := New("notify-decision-past-grace", nil)
	dialogHelper(t, b, 400*time.Millisecond, "Postpone 1 hour")

	const window = 100 * time.Millisecond
	res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Actions:   []string{"Restart now", "Postpone 1 hour"},
		TimeoutMs: int(window.Milliseconds()),
	}, window)
	if !errors.Is(err, ErrCommandTimeout) {
		t.Fatalf("err = %v, want ErrCommandTimeout for a helper that answered long after its dialog closed", err)
	}
	if res.ActionClicked != "" {
		t.Errorf("ActionClicked = %q from an answer that arrived after the broker gave up", res.ActionClicked)
	}
	waitForLog(t, buf, "dropping unsolicited or unauthorized helper message")
}
