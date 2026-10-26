package sessionbroker

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func helperLogEnvelope(t *testing.T, rec ipc.HelperLogRecord) *ipc.Envelope {
	t.Helper()
	payload, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return &ipc.Envelope{Type: ipc.TypeHelperLog, Payload: payload}
}

func linesContaining(out, substr string) []string {
	var hits []string
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, substr) {
			hits = append(hits, line)
		}
	}
	return hits
}

// TestHelperLogRelayedAtItsLevel: a forwarded warn from the user-role helper
// lands in the agent's log (and so Agent Logs) at WARN, attributed to the
// helper session and role rather than passing as an agent line (#9266).
func TestHelperLogRelayedAtItsLevel(t *testing.T) {
	buf := captureLogs(t)
	b := New("helper-log-relay", nil)
	s := &Session{SessionID: "helper-abc", HelperRole: ipc.HelperRoleUser, AllowedScopes: []string{"notify"}}

	b.dispatchHelperMessage(s, helperLogEnvelope(t, ipc.HelperLogRecord{
		Level:     "warn",
		Component: "userhelper",
		Message:   "WinRT toast failed; falling back to PowerShell",
		Fields:    map[string]string{"error": "0x80070005"},
	}))
	b.dispatchHelperMessage(s, helperLogEnvelope(t, ipc.HelperLogRecord{
		Level:   "error",
		Message: "helper error line",
	}))

	out := buf.String()
	warn := linesContaining(out, "WinRT toast failed")
	if len(warn) != 1 {
		t.Fatalf("want one relayed warn line, got %d:\n%s", len(warn), out)
	}
	for _, want := range []string{"level=WARN", "component=helper", "helperSessionId=helper-abc", "helperRole=user", "helperComponent=userhelper", "0x80070005"} {
		if !strings.Contains(warn[0], want) {
			t.Errorf("relayed line missing %q: %s", want, warn[0])
		}
	}
	if errLines := linesContaining(out, "helper error line"); len(errLines) != 1 || !strings.Contains(errLines[0], "level=ERROR") {
		t.Errorf("error record not relayed at ERROR:\n%s", out)
	}
	if strings.Contains(out, "unknown message type from helper") {
		t.Errorf("helper_log fell through to the unknown-type warn:\n%s", out)
	}
}

// TestHelperLogRejectsBelowWarn: the relay is warn+ only; an info record is
// refused (at debug), never relayed.
func TestHelperLogRejectsBelowWarn(t *testing.T) {
	buf := captureLogs(t)
	b := New("helper-log-info", nil)
	s := &Session{SessionID: "helper-abc", HelperRole: ipc.HelperRoleUser}

	b.dispatchHelperMessage(s, helperLogEnvelope(t, ipc.HelperLogRecord{Level: "info", Message: "chatty info"}))

	for _, line := range linesContaining(buf.String(), "chatty info") {
		t.Fatalf("info record relayed: %s", line)
	}
}

// TestHelperLogRateCapped: the record comes from a process running with the
// logged-in user's token, so a per-session cap stops it flooding Agent Logs.
// The next admitted record reports how many the agent discarded.
func TestHelperLogRateCapped(t *testing.T) {
	// A frozen clock, so the burst is exact however slow the host is.
	now := time.Unix(1_700_000_000, 0)
	prevNow := helperLogNow
	helperLogNow = func() time.Time { return now }
	t.Cleanup(func() { helperLogNow = prevNow })

	buf := captureLogs(t)
	b := New("helper-log-cap", nil)
	s := &Session{SessionID: "helper-flood", HelperRole: ipc.HelperRoleUser}

	for i := 0; i < ipc.HelperLogBurst+15; i++ {
		b.dispatchHelperMessage(s, helperLogEnvelope(t, ipc.HelperLogRecord{Level: "warn", Message: "flood"}))
	}
	if got := len(linesContaining(buf.String(), "msg=flood")); got != ipc.HelperLogBurst {
		t.Fatalf("relayed %d records, want the burst of %d", got, ipc.HelperLogBurst)
	}

	// One refill interval later one record passes, carrying the drop count.
	now = now.Add(ipc.HelperLogRefill)
	b.dispatchHelperMessage(s, helperLogEnvelope(t, ipc.HelperLogRecord{Level: "warn", Message: "after-cap"}))
	after := linesContaining(buf.String(), "after-cap")
	if len(after) != 1 || !strings.Contains(after[0], "droppedByAgent=15") {
		t.Fatalf("post-cap record should carry droppedByAgent=15, got:\n%s", strings.Join(after, "\n"))
	}
}

// TestHelperLogRelayedThroughRealConn drives a helper_log through a real
// ipc.Conn and the session's RecvLoop, exactly as userhelper.LogForwarder.Pump
// sends it (empty envelope id), so the wire encoding and the
// HandleResponse-then-dispatch path are covered, not just the dispatch switch.
func TestHelperLogRelayedThroughRealConn(t *testing.T) {
	buf := captureLogs(t)
	b := New("helper-log-wire", nil)
	p := newNotifyProbe(t, b, "user-helper", []string{"notify"})
	p.session.HelperRole = ipc.HelperRoleUser
	go p.session.RecvLoop(b.dispatchHelperMessage)

	if err := p.client.SendTyped("", ipc.TypeHelperLog, ipc.HelperLogRecord{
		Level:   "warn",
		Message: "toast notifications are disabled; not retrying via PowerShell",
		Dropped: 2,
	}); err != nil {
		t.Fatalf("send: %v", err)
	}

	out := waitForLog(t, buf, "toast notifications are disabled")
	line := linesContaining(out, "toast notifications are disabled")[0]
	for _, want := range []string{"level=WARN", "component=helper", "helperRole=user", "droppedByHelper=2"} {
		if !strings.Contains(line, want) {
			t.Errorf("relayed line missing %q: %s", want, line)
		}
	}
}
