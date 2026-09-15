package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// SEC-038 W05 readiness barrier: a generation-bearing start must not reach a
// helper that has not yet acknowledged this service's fence. The barrier lives
// in startDesktopOnSession, and it is the mechanism that makes helper-restart
// safety real — the helper-side fence logic alone cannot provide it, because a
// freshly spawned helper starts out knowing nothing.

// helperBarrierRig wires a real broker session to a fake helper on the other
// end of a socket pair, and reports what the helper actually received.
type helperBarrierRig struct {
	session  *sessionbroker.Session
	received chan string // message types, in the order the helper saw them
}

func newHelperBarrierRig(t *testing.T, answerFenceSync bool, fenceSyncError string) *helperBarrierRig {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", "helper-1", []string{"desktop"})
	t.Cleanup(func() {
		_ = session.Close()
		_ = clientIPC.Close()
	})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	rig := &helperBarrierRig{session: session, received: make(chan string, 8)}
	go func() {
		for {
			_ = clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
			env, err := clientIPC.Recv()
			if err != nil {
				return
			}
			rig.received <- env.Type

			switch env.Type {
			case ipc.TypeDesktopFenceSync:
				if !answerFenceSync {
					continue // the barrier must time out, not proceed
				}
				if fenceSyncError != "" {
					_ = clientIPC.SendError(env.ID, ipc.TypeDesktopFenceSync, fenceSyncError)
					continue
				}
				_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopFenceSync, Payload: mustJSON(map[string]any{"synced": 0})})
			case ipc.TypeDesktopStart:
				_ = clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopStart,
					Payload: mustJSON(ipc.DesktopStartResponse{SessionID: "desktop-1", Answer: "answer"})})
			}
		}
	}()
	return rig
}

func mustJSON(v any) []byte {
	out, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return out
}

func (r *helperBarrierRig) nextType(t *testing.T) string {
	t.Helper()
	select {
	case got := <-r.received:
		return got
	case <-time.After(5 * time.Second):
		t.Fatal("the helper received nothing")
		return ""
	}
}

func fenceStartRequest(generation string) ipc.DesktopStartRequest {
	return ipc.DesktopStartRequest{SessionID: "desktop-1", Offer: "offer", StartGeneration: generation}
}

func TestStartDesktopOnSessionSeedsTheFenceBeforeTheStart(t *testing.T) {
	rig := newHelperBarrierRig(t, true, "")
	h := &Heartbeat{}
	h.desktopStartFence.noteStop("tombstoned", desktopStopFenceInput{Generation: 3, HasGeneration: true})

	result, _ := h.startDesktopOnSession(rig.session, "desktop-1", fenceStartRequest("7"))
	if result.Status != "completed" {
		t.Fatalf("a seeded start must complete, got status=%q error=%q", result.Status, result.Error)
	}
	if first := rig.nextType(t); first != ipc.TypeDesktopFenceSync {
		t.Fatalf("the fence seed must reach the helper BEFORE the start; helper saw %q first", first)
	}
	if second := rig.nextType(t); second != ipc.TypeDesktopStart {
		t.Fatalf("the start must follow the seed, helper saw %q", second)
	}
}

// If the seed cannot be delivered the start is REFUSED, never sent unfenced.
func TestStartDesktopOnSessionRefusesWhenTheSeedIsRejected(t *testing.T) {
	rig := newHelperBarrierRig(t, true, "helper says no")
	h := &Heartbeat{}

	result, _ := h.startDesktopOnSession(rig.session, "desktop-1", fenceStartRequest("7"))
	if result.Status != "failed" {
		t.Fatalf("a rejected seed must refuse the start, got status=%q", result.Status)
	}
	if !strings.Contains(result.Error, "desktop start fence") {
		t.Fatalf("the refusal must name the fence, got %q", result.Error)
	}
	if first := rig.nextType(t); first != ipc.TypeDesktopFenceSync {
		t.Fatalf("helper saw %q first, want the seed", first)
	}
	select {
	case got := <-rig.received:
		t.Fatalf("no start may be sent after a failed seed, but the helper received %q", got)
	case <-time.After(300 * time.Millisecond):
	}
}

