package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

const (
	fenceSessionID = "33333333-3333-4333-8333-333333333333"
	// A start_desktop whose only defect is the missing revocationLease block
	// fails with ErrRevocationLeaseRequired. That error is the control signal
	// for "this start got PAST the fence" — the fence is checked before the
	// lease, so seeing the lease error proves no fence refusal happened.
	fencePassedMarker = "revocationLease"
)

func fenceStartCommand(commandID string, payload map[string]any) Command {
	full := map[string]any{
		"sessionId": fenceSessionID,
		"offer":     "v=0",
	}
	for k, v := range payload {
		full[k] = v
	}
	return Command{ID: commandID, Type: "start_desktop", Payload: full}
}

func newFenceHeartbeat() *Heartbeat {
	return &Heartbeat{desktopMgr: desktop.NewSessionManager()}
}

// The reorder case, end to end through the handlers: stop_desktop arrives for
// a session the agent never started, and the start it was meant to cancel
// lands afterwards. Before the fence, the unknown-session stop was a no-op and
// the late start ran.
func TestHandleStopDesktopTombstonesUnknownSessionAndLaterStartIsRefused(t *testing.T) {
	h := newFenceHeartbeat()

	stop := handleStopDesktop(h, Command{
		ID:   "stop-1",
		Type: "stop_desktop",
		Payload: map[string]any{
			"sessionId":          fenceSessionID,
			"terminalGeneration": "5",
		},
	})
	if stop.Status != "completed" {
		t.Fatalf("stop for an unknown session should still succeed, got status=%q error=%q", stop.Status, stop.Error)
	}

	late := handleStartDesktop(h, fenceStartCommand("start-1", map[string]any{"startGeneration": "4"}))
	if late.Status != "failed" {
		t.Fatalf("a start after a tombstone must be refused, got status=%q", late.Status)
	}
	if !strings.Contains(late.Error, string(desktopFenceReasonTerminal)) {
		t.Fatalf("refusal error %q does not name the terminal fence", late.Error)
	}
	if strings.Contains(late.Error, fencePassedMarker) {
		t.Fatalf("the start reached the lease check, so the fence did not refuse it: %q", late.Error)
	}

	// Even a NEWER generation is refused: the tombstone is absolute.
	newer := handleStartDesktop(h, fenceStartCommand("start-2", map[string]any{"startGeneration": "99"}))
	if newer.Status != "failed" || strings.Contains(newer.Error, fencePassedMarker) {
		t.Fatalf("a newer generation after a tombstone must still be refused, got status=%q error=%q", newer.Status, newer.Error)
	}
}

func TestHandleStartDesktopRefusesSupersededGeneration(t *testing.T) {
	h := newFenceHeartbeat()

	// Control: with nothing fenced, the start gets past the fence and fails on
	// the missing revocation lease instead.
	admitted := handleStartDesktop(h, fenceStartCommand("start-9", map[string]any{"startGeneration": "9"}))
	if !strings.Contains(admitted.Error, fencePassedMarker) {
		t.Fatalf("generation 9 should have passed the fence and failed on the lease, got %q", admitted.Error)
	}

	// Now that generation 9 is the high-water mark, an older start is inert.
	stale := handleStartDesktop(h, fenceStartCommand("start-8", map[string]any{"startGeneration": "8"}))
	if stale.Status != "failed" {
		t.Fatalf("a superseded start must be refused, got status=%q", stale.Status)
	}
	if !strings.Contains(stale.Error, string(desktopFenceReasonSuperseded)) {
		t.Fatalf("refusal error %q does not name the superseded fence", stale.Error)
	}
	if strings.Contains(stale.Error, fencePassedMarker) {
		t.Fatalf("the superseded start reached the lease check: %q", stale.Error)
	}

	// A strictly newer generation is still admitted.
	newer := handleStartDesktop(h, fenceStartCommand("start-10", map[string]any{"startGeneration": "10"}))
	if !strings.Contains(newer.Error, fencePassedMarker) {
		t.Fatalf("generation 10 should have passed the fence, got %q", newer.Error)
	}
}

