package sessionbroker

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// waitForLog polls the captured log until it contains want or the deadline
// passes. The broadcast consumes the helper's reply on a goroutine, so the
// outcome line is asynchronous to BroadcastNotification returning.
func waitForLog(t *testing.T, buf *syncBuffer, want string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if out := buf.String(); strings.Contains(out, want) {
			return out
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("log never contained %q; got:\n%s", want, buf.String())
	return ""
}

// replyToBroadcast reads the broadcast notify off the helper end of the socket
// and answers it exactly as userhelper.Client.handleNotify does: on the
// envelope id it was given.
func replyToBroadcast(t *testing.T, p *notifyProbe, result ipc.NotifyResult) string {
	t.Helper()
	env, err := p.client.Recv()
	if err != nil {
		t.Fatalf("recv notify: %v", err)
	}
	if env.Type != ipc.TypeNotify {
		t.Fatalf("env.Type = %q, want %q", env.Type, ipc.TypeNotify)
	}
	if err := p.client.SendTyped(env.ID, ipc.TypeNotifyResult, result); err != nil {
		t.Fatalf("send notify_result: %v", err)
	}
	return env.ID
}

// TestBroadcastNotificationConsumesNotifyResult is the #9266 regression: a
// fire-and-forget broadcast used to go out with an EMPTY envelope id, the
// helper answered on that id, nothing was pending, and dispatchHelperMessage
// shipped "dropping unsolicited or unauthorized helper message
// type=notify_result" at WARN for every toast. The broadcast now registers the
// reply it is owed, so the answer is consumed and never reaches the drop.
func TestBroadcastNotificationConsumesNotifyResult(t *testing.T) {
	buf := captureLogs(t)
	b := New("broadcast-notify-result", nil)
	p := newNotifyProbe(t, b, "notify-session", []string{"notify"})
	go p.session.RecvLoop(b.dispatchHelperMessage)

	b.BroadcastNotification("Reboot required", "Your device will restart", "critical")

	id := replyToBroadcast(t, p, ipc.NotifyResult{Delivered: true})
	if id == "" {
		t.Fatal("broadcast notify went out with an empty envelope id; its notify_result cannot be correlated")
	}

	out := waitForLog(t, buf, "broadcast notification delivered")
	if strings.Contains(out, "dropping unsolicited") {
		t.Fatalf("notify_result for an outstanding broadcast was dropped as unsolicited:\n%s", out)
	}
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "broadcast notification delivered") && !strings.Contains(line, "level=DEBUG") {
			t.Fatalf("delivered outcome must log at DEBUG, got: %s", line)
		}
	}
}

// TestBroadcastNotificationRecordsUndelivered proves the consumed answer is
// used, not just swallowed: a helper that could not show the toast is the one
// fact the user-role diagnostics were blind to.
func TestBroadcastNotificationRecordsUndelivered(t *testing.T) {
	buf := captureLogs(t)
	b := New("broadcast-notify-undelivered", nil)
	p := newNotifyProbe(t, b, "notify-session", []string{"notify"})
	go p.session.RecvLoop(b.dispatchHelperMessage)

	b.BroadcastNotification("Reboot required", "Your device will restart", "critical")
	replyToBroadcast(t, p, ipc.NotifyResult{Delivered: false})

	out := waitForLog(t, buf, "broadcast notification not delivered")
	if strings.Contains(out, "dropping unsolicited") {
		t.Fatalf("undelivered notify_result was dropped as unsolicited:\n%s", out)
	}
	if !strings.Contains(out, "undeliveredTotal=1") {
		t.Errorf("undelivered line should carry the running total:\n%s", out)
	}
	if got := b.BroadcastNotifyUndeliveredCount(); got != 1 {
		t.Fatalf("BroadcastNotifyUndeliveredCount() = %d, want 1", got)
	}
}

// TestUnmatchedNotifyResultStillDropped keeps the unsolicited guard honest: a
// notify_result nobody asked for (no outstanding broadcast or decision) is
// still refused rather than forwarded.
func TestUnmatchedNotifyResultStillDropped(t *testing.T) {
	buf := captureLogs(t)
	b := New("notify-result-unmatched", nil)
	p := newNotifyProbe(t, b, "notify-session", []string{"notify"})
	go p.session.RecvLoop(b.dispatchHelperMessage)

	if err := p.client.SendTyped("never-sent", ipc.TypeNotifyResult, ipc.NotifyResult{Delivered: true}); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitForLog(t, buf, "dropping unsolicited or unauthorized helper message")
}

// TestStartCommandSendErrorLeavesNothingPending: when the send fails,
// startCommand returns the error and unregisters the reply it had reserved,
// so a broadcast to a dying helper cannot leak a pending entry.
func TestStartCommandSendErrorLeavesNothingPending(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	_ = clientConn.Close()
	s := NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "", "dying", []string{"notify"})
	t.Cleanup(func() { _ = s.Close() })
	// Close the transport under the session (not s.Close, which would make
	// startCommand refuse before registering anything) so SendTyped fails.
	_ = serverConn.Close()

	if _, err := s.startCommand("notify-bcast-x", ipc.TypeNotify, &ipc.NotifyRequest{}); err == nil {
		t.Fatal("startCommand on a closed transport succeeded; the send-error path is not exercised")
	}
	s.mu.Lock()
	pending := len(s.pending)
	s.mu.Unlock()
	if pending != 0 {
		t.Fatalf("%d pending entries left after a failed send", pending)
	}
}
