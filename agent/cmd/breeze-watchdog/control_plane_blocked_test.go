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

// #8868: the blocked marker arrives over IPC as well as agent.state and must
// not be mistaken for a successful heartbeat.
func TestHandleIPCMessage_StateSyncControlPlaneBlockedReachesHealth(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer func() { _ = journal.Close() }()

	health := watchdog.NewHealthChecker(nil, stubIPCProber{}, 3*time.Minute)
	health.NoteStateSync(time.Now().Add(-time.Hour), 0)
	payload, _ := json.Marshal(ipc.StateSync{ControlPlaneBlockedAt: time.Now().Format(time.RFC3339)})
	env := &ipc.Envelope{ID: "s", Type: ipc.TypeStateSync, Payload: payload}
	handleIPCMessage(env, watchdog.NewWatchdog(watchdog.Config{}), journal, &config.Config{AgentID: "a"}, &tokenHolder{}, health)

	if !health.AgentControlPlaneBlockedAlive(nil) {
		t.Fatal("blocked state_sync did not reach the health checker")
	}
	if time.Since(health.LastKnownHeartbeat(nil)) < 30*time.Minute {
		t.Fatal("a blocked state_sync was recorded as a successful heartbeat")
	}
	if d, _ := health.EvaluateStaleHeartbeat(nil, true); d != watchdog.StaleControlPlaneBlocked {
		t.Fatalf("decision = %v, want StaleControlPlaneBlocked", d)
	}
}

func TestRecoveryVerifiedAcceptsControlPlaneBlockedMarker(t *testing.T) {
	health := watchdog.NewHealthChecker(nil, nil, 3*time.Minute)
	deadline := time.Now().Add(-10 * time.Second)
	ok, via := recoveryVerified(&state.AgentState{ControlPlaneBlockedAt: time.Now()}, health, deadline)
	if !ok || via != verifiedViaControlPlaneBlocked {
		t.Fatalf("recoveryVerified = (%v, %q), want (true, %q)", ok, via, verifiedViaControlPlaneBlocked)
	}
	if ok, _ = recoveryVerified(&state.AgentState{ControlPlaneBlockedAt: deadline.Add(-time.Second)}, health, deadline); ok {
		t.Fatal("pre-restart blocked marker verified the restart")
	}
}

func TestHandleIPCMessage_BadControlPlaneBlockedTimestampGrantsNothing(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 10, 3)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer func() { _ = journal.Close() }()

	health := watchdog.NewHealthChecker(nil, stubIPCProber{}, 3*time.Minute)
	payload, _ := json.Marshal(ipc.StateSync{ControlPlaneBlockedAt: "not-a-time"})
	env := &ipc.Envelope{ID: "s", Type: ipc.TypeStateSync, Payload: payload}
	handleIPCMessage(env, watchdog.NewWatchdog(watchdog.Config{}), journal, &config.Config{AgentID: "a"}, &tokenHolder{}, health)

	if health.AgentControlPlaneBlockedAlive(nil) || health.AgentAlive(nil) {
		t.Fatal("a malformed controlPlaneBlockedAt granted liveness")
	}
}
