package heartbeat

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// SEC-038 W05, handler level: a start for a session the fence has no
// in-process record of triggers one bounded resync with the control plane
// before any admission decision is taken.

func newSyncHeartbeat(t *testing.T) *Heartbeat {
	t.Helper()
	h := &Heartbeat{desktopMgr: desktop.NewSessionManager()}
	h.desktopFenceSyncTimeout = 2 * time.Second
	return h
}

// answerWith installs a renew requester that answers as the control plane
// would, through the real answer path.
func answerWith(h *Heartbeat, answer func(sessionID, nonce string) websocket.RevocationLeaseMessage) {
	h.leaseSyncRequester = func(sessionID, nonce string) error {
		go h.applyRevocationLeaseAnswer(answer(sessionID, nonce))
		return nil
	}
}

func TestHandleStartDesktopResyncsUnknownSessionAndAdmits(t *testing.T) {
	h := newSyncHeartbeat(t)
	var gotNonce string
	answerWith(h, func(sessionID, nonce string) websocket.RevocationLeaseMessage {
		gotNonce = nonce
		return websocket.RevocationLeaseMessage{
			SessionID:        sessionID,
			StartGeneration:  "7",
			TerminationPhase: "none",
			SyncNonce:        nonce,
		}
	})

	res := handleStartDesktop(h, fenceStartCommand("start-7", map[string]any{"startGeneration": "7"}))
	if !strings.Contains(res.Error, fencePassedMarker) {
		t.Fatalf("the live start should pass the fence after a resync, got %q", res.Error)
	}
	if gotNonce == "" {
		t.Fatal("the resync renewal must carry a correlating nonce")
	}
}

func TestHandleStartDesktopResyncRefusesStaleGeneration(t *testing.T) {
	h := newSyncHeartbeat(t)
	answerWith(h, func(sessionID, nonce string) websocket.RevocationLeaseMessage {
		return websocket.RevocationLeaseMessage{
			SessionID:        sessionID,
			StartGeneration:  "9",
			TerminationPhase: "none",
			SyncNonce:        nonce,
		}
	})

	res := handleStartDesktop(h, fenceStartCommand("start-old", map[string]any{"startGeneration": "8"}))
	if res.Status != "failed" || strings.Contains(res.Error, fencePassedMarker) {
		t.Fatalf("a start below the server's current generation must be refused, got status=%q error=%q", res.Status, res.Error)
	}
	if !strings.Contains(res.Error, string(desktopFenceReasonSuperseded)) {
		t.Fatalf("refusal should name the superseded fence, got %q", res.Error)
	}
}

func TestHandleStartDesktopResyncRefusesTerminalPhase(t *testing.T) {
	h := newSyncHeartbeat(t)
	answerWith(h, func(sessionID, nonce string) websocket.RevocationLeaseMessage {
		return websocket.RevocationLeaseMessage{
			SessionID:        sessionID,
			StartGeneration:  "5",
			TerminationPhase: "pending",
			SyncNonce:        nonce,
		}
	})

	res := handleStartDesktop(h, fenceStartCommand("start-5", map[string]any{"startGeneration": "5"}))
	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonTerminal)) {
		t.Fatalf("a start for a session in a pending teardown must be refused as terminal, got status=%q error=%q", res.Status, res.Error)
	}
}

func TestHandleStartDesktopResyncRefusesOnRevokedAnswer(t *testing.T) {
	h := newSyncHeartbeat(t)
	answerWith(h, func(sessionID, nonce string) websocket.RevocationLeaseMessage {
		return websocket.RevocationLeaseMessage{
			SessionID:          sessionID,
			Revoked:            true,
			Reason:             "membership_removed",
			TerminalGeneration: "6",
			SyncNonce:          nonce,
		}
	})

	res := handleStartDesktop(h, fenceStartCommand("start-6", map[string]any{"startGeneration": "6"}))
	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonTerminal)) {
		t.Fatalf("a revoked resync answer must tombstone the session, got status=%q error=%q", res.Status, res.Error)
	}
}

// Fail closed on every way the resync can fail to produce an answer.
func TestHandleStartDesktopResyncFailuresRefuseTheStart(t *testing.T) {
	t.Run("unavailable", func(t *testing.T) {
		h := newSyncHeartbeat(t)
		answerWith(h, func(sessionID, nonce string) websocket.RevocationLeaseMessage {
			return websocket.RevocationLeaseMessage{SessionID: sessionID, Unavailable: true, SyncNonce: nonce}
		})
		res := handleStartDesktop(h, fenceStartCommand("start-u", map[string]any{"startGeneration": "1"}))
		if res.Status != "failed" || strings.Contains(res.Error, fencePassedMarker) {
			t.Fatalf("an unavailable resync must refuse the start, got status=%q error=%q", res.Status, res.Error)
		}
	})

	t.Run("timeout", func(t *testing.T) {
		h := newSyncHeartbeat(t)
		h.desktopFenceSyncTimeout = 50 * time.Millisecond
		h.leaseSyncRequester = func(string, string) error { return nil } // never answers
		res := handleStartDesktop(h, fenceStartCommand("start-t", map[string]any{"startGeneration": "1"}))
		if res.Status != "failed" || strings.Contains(res.Error, fencePassedMarker) {
			t.Fatalf("a timed-out resync must refuse the start, got status=%q error=%q", res.Status, res.Error)
		}
	})

	t.Run("no transport", func(t *testing.T) {
		h := newSyncHeartbeat(t) // no leaseSyncRequester at all
		res := handleStartDesktop(h, fenceStartCommand("start-n", map[string]any{"startGeneration": "1"}))
		if res.Status != "failed" || strings.Contains(res.Error, fencePassedMarker) {
			t.Fatalf("no command socket means no resync and no start, got status=%q error=%q", res.Status, res.Error)
		}
	})
}

