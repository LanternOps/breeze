package sessionbroker

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// The recycle exchange (#12624) only works if the broker forwards the helper's
// request and correlates the helper's answer: a dropped type makes the
// recycle silently do nothing.
func TestHelperRecycleMessagesAreRouted(t *testing.T) {
	desktop := &Session{AllowedScopes: []string{"desktop"}}
	other := &Session{AllowedScopes: []string{"notify"}}
	req := &ipc.Envelope{Type: ipc.TypeHelperRecycleRequest}
	if !shouldForwardUnsolicitedHelperMessage(desktop, req) {
		t.Error("a desktop helper's recycle request is not forwarded")
	}
	if shouldForwardUnsolicitedHelperMessage(other, req) {
		t.Error("a recycle request from a helper without desktop scope is forwarded")
	}
	if got := expectedResponseType(ipc.TypeHelperRecyclePrepare); got != ipc.TypeHelperRecyclePrepare {
		t.Errorf("prepare answer type = %q, want %q", got, ipc.TypeHelperRecyclePrepare)
	}
}

// A request that turns out stale replaced nothing and must cost nothing.
func TestRecycleHelperStaleCostsNoBudget(t *testing.T) {
	h := newRecycleHarness(t)
	successor := newOwnedSession(t, h.b, h.key, newFakeOwnedPeerProcess(4300))
	err := h.m.RecycleHelper(h.session, "leaked", func() error {
		h.b.mu.Lock()
		h.b.helperByKey[h.key] = successor
		h.b.mu.Unlock()
		return nil
	})
	if err == nil {
		t.Fatal("stale recycle reported success")
	}
	h.m.mu.Lock()
	used := len(recentRecycles(h.m.recycles[h.key], time.Now()))
	h.m.mu.Unlock()
	if used != 0 {
		t.Errorf("stale recycle used %d of the budget", used)
	}
}
