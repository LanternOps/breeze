package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/state"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// #2796: the agent reports "alive, credentials rejected" over IPC when
// agent.state cannot be written (AV/EDR, #2763). That report must reach the
// health checker, and must not be mistaken for a successful heartbeat.
func TestHandleIPCMessage_StateSyncAuthRejectedReachesHealth(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer func() { _ = journal.Close() }()

	health := watchdog.NewHealthChecker(nil, stubIPCProber{}, 3*time.Minute)
	payload, _ := json.Marshal(ipc.StateSync{AuthRejectedAt: time.Now().Format(time.RFC3339)})
	env := &ipc.Envelope{ID: "s", Type: ipc.TypeStateSync, Payload: payload}
	handleIPCMessage(env, watchdog.NewWatchdog(watchdog.Config{}), journal, &config.Config{AgentID: "a"}, &tokenHolder{}, health)

	if !health.AgentAuthRejectedAlive(nil) {
		t.Fatal("auth-rejected state_sync did not reach the health checker")
	}
	if !health.LastKnownHeartbeat(nil).IsZero() {
		t.Fatal("an auth-rejected state_sync was recorded as a successful heartbeat")
	}
	if d, _ := health.EvaluateStaleHeartbeat(nil, true); d == watchdog.StaleRestart || d == watchdog.StaleVetoed {
		t.Fatalf("decision = %v — an auth-rejected agent was sent toward restart", d)
	}
}

// A skipped (auth-backoff) failover tick sends nothing and is not a failure:
// it must not advance the consecutive-failure counter that drives backup-URL
// probing and config reloads.
func TestHandleFailoverPoll_AuthBackoffSkipIsSilent(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer func() { _ = journal.Close() }()

	fc := watchdog.NewFailoverClient(srv.URL, "agent-1", "tok", nil)
	// Trip the backoff directly.
	for i := 0; i < 5; i++ {
		_, _ = fc.SendHeartbeat("v", "failover", watchdog.RestartStats{})
	}
	if fc.AuthRetryIn() <= 0 {
		t.Fatal("setup: auth backoff not armed")
	}
	before := hits.Load()

	failures := 7
	lastDisk := srv.URL
	handleFailoverPoll(context.Background(), fc, watchdog.NewWatchdog(watchdog.Config{}), journal,
		&config.Config{AgentID: "agent-1", ServerURL: srv.URL}, &tokenHolder{},
		watchdog.NewRecoveryManager(3, 0), 5, &failures, &lastDisk)

	if hits.Load() != before {
		t.Fatal("a request reached the server during the auth backoff window")
	}
	if failures != 7 {
		t.Fatalf("failoverFailures = %d, want unchanged 7 on a skipped tick", failures)
	}
}

// A restart attempt whose new agent comes up and is immediately rejected by
// the server has still produced a running agent: verification must succeed on
// the fresh auth-rejected marker, or RECOVERING times out and restarts again.
func TestRecoveryVerifiedAcceptsAuthRejectedMarker(t *testing.T) {
	health := watchdog.NewHealthChecker(nil, nil, 3*time.Minute)
	deadline := time.Now().Add(-10 * time.Second)

	ok, viaAuth := recoveryVerified(&state.AgentState{AuthRejectedAt: time.Now()}, health, deadline)
	if !ok || !viaAuth {
		t.Fatalf("recoveryVerified = (%v, %v), want (true, true)", ok, viaAuth)
	}
	ok, viaAuth = recoveryVerified(&state.AgentState{LastHeartbeat: time.Now()}, health, deadline)
	if !ok || viaAuth {
		t.Fatalf("heartbeat path: recoveryVerified = (%v, %v), want (true, false)", ok, viaAuth)
	}
	// Evidence older than the deadline belongs to the previous process.
	ok, _ = recoveryVerified(&state.AgentState{AuthRejectedAt: deadline.Add(-time.Second), LastHeartbeat: deadline.Add(-time.Second)}, health, deadline)
	if ok {
		t.Fatal("pre-restart evidence verified the restart")
	}
	if ok, _ = recoveryVerified(nil, health, deadline); ok {
		t.Fatal("nil state verified the restart")
	}
}

// Advisor quorum (#2796): a token rotated over IPC must reach the live
// failover client (it was copied at FAILOVER entry and never refreshed) and
// clear the auth backoff the old token earned.
func TestApplyFailoverTokenUpdate(t *testing.T) {
	var hits atomic.Int32
	var status atomic.Int32
	status.Store(http.StatusUnauthorized)
	var lastAuth atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		lastAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(int(status.Load()))
		w.Write([]byte(`{}`)) //nolint:errcheck
	}))
	defer srv.Close()

	mon := watchdog.NewFailoverAuthMonitor()
	fc := watchdog.NewFailoverClient(srv.URL, "agent-1", "old", nil)
	fc.SetAuthMonitor(mon)
	for i := 0; i < 3; i++ {
		_, _ = fc.SendHeartbeat("v", "failover", watchdog.RestartStats{})
	}
	if !mon.ShouldSkip() {
		t.Fatal("setup: backoff not armed")
	}

	// Unchanged token (e.g. a token_update that failed to parse): no reset.
	applyFailoverTokenUpdate(fc, mon, "old", "old")
	if !mon.ShouldSkip() {
		t.Fatal("backoff cleared although the token did not change")
	}

	status.Store(http.StatusOK)
	applyFailoverTokenUpdate(fc, mon, "old", "new")
	if _, err := fc.SendHeartbeat("v", "failover", watchdog.RestartStats{}); err != nil {
		t.Fatalf("heartbeat after token rotation: %v", err)
	}
	if got, _ := lastAuth.Load().(string); got != "Bearer new" {
		t.Fatalf("Authorization = %q, want the rotated token", got)
	}

	// No live client (not in FAILOVER): the process-lifetime monitor still resets.
	mon2 := watchdog.NewFailoverAuthMonitor()
	mon2.RecordAuthFailure()
	mon2.RecordAuthFailure()
	applyFailoverTokenUpdate(nil, mon2, "a", "b")
	if mon2.ShouldSkip() {
		t.Fatal("backoff survived a token rotation with no live failover client")
	}
}