// A stop landing while the resync is in flight wins: the waiter is released
// and the start is refused as terminal, so a start cannot outrun a stop that
// arrived behind it.
func TestHandleStartDesktopStopDuringResyncWins(t *testing.T) {
	h := newSyncHeartbeat(t)
	h.desktopFenceSyncTimeout = 5 * time.Second
	var once sync.Once
	h.leaseSyncRequester = func(sessionID, nonce string) error {
		once.Do(func() {
			go handleStopDesktop(h, Command{
				ID:      "stop-mid",
				Type:    "stop_desktop",
				Payload: map[string]any{"sessionId": sessionID, "terminalGeneration": "9"},
			})
		})
		return nil
	}

	res := handleStartDesktop(h, fenceStartCommand("start-race", map[string]any{"startGeneration": "9"}))
	if res.Status != "failed" || !strings.Contains(res.Error, string(desktopFenceReasonTerminal)) {
		t.Fatalf("a stop during the resync must win, got status=%q error=%q", res.Status, res.Error)
	}
}

// A generationless start (old server) never resyncs — there is nothing to
// order it against, and the mixed-fleet rollout depends on it being admitted.
func TestHandleStartDesktopGenerationlessStartSkipsResync(t *testing.T) {
	h := newSyncHeartbeat(t)
	h.leaseSyncRequester = func(string, string) error {
		t.Fatal("a generationless start must not trigger a resync")
		return nil
	}
	res := handleStartDesktop(h, fenceStartCommand("start-legacy", nil))
	if !strings.Contains(res.Error, fencePassedMarker) {
		t.Fatalf("a generationless start must be admitted, got %q", res.Error)
	}
}

// An old API answers the resync renewal without generation fields. That is
// still the control plane confirming the session, so the start is admitted at
// W04-level protection.
func TestHandleStartDesktopResyncAgainstOldApiAdmits(t *testing.T) {
	h := newSyncHeartbeat(t)
	answerWith(h, func(sessionID, nonce string) websocket.RevocationLeaseMessage {
		return websocket.RevocationLeaseMessage{SessionID: sessionID, SyncNonce: nonce}
	})
	res := handleStartDesktop(h, fenceStartCommand("start-oldapi", map[string]any{"startGeneration": "3"}))
	if !strings.Contains(res.Error, fencePassedMarker) {
		t.Fatalf("an old API's answer must still admit the start, got %q", res.Error)
	}
}

// Once a session is synced, later starts take no round trip at all.
func TestHandleStartDesktopResyncsOncePerSession(t *testing.T) {
	h := newSyncHeartbeat(t)
	var mu sync.Mutex
	calls := 0
	h.leaseSyncRequester = func(sessionID, nonce string) error {
		mu.Lock()
		calls++
		mu.Unlock()
		go h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
			SessionID: sessionID, StartGeneration: "1", TerminationPhase: "none", SyncNonce: nonce,
		})
		return nil
	}

	for _, gen := range []string{"1", "2", "3"} {
		res := handleStartDesktop(h, fenceStartCommand("start-"+gen, map[string]any{"startGeneration": gen}))
		if !strings.Contains(res.Error, fencePassedMarker) {
			t.Fatalf("generation %s should have passed the fence, got %q", gen, res.Error)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("the fence must resync once per session, not per start (got %d round trips)", calls)
	}
}

// An unavailable answer for an established session is not a fence sync but it
// must still reach the session manager, which decides on decision 2.
func TestApplyRevocationLeaseAnswerRoutesUnavailableToTheManager(t *testing.T) {
	h := newSyncHeartbeat(t)
	// No session under that id: the call must be safe and must not panic.
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{SessionID: fenceSessionID, Unavailable: true})
	// ...and it must NOT certify the fence, so a later start still resyncs.
	if d := h.desktopStartFence.admitStart(fenceSessionID, desktopStartFenceInput{Generation: 1, HasGeneration: true, CommandID: "c"}); !d.NeedsSync {
		t.Fatalf("an unavailable answer must not certify the fence, got %#v", d)
	}
}
