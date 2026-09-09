package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// TestSendWatchdogStateSyncReportsActiveBackupRuns proves the D3 wiring end
// to end: the watchdog's in-flight-backup veto (internal/watchdog/checks.go's
// CheckIPC) only works if the state_sync it receives actually carries the
// live backup-run count. This drives a real backup helper session through
// Broker.ForwardBackupCommand (the same path a real backup_run takes) so the
// helper's "started" ack leaves the run tracked as executing -- exactly what
// Broker.ActiveBackupRunCount reads -- rather than injecting the count
// directly, which would only prove the field exists and not that it's wired.
func TestSendWatchdogStateSyncReportsActiveBackupRuns(t *testing.T) {
	watchdogServerConn, watchdogClientConn := createTestSocketPair(t)
	watchdogSession := sessionbroker.NewSession(ipc.NewConn(watchdogServerConn), 0, "watchdog-1", "tester", "", "watchdog-1", []string{"watchdog"})
	go watchdogSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	broker := newTestBrokerWithSessions(t, watchdogSession)

	backupServerConn, backupClientConn := createTestSocketPair(t)
	backupSession := sessionbroker.NewSession(ipc.NewConn(backupServerConn), 0, "backup-1", "tester", "", "backup-1", []string{"backup"})
	// RecvLoop is what reads the helper's ack off the wire and routes it back
	// to ForwardBackupCommand's blocked SendCommand -- without it the call
	// below just times out.
	go backupSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	broker.SetBackupSession(backupSession)

	backupHelperConn := ipc.NewConn(backupClientConn)
	go func() {
		env, err := backupHelperConn.Recv()
		if err != nil {
			return
		}
		var req backupipc.BackupCommandRequest
		if jsonErr := json.Unmarshal(env.Payload, &req); jsonErr != nil {
			return
		}
		// Ack "started" and never send a terminal result -- the run stays
		// tracked as executing, which is exactly the state
		// ActiveBackupRunCount reads.
		result := backupipc.BackupCommandResult{CommandID: req.CommandID, Success: true, Stdout: `{"started":true}`}
		_ = backupHelperConn.SendTyped(env.ID, backupipc.TypeBackupResult, result)
	}()

	if _, err := broker.ForwardBackupCommand("cmd-1", "backup_run", nil, 5*time.Second, true); err != nil {
		t.Fatalf("ForwardBackupCommand: %v", err)
	}
	if got := broker.ActiveBackupRunCount(); got != 1 {
		t.Fatalf("precondition: expected 1 active run tracked after the ack, got %d", got)
	}

	h := &Heartbeat{sessionBroker: broker, agentVersion: "1.2.3"}
	h.sendWatchdogStateSync(time.Now())

	_ = watchdogClientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	watchdogClientIPC := ipc.NewConn(watchdogClientConn)
	env, err := watchdogClientIPC.Recv()
	if err != nil {
		t.Fatalf("watchdog did not receive a state_sync frame: %v", err)
	}
	if env.Type != ipc.TypeStateSync {
		t.Fatalf("expected a %s frame, got %s", ipc.TypeStateSync, env.Type)
	}
	var sync ipc.StateSync
	if err := json.Unmarshal(env.Payload, &sync); err != nil {
		t.Fatalf("unmarshal state_sync: %v", err)
	}
	if sync.ActiveBackupRuns != 1 {
		t.Fatalf("expected ActiveBackupRuns=1, got %d", sync.ActiveBackupRuns)
	}
	if sync.AgentVersion != "1.2.3" {
		t.Fatalf("expected AgentVersion to still be populated, got %q", sync.AgentVersion)
	}
}

// TestSendWatchdogStateSyncReportsZeroWithNoBackupRuns is the negative
// control: with no backup helper ever spawned, the state_sync must still
// report ActiveBackupRuns=0 (not omit the call, not panic).
func TestSendWatchdogStateSyncReportsZeroWithNoBackupRuns(t *testing.T) {
	watchdogServerConn, watchdogClientConn := createTestSocketPair(t)
	watchdogSession := sessionbroker.NewSession(ipc.NewConn(watchdogServerConn), 0, "watchdog-1", "tester", "", "watchdog-1", []string{"watchdog"})
	go watchdogSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	broker := newTestBrokerWithSessions(t, watchdogSession)
	h := &Heartbeat{sessionBroker: broker, agentVersion: "1.2.3"}
	h.sendWatchdogStateSync(time.Now())

	_ = watchdogClientConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	watchdogClientIPC := ipc.NewConn(watchdogClientConn)
	env, err := watchdogClientIPC.Recv()
	if err != nil {
		t.Fatalf("watchdog did not receive a state_sync frame: %v", err)
	}
	var sync ipc.StateSync
	if err := json.Unmarshal(env.Payload, &sync); err != nil {
		t.Fatalf("unmarshal state_sync: %v", err)
	}
	if sync.ActiveBackupRuns != 0 {
		t.Fatalf("expected ActiveBackupRuns=0 with no backup helper spawned, got %d", sync.ActiveBackupRuns)
	}
}
