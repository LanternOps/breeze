package backupipc

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestBackupCommandRequestRoundTrip(t *testing.T) {
	req := BackupCommandRequest{
		CommandID:   "cmd-123",
		CommandType: "backup_run",
		Payload:     json.RawMessage(`{"paths":["/data"]}`),
		TimeoutMs:   60000,
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}
	var decoded BackupCommandRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.CommandID != req.CommandID {
		t.Errorf("got %s, want %s", decoded.CommandID, req.CommandID)
	}
	if decoded.CommandType != req.CommandType {
		t.Errorf("got %s, want %s", decoded.CommandType, req.CommandType)
	}
}

func TestBackupCommandResultRoundTrip(t *testing.T) {
	res := BackupCommandResult{
		CommandID:  "cmd-123",
		Success:    true,
		Stdout:     `{"status":"completed"}`,
		DurationMs: 5000,
	}
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var decoded BackupCommandResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.Success {
		t.Error("expected success=true")
	}
}

func TestBackupProgressRoundTrip(t *testing.T) {
	p := BackupProgress{CommandID: "cmd-1", Phase: "upload", Current: 50, Total: 100, Message: "uploading"}
	data, _ := json.Marshal(p)
	var decoded BackupProgress
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Current != 50 || decoded.Total != 100 {
		t.Errorf("got %d/%d, want 50/100", decoded.Current, decoded.Total)
	}
}

// #3006: the snapshot ID must survive the IPC hop under the exact JSON key the
// server's backupProgressPayloadSchema validates ("snapshotId"), and must be
// omitted entirely — not sent as "" — when no snapshot exists yet, so the
// server can distinguish "no ID yet" from "empty ID".
func TestBackupProgressSnapshotIDRoundTrip(t *testing.T) {
	p := BackupProgress{CommandID: "cmd-1", Phase: "uploading", SnapshotID: "snapshot-20260801T101500Z-a1b2c3d4"}
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"snapshotId":"snapshot-20260801T101500Z-a1b2c3d4"`) {
		t.Fatalf("snapshot ID missing or misnamed on the wire: %s", data)
	}

	var decoded BackupProgress
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.SnapshotID != p.SnapshotID {
		t.Errorf("got snapshotId %q, want %q", decoded.SnapshotID, p.SnapshotID)
	}

	empty, err := json.Marshal(BackupProgress{CommandID: "cmd-1", Phase: "uploading"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(empty), "snapshotId") {
		t.Fatalf("pre-snapshot progress must omit snapshotId entirely: %s", empty)
	}
}

func TestConstants(t *testing.T) {
	if TypeBackupCommand != "backup_command" {
		t.Error("unexpected constant value")
	}
	if HelperRoleBackup != "backup" {
		t.Error("unexpected role value")
	}
}

func TestBackupCapabilitiesRoundTrip(t *testing.T) {
	caps := BackupCapabilities{
		SupportsVSS:         true,
		SupportsMSSQL:       true,
		SupportsHyperV:      false,
		SupportsSystemState: true,
		Providers:           []string{"local", "s3"},
	}
	data, err := json.Marshal(caps)
	if err != nil {
		t.Fatal(err)
	}
	var decoded BackupCapabilities
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if !decoded.SupportsVSS {
		t.Error("expected supportsVss=true")
	}
	if len(decoded.Providers) != 2 {
		t.Errorf("expected 2 providers, got %d", len(decoded.Providers))
	}
}

// #6598: the helper's verify/test-restore budget must expire before the
// agent's forward wait, with room to unwind, or the partial counts are lost.
func TestVerifyRunBudgetStaysUnderCommandTimeout(t *testing.T) {
	if VerifyCommandTimeout != 2*time.Hour {
		t.Fatalf("verify command timeout = %v, want the API's 2h LONG_TIMEOUT_TYPES tier", VerifyCommandTimeout)
	}
	if VerifyRunBudget <= 0 || VerifyRunBudget >= VerifyCommandTimeout {
		t.Fatalf("run budget %v must be positive and shorter than the command timeout %v", VerifyRunBudget, VerifyCommandTimeout)
	}
	if VerifyCommandTimeout-VerifyRunBudget < 5*time.Minute {
		t.Fatalf("keep >=5m between run budget %v and command timeout %v for unwind + cleanup + IPC", VerifyRunBudget, VerifyCommandTimeout)
	}
}

func TestBackupStopDrainStaysUnderForwardTimeout(t *testing.T) {
	if BackupStopDrainTimeout >= BackupStopForwardTimeout {
		t.Fatalf("drain %v must be shorter than forward %v or a drained stop times out at the agent", BackupStopDrainTimeout, BackupStopForwardTimeout)
	}
	if BackupStopForwardTimeout-BackupStopDrainTimeout < 5*time.Second {
		t.Fatalf("keep >=5s of IPC slack between drain %v and forward %v", BackupStopDrainTimeout, BackupStopForwardTimeout)
	}
}

// #6664: the rebuild budget must not fall back to the old fixed 4 h, must
// leave the helper room to unwind and report before the agent stops
// waiting, and the agent must stop waiting before the server's 24 h reaper.
func TestBareMetalRebuildBudgetStaysUnderForwardTimeout(t *testing.T) {
	if BareMetalRebuildRunBudget <= 4*time.Hour {
		t.Fatalf("run budget %v must be well above the old fixed 4h", BareMetalRebuildRunBudget)
	}
	if BareMetalRebuildForwardTimeout-BareMetalRebuildRunBudget < 5*time.Minute {
		t.Fatalf("keep >=5m between run budget %v and forward timeout %v for unwind + progress post + IPC", BareMetalRebuildRunBudget, BareMetalRebuildForwardTimeout)
	}
	if BareMetalRebuildForwardTimeout >= 24*time.Hour {
		t.Fatalf("forward timeout %v must stay under the API's 24h whole-machine restore reaper", BareMetalRebuildForwardTimeout)
	}
}
