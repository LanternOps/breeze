package main

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/state"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// #8934: the agent reports "alive, server overloaded" over IPC as well as in
// agent.state (AV/EDR hosts cannot write the file, #2763). The report must
// reach the health checker and must not be mistaken for a successful
// heartbeat.
func TestHandleIPCMessage_StateSyncServerUnavailableReachesHealth(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer func() { _ = journal.Close() }()

	health := watchdog.NewHealthChecker(nil, stubIPCProber{}, 3*time.Minute)
	health.NoteStateSync(time.Now().Add(-time.Hour), 0)
	payload, _ := json.Marshal(ipc.StateSync{ServerUnavailableAt: time.Now().Format(time.RFC3339)})
	env := &ipc.Envelope{ID: "s", Type: ipc.TypeStateSync, Payload: payload}
	handleIPCMessage(env, watchdog.NewWatchdog(watchdog.Config{}), journal, &config.Config{AgentID: "a"}, &tokenHolder{}, health)

	if !health.AgentServerUnavailableAlive(nil) {
		t.Fatal("server-unavailable state_sync did not reach the health checker")
	}
	if time.Since(health.LastKnownHeartbeat(nil)) < 30*time.Minute {
		t.Fatal("a server-unavailable state_sync was recorded as a successful heartbeat")
	}
	if d, _ := health.EvaluateStaleHeartbeat(nil, true); d != watchdog.StaleServerUnavailable {
		t.Fatalf("decision = %v, want StaleServerUnavailable", d)
	}
}

// A restarted agent whose first heartbeats are answered 503 by an overloaded
// server is running: verification must succeed on the fresh marker, or
// RECOVERING times out and restarts it again into the same overload.
func TestRecoveryVerifiedAcceptsServerUnavailableMarker(t *testing.T) {
	health := watchdog.NewHealthChecker(nil, nil, 3*time.Minute)
	deadline := time.Now().Add(-10 * time.Second)

	ok, via := recoveryVerified(&state.AgentState{ServerUnavailableAt: time.Now()}, health, deadline)
	if !ok || via != verifiedViaServerUnavailable {
		t.Fatalf("recoveryVerified = (%v, %q), want (true, %q)", ok, via, verifiedViaServerUnavailable)
	}
	if ok, _ = recoveryVerified(&state.AgentState{ServerUnavailableAt: deadline.Add(-time.Second)}, health, deadline); ok {
		t.Fatal("pre-restart overload marker verified the restart")
	}
}

// A malformed marker is journaled and ignored: it must not grant liveness.
func TestHandleIPCMessage_BadServerUnavailableTimestampGrantsNothing(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer func() { _ = journal.Close() }()

	health := watchdog.NewHealthChecker(nil, stubIPCProber{}, 3*time.Minute)
	payload, _ := json.Marshal(ipc.StateSync{ServerUnavailableAt: "not-a-time"})
	env := &ipc.Envelope{ID: "s", Type: ipc.TypeStateSync, Payload: payload}
	handleIPCMessage(env, watchdog.NewWatchdog(watchdog.Config{}), journal, &config.Config{AgentID: "a"}, &tokenHolder{}, health)

	if health.AgentServerUnavailableAlive(nil) || health.AgentAlive(nil) {
		t.Fatal("a malformed serverUnavailableAt granted liveness")
	}
}