// #3107: one start_desktop delivered over BOTH the agent WebSocket and the
// heartbeat response arrives twice, concurrently, with the same command id and
// the same generation. The fence must not turn the second delivery into a
// refusal — it has to reach joinOrRunDesktopStart, which collapses the pair.
func TestHandleStartDesktopDualDeliveryOfOneCommandIsNotRefused(t *testing.T) {
	h := newFenceHeartbeat()
	cmd := fenceStartCommand("start-dup", map[string]any{"startGeneration": "3"})

	results := make(chan string, 2)
	for i := 0; i < 2; i++ {
		go func() { results <- handleStartDesktop(h, cmd).Error }()
	}
	for i := 0; i < 2; i++ {
		got := <-results
		if !strings.Contains(got, fencePassedMarker) {
			t.Fatalf("delivery %d was refused by the fence: %q", i, got)
		}
	}

	// A DIFFERENT command reusing that generation is still a replay.
	replay := handleStartDesktop(h, fenceStartCommand("start-other", map[string]any{"startGeneration": "3"}))
	if replay.Status != "failed" || strings.Contains(replay.Error, fencePassedMarker) {
		t.Fatalf("a different command at the same generation must be refused, got status=%q error=%q", replay.Status, replay.Error)
	}
}

// Old server, mixed fleet: a start with no generation field is admitted, so an
// agent can roll ahead of the API.
func TestHandleStartDesktopAdmitsStartWithoutGeneration(t *testing.T) {
	h := newFenceHeartbeat()
	res := handleStartDesktop(h, fenceStartCommand("start-legacy", nil))
	if !strings.Contains(res.Error, fencePassedMarker) {
		t.Fatalf("a generationless start must be admitted, got %q", res.Error)
	}
}

// Fail closed on a generation we cannot compare. The server emits a canonical
// decimal string; a JSON number would silently round above 2^53.
func TestHandleStartDesktopRefusesMalformedGeneration(t *testing.T) {
	for _, raw := range []any{float64(9), "nine", "-1", "007"} {
		h := newFenceHeartbeat()
		res := handleStartDesktop(h, fenceStartCommand("start-bad", map[string]any{"startGeneration": raw}))
		if res.Status != "failed" || strings.Contains(res.Error, fencePassedMarker) {
			t.Fatalf("startGeneration %#v must be refused, got status=%q error=%q", raw, res.Status, res.Error)
		}
	}
}

// A malformed terminalGeneration must NOT stop the tombstone being installed:
// the stop is still an unambiguous terminal decision.
func TestHandleStopDesktopTombstonesDespiteMalformedTerminalGeneration(t *testing.T) {
	h := newFenceHeartbeat()
	stop := handleStopDesktop(h, Command{
		ID:   "stop-bad",
		Type: "stop_desktop",
		Payload: map[string]any{
			"sessionId":          fenceSessionID,
			"terminalGeneration": float64(5),
		},
	})
	if stop.Status != "completed" {
		t.Fatalf("stop should still execute, got status=%q error=%q", stop.Status, stop.Error)
	}
	late := handleStartDesktop(h, fenceStartCommand("start-after", map[string]any{"startGeneration": "6"}))
	if late.Status != "failed" || strings.Contains(late.Error, fencePassedMarker) {
		t.Fatalf("the tombstone must be installed anyway, got status=%q error=%q", late.Status, late.Error)
	}
}

// An invalid session id is rejected before the fence records anything, so a
// malformed stop can never tombstone a well-formed session.
func TestHandleStopDesktopInvalidSessionIDDoesNotTombstone(t *testing.T) {
	h := newFenceHeartbeat()
	bad := handleStopDesktop(h, Command{
		ID:      "stop-invalid",
		Type:    "stop_desktop",
		Payload: map[string]any{"sessionId": "not a valid session id!"},
	})
	if bad.Status != "failed" {
		t.Fatalf("an invalid session id must fail, got status=%q", bad.Status)
	}
	res := handleStartDesktop(h, fenceStartCommand("start-ok", map[string]any{"startGeneration": "1"}))
	if !strings.Contains(res.Error, fencePassedMarker) {
		t.Fatalf("a rejected stop must not fence a different session, got %q", res.Error)
	}
}
