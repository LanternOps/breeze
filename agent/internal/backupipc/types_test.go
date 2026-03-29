package backupipc

import (
	"encoding/json"
	"testing"
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
