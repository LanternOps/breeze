package heartbeat

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/monitoring"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
	"github.com/breeze-rmm/agent/internal/state"
)

// W09 (#8148): the periodic senders skip a route the server deferred, before
// they collect, and record a RetryAt when one comes back. Heartbeats and
// command results are never deferred.

// routeServer answers every request with the status/Retry-After the test
// sets per path, and counts requests per path.
type routeServer struct {
	srv   *httptest.Server
	mu    sync.Mutex
	hits  map[string]int
	plan  map[string]func(w http.ResponseWriter)
	total atomic.Int32
}

func newRouteServer(t *testing.T) *routeServer {
	t.Helper()
	rs := &routeServer{hits: map[string]int{}, plan: map[string]func(w http.ResponseWriter){}}
	rs.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rs.total.Add(1)
		rs.mu.Lock()
		rs.hits[r.URL.Path]++
		answer := rs.plan[r.URL.Path]
		rs.mu.Unlock()
		if answer != nil {
			answer(w)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(rs.srv.Close)
	return rs
}

func (rs *routeServer) answer(path string, f func(w http.ResponseWriter)) {
	rs.mu.Lock()
	rs.plan[path] = f
	rs.mu.Unlock()
}

func (rs *routeServer) count(path string) int {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.hits[path]
}

func overloaded(retryAfter string) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		if retryAfter != "" {
			w.Header().Set("Retry-After", retryAfter)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}
}

// deferralTestHeartbeat wires a Heartbeat to rs with a deferral clock the
// test can move forward (offset from real time, since httputil stamps
// RetryAt with the real clock).
func deferralTestHeartbeat(t *testing.T, rs *routeServer) (*Heartbeat, *atomic.Int64) {
	t.Helper()
	h := newRecoveryMarkerTestHeartbeat(&config.Config{AgentID: "agent-1", ServerURL: rs.srv.URL, AuthToken: "t"})
	var offset atomic.Int64
	h.loopDefer.now = func() time.Time { return time.Now().Add(time.Duration(offset.Load())) }
	return h, &offset
}

func TestDeferredInventorySkipsUntilRetryAt(t *testing.T) {
	rs := newRouteServer(t)
	const path = "/api/v1/agents/agent-1/software"
	rs.answer(path, overloaded("150"))
	h, offset := deferralTestHeartbeat(t, rs)

	if err := h.sendInventoryData("software", map[string]any{}, "software"); err == nil {
		t.Fatal("first send succeeded against a 503")
	}
	if n := rs.count(path); n != 1 {
		t.Fatalf("requests after the 503 = %d, want 1", n)
	}
	if err := h.sendInventoryData("software", map[string]any{}, "software"); !errors.Is(err, ErrDeferred) {
		t.Fatalf("second send = %v, want ErrDeferred", err)
	}
	if n := rs.count(path); n != 1 {
		t.Fatalf("a deferred cycle made a request (%d total)", n)
	}
	// Other routes are not affected.
	if err := h.sendInventoryData("disks", map[string]any{}, "disks"); err != nil {
		t.Fatalf("disks send = %v, want it unaffected", err)
	}

	rs.answer(path, nil)
	offset.Store(int64(196 * time.Second)) // past 150 s × 1.3
	if err := h.sendInventoryData("software", map[string]any{}, "software"); err != nil {
		t.Fatalf("send after RetryAt = %v", err)
	}
	if n := rs.count(path); n != 2 {
		t.Fatalf("requests after RetryAt = %d, want 2", n)
	}
}

func TestNoHintNoDeferral(t *testing.T) {
	rs := newRouteServer(t)
	const path = "/api/v1/agents/agent-1/software"
	rs.answer(path, overloaded(""))
	h, _ := deferralTestHeartbeat(t, rs)

	_ = h.sendInventoryData("software", map[string]any{}, "software")
	if err := h.sendInventoryData("software", map[string]any{}, "software"); errors.Is(err, ErrDeferred) {
		t.Fatal("a 503 without Retry-After deferred the route")
	}
	if n := rs.count(path); n != 2 {
		t.Fatalf("requests = %d, want 2 (today's behaviour)", n)
	}
}