// A generationless start (old server) needs no seed and must not be blocked by
// one — that is the mixed-fleet rollout path.
func TestStartDesktopOnSessionSkipsTheSeedForAGenerationlessStart(t *testing.T) {
	rig := newHelperBarrierRig(t, true, "")
	h := &Heartbeat{}

	result, _ := h.startDesktopOnSession(rig.session, "desktop-1", fenceStartRequest(""))
	if result.Status != "completed" {
		t.Fatalf("a generationless start must not be gated on a seed, got status=%q error=%q", result.Status, result.Error)
	}
	if first := rig.nextType(t); first != ipc.TypeDesktopStart {
		t.Fatalf("helper saw %q first; a generationless start must go straight through", first)
	}
}

func TestStartDesktopOnSessionSeedsOncePerHelperSession(t *testing.T) {
	rig := newHelperBarrierRig(t, true, "")
	h := &Heartbeat{}

	for i := 0; i < 2; i++ {
		if result, _ := h.startDesktopOnSession(rig.session, "desktop-1", fenceStartRequest("7")); result.Status != "completed" {
			t.Fatalf("start %d failed: %q", i, result.Error)
		}
	}
	want := []string{ipc.TypeDesktopFenceSync, ipc.TypeDesktopStart, ipc.TypeDesktopStart}
	for i, expect := range want {
		if got := rig.nextType(t); got != expect {
			t.Fatalf("message %d was %q, want %q (the seed must cost one round trip per helper session, not per start)", i, got, expect)
		}
	}
}

// A helper session that ends must not leave its successor inheriting the
// "already seeded" claim — a new helper process knows nothing.
func TestHelperSessionCloseForcesAReseed(t *testing.T) {
	first := newHelperBarrierRig(t, true, "")
	h := &Heartbeat{}

	if result, _ := h.startDesktopOnSession(first.session, "desktop-1", fenceStartRequest("7")); result.Status != "completed" {
		t.Fatalf("first start failed: %q", result.Error)
	}
	h.handleHelperSessionClosed(first.session)

	second := newHelperBarrierRig(t, true, "")
	// Same helper session id as the first rig ("helper-1"): if the marker were
	// keyed but never cleared, the successor would be treated as seeded.
	if result, _ := h.startDesktopOnSession(second.session, "desktop-1", fenceStartRequest("8")); result.Status != "completed" {
		t.Fatalf("second start failed: %q", result.Error)
	}
	if got := second.nextType(t); got != ipc.TypeDesktopFenceSync {
		t.Fatalf("a helper session that replaced a closed one must be reseeded; it received %q first", got)
	}
}

// A terminal decision landing while a helper start is in flight triggers a
// compensating stop. If that stop's IPC fails, the owner mapping must SURVIVE:
// it is the only route a later stop (an operator retry, a forwarded
// revocation-lease answer) has back to a helper that may still be capturing.
func TestTerminalAfterStartKeepsTheOwnerMappingWhenTheStopFails(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	clientIPC := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", "helper-stuck", []string{"desktop"})
	session.Capabilities = &ipc.Capabilities{CanCapture: true}
	session.HelperRole = ipc.HelperRoleSystem
	t.Cleanup(func() {
		_ = session.Close()
		_ = clientIPC.Close()
	})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	// A helper that reads but never answers: the compensating stop times out.
	go func() {
		for {
			_ = clientIPC.SetReadDeadline(time.Now().Add(20 * time.Second))
			if _, err := clientIPC.Recv(); err != nil {
				return
			}
		}
	}()

	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		desktopMgr:    desktop.NewSessionManager(),
	}
	h.desktopStartFence.noteStop("desktop-1", desktopStopFenceInput{Generation: 5, HasGeneration: true})
	h.rememberDesktopOwner("desktop-1", session.SessionID)

	if !h.desktopSessionTerminalAfterStart("desktop-1") {
		t.Fatal("a tombstoned session must be reported as terminal after its start")
	}
	if got := h.desktopOwnerSession("desktop-1"); got == nil {
		t.Fatal("a failed compensating stop must keep the owner mapping so a later stop can still reach the helper")
	}
}
