package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// recycleProbe is a connected SYSTEM helper that answers
// helper_recycle_prepare with res, or not at all when res is nil.
func recycleProbe(t *testing.T, role ipc.HelperRole, res *ipc.HelperRecyclePrepareResult) (*sessionbroker.Session, func() int) {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	client := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 0, "S-1-5-18", "SYSTEM", "", "helper-sys", []string{"desktop"})
	session.HelperRole = role
	session.WinSessionID = "1"
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	prepares := make(chan struct{}, 16)
	go func() {
		for {
			env, err := client.Recv()
			if err != nil {
				return
			}
			if env.Type != ipc.TypeHelperRecyclePrepare {
				continue
			}
			prepares <- struct{}{}
			if res != nil {
				_ = client.SendTyped(env.ID, ipc.TypeHelperRecyclePrepare, res)
			}
		}
	}()
	t.Cleanup(func() {
		_ = session.Close()
		_ = client.Close()
	})
	return session, func() int { return len(prepares) }
}

func recycleRequest(t *testing.T, reason string) *ipc.Envelope {
	t.Helper()
	raw, err := json.Marshal(ipc.HelperRecycleRequest{Reason: reason})
	if err != nil {
		t.Fatal(err)
	}
	return &ipc.Envelope{ID: "helper-recycle", Type: ipc.TypeHelperRecycleRequest, Payload: raw}
}

func TestHelperRecycleRequestReplacesAnIdleHelper(t *testing.T) {
	lc := &fakeLifecycle{mode: "always-on"}
	h := &Heartbeat{helperLifecycle: lc}
	session, prepares := recycleProbe(t, ipc.HelperRoleSystem, &ipc.HelperRecyclePrepareResult{Ready: true})
	h.handleUserHelperMessage(session, recycleRequest(t, "duplication leaked"))

	deadline := time.Now().Add(3 * time.Second)
	for len(lc.recycles()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := lc.recycles(); len(got) != 1 || got[0] != "duplication leaked" {
		t.Fatalf("recycled = %v", got)
	}
	if prepares() != 1 {
		t.Errorf("helper asked to prepare %d times, want 1", prepares())
	}
}

func TestHelperRecycleRequestLeavesABusyHelperAlone(t *testing.T) {
	lc := &fakeLifecycle{mode: "always-on"}
	h := &Heartbeat{helperLifecycle: lc}
	session, prepares := recycleProbe(t, ipc.HelperRoleSystem, &ipc.HelperRecyclePrepareResult{Busy: "remote desktop session active"})
	h.handleHelperRecycleRequest(session, recycleRequest(t, "leaked"))
	if prepares() != 1 || len(lc.recycles()) != 0 {
		t.Fatalf("prepares=%d recycled=%v", prepares(), lc.recycles())
	}
}

// A helper that does not answer is not known to be idle.
func TestHelperRecycleRequestNeedsAnAnswer(t *testing.T) {
	prev := helperRecyclePrepareTimeout
	helperRecyclePrepareTimeout = 50 * time.Millisecond
	t.Cleanup(func() { helperRecyclePrepareTimeout = prev })
	lc := &fakeLifecycle{mode: "always-on"}
	h := &Heartbeat{helperLifecycle: lc}
	session, _ := recycleProbe(t, ipc.HelperRoleSystem, nil)
	h.handleHelperRecycleRequest(session, recycleRequest(t, "leaked"))
	if got := lc.recycles(); len(got) != 0 {
		t.Fatalf("recycled a helper that never answered: %v", got)
	}
}

// A desktop start on its way to a helper is work the helper cannot see yet.
func TestHelperRecycleRequestWaitsForAStartInFlight(t *testing.T) {
	call := &desktopStartCall{done: make(chan struct{})}
	desktopStartInflight.Store("desk-inflight", call)
	t.Cleanup(func() { desktopStartInflight.Delete("desk-inflight") })
	lc := &fakeLifecycle{mode: "on-demand"}
	h := &Heartbeat{helperLifecycle: lc}
	session, prepares := recycleProbe(t, ipc.HelperRoleSystem, &ipc.HelperRecyclePrepareResult{Ready: true})
	h.handleHelperRecycleRequest(session, recycleRequest(t, "leaked"))
	if prepares() != 0 || len(lc.recycles()) != 0 {
		t.Fatalf("prepares=%d recycled=%v with a start in flight", prepares(), lc.recycles())
	}
}

func TestHelperRecycleRequestWithoutALifecycleManager(t *testing.T) {
	h := &Heartbeat{}
	session, prepares := recycleProbe(t, ipc.HelperRoleSystem, &ipc.HelperRecyclePrepareResult{Ready: true})
	h.handleHelperRecycleRequest(session, recycleRequest(t, "leaked"))
	if prepares() != 0 {
		t.Error("asked a helper to stop taking work with nothing to replace it")
	}
}

// The reason comes from another process and is logged.
func TestHelperRecycleReasonIsBounded(t *testing.T) {
	got := helperRecycleReason("a\nb\x00" + strings.Repeat("x", 4096))
	if len(got) > maxHelperRecycleReasonBytes || strings.ContainsAny(got, "\n\x00") {
		t.Errorf("reason not bounded/sanitized: %d bytes %q", len(got), got[:10])
	}
	if helperRecycleReason("") == "" {
		t.Error("empty reason must still name something")
	}
}