func TestDeferredRecoveryKeysStayParked(t *testing.T) {
	rs := newRouteServer(t)
	h, _ := deferralTestHeartbeat(t, rs)
	h.loopDefer.Record(loopKey("PUT", h.agentRouteURL("security/recovery-keys")), retryAtErr(time.Now().Add(time.Minute)))
	parked := []security.RecoveryKey{{Mount: "C:", KeyType: "numerical"}}
	h.pendingRecoveryKeys = parked

	h.sendRecoveryKeys()

	if n := rs.total.Load(); n != 0 {
		t.Fatalf("deferred recovery-key cycle made %d requests", n)
	}
	if len(h.pendingRecoveryKeys) != 1 || h.pendingRecoveryKeys[0].Mount != "C:" {
		t.Fatalf("parked keys = %+v, want them untouched", h.pendingRecoveryKeys)
	}
}

// Event logs: the collector advances its watermark at Collect, so the gate
// must come before it. eventLogCol is a concrete type with no observable
// Collect count, so the gate's position is pinned by the source-order
// contract test (TestCollectBeforeSendSendersGateFirst).

func TestDeferredMonitoringResultsSkip(t *testing.T) {
	rs := newRouteServer(t)
	h, _ := deferralTestHeartbeat(t, rs)
	h.loopDefer.Record(loopKey("PUT", h.monitoringResultsURL()), retryAtErr(time.Now().Add(time.Minute)))
	h.sendMonitoringResults([]monitoring.CheckResult{{}})
	if n := rs.total.Load(); n != 0 {
		t.Fatalf("deferred monitoring cycle made %d requests", n)
	}
}

func TestHeartbeatIgnoresLoopDeferral(t *testing.T) {
	rs := newRouteServer(t)
	const path = "/api/v1/agents/agent-1/heartbeat"
	rs.answer(path, overloaded("300"))
	h, _ := deferralTestHeartbeat(t, rs)
	statePath := filepath.Join(t.TempDir(), state.FileName)
	if err := state.Write(statePath, &state.AgentState{Status: state.StatusRunning, PID: 7}); err != nil {
		t.Fatal(err)
	}
	h.statePath = statePath
	// Pre-seed a deferral 300 s ahead on the heartbeat route itself: this
	// fails if the heartbeat is ever routed through the gate.
	hbURL := rs.srv.URL + path
	h.loopDefer.Record(loopKey("POST", hbURL), retryAtErr(time.Now().Add(300*time.Second)))

	before := time.Now().Add(-time.Second)
	for i := 1; i <= 2; i++ {
		if _, ok := h.doHeartbeatPost(rs.srv.URL, &HeartbeatPayload{Status: "ok"}); ok {
			t.Fatal("heartbeat reported success on a 503")
		}
		if n := rs.count(path); n != i {
			t.Fatalf("heartbeat %d: requests = %d, want %d (never deferred)", i, n, i)
		}
	}
	s, err := state.Read(statePath)
	if err != nil || s == nil {
		t.Fatalf("read state: %v", err)
	}
	if !s.ServerUnavailableAt.After(before) {
		t.Fatalf("ServerUnavailableAt = %v: the #9146 liveness marker stopped refreshing", s.ServerUnavailableAt)
	}
}

func TestCommandResultNeverDeferred(t *testing.T) {
	rs := newRouteServer(t)
	h, _ := deferralTestHeartbeat(t, rs)
	cmdID := "1b4e28ba-2fa1-11d2-883f-0016d3cca427"
	resultURL := h.agentRouteURL("commands/" + cmdID + "/result")
	h.loopDefer.Record(loopKey("POST", resultURL), retryAtErr(time.Now().Add(300*time.Second)))

	if err := h.submitCommandResult(cmdID, tools.CommandResult{Status: "completed"}); err != nil {
		t.Fatalf("submitCommandResult = %v", err)
	}
	if n := rs.count("/api/v1/agents/agent-1/commands/" + cmdID + "/result"); n != 1 {
		t.Fatalf("command result requests = %d, want 1 (never deferred)", n)
	}
}
