package heartbeat

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/state"
)

// #8868: the marker must reach the watchdog session (agent.state is unwritable
// on AV/EDR hosts) and must never look like a successful heartbeat.
func TestNoteControlPlaneBlockedLiveness_SendsStateSyncWithoutLastHeartbeat(t *testing.T) {
	watchdogServerConn, watchdogClientConn := createTestSocketPair(t)
	watchdogSession := sessionbroker.NewSession(ipc.NewConn(watchdogServerConn), 0, "watchdog-1", "tester", "", "watchdog-1", []string{"watchdog"})
	go watchdogSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	broker := newTestBrokerWithSessions(t, watchdogSession)

	statePath := filepath.Join(t.TempDir(), state.FileName)
	hbAt := time.Now().Add(-2 * time.Hour).UTC().Truncate(time.Second)
	if err := state.Write(statePath, &state.AgentState{Status: state.StatusRunning, PID: 7, LastHeartbeat: hbAt}); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{sessionBroker: broker, agentVersion: "1.2.3", statePath: statePath}
	before := time.Now().Add(-time.Second)
	h.noteControlPlaneBlockedLiveness()

	s, err := state.Read(statePath)
	if err != nil || s == nil {
		t.Fatalf("read state: %v %v", s, err)
	}
	if !s.ControlPlaneBlockedAt.After(before) || !s.LastHeartbeat.Equal(hbAt) {
		t.Fatalf("state file = %+v", s)
	}

	_ = watchdogClientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	env, err := ipc.NewConn(watchdogClientConn).Recv()
	if err != nil {
		t.Fatalf("watchdog did not receive a state_sync frame: %v", err)
	}
	if env.Type != ipc.TypeStateSync {
		t.Fatalf("frame type = %s, want %s", env.Type, ipc.TypeStateSync)
	}
	var sync ipc.StateSync
	if err := json.Unmarshal(env.Payload, &sync); err != nil {
		t.Fatalf("unmarshal state_sync: %v", err)
	}
	at, err := time.Parse(time.RFC3339, sync.ControlPlaneBlockedAt)
	if err != nil || at.Before(before.Truncate(time.Second)) {
		t.Fatalf("ControlPlaneBlockedAt = %q (%v), want a fresh RFC3339 timestamp", sync.ControlPlaneBlockedAt, err)
	}
	if sync.LastHeartbeat != "" || sync.Connected {
		t.Fatalf("state_sync reads as a successful heartbeat: LastHeartbeat=%q Connected=%v", sync.LastHeartbeat, sync.Connected)
	}
	if sync.ServerUnavailableAt != "" || sync.AuthRejectedAt != "" {
		t.Fatalf("unrelated markers set: %+v", sync)
	}
}

// A blocked agent fails every tick for days; the WARN is once per streak.
func TestNoteControlPlaneBlockedLiveness_WarnsOncePerStreak(t *testing.T) {
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	h := &Heartbeat{}
	const msg = "control plane blocked"
	count := func() int {
		n := 0
		for _, line := range strings.Split(buf.String(), "\n") {
			if strings.Contains(line, "level=WARN") && strings.Contains(line, msg) {
				n++
			}
		}
		return n
	}
	for i := 0; i < 3; i++ {
		h.noteControlPlaneBlockedLiveness()
	}
	if got := count(); got != 1 {
		t.Fatalf("WARN count after 3 calls = %d, want 1\n%s", got, buf.String())
	}
	h.clearControlPlaneBlockedLatch()
	h.noteControlPlaneBlockedLiveness()
	if got := count(); got != 2 {
		t.Fatalf("WARN count after latch reset = %d, want 2\n%s", got, buf.String())
	}
}
