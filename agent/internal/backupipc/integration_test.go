package backupipc

import (
	"encoding/json"
	"testing"
)

func TestFullCommandRoundTrip(t *testing.T) {
	// Simulate what the agent sends and backup binary receives
	req := BackupCommandRequest{
		CommandID:   "test-cmd-1",
		CommandType: "backup_run",
		Payload:     json.RawMessage(`{"paths":["/tmp/test"]}`),
		TimeoutMs:   60000,
	}

	// Serialize (agent side)
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	// Deserialize (backup binary side)
	var received BackupCommandRequest
	if err := json.Unmarshal(data, &received); err != nil {
		t.Fatal(err)
	}

	if received.CommandType != "backup_run" {
		t.Errorf("got %s, want backup_run", received.CommandType)
	}

	// Simulate backup binary response
	result := BackupCommandResult{
		CommandID:  received.CommandID,
		Success:    true,
		Stdout:     `{"jobId":"job-1","status":"completed","filesBackedUp":42}`,
		DurationMs: 1500,
	}

	// Serialize (backup side)
	resultData, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	// Deserialize (agent side)
	var agentResult BackupCommandResult
	if err := json.Unmarshal(resultData, &agentResult); err != nil {
		t.Fatal(err)
	}

	if !agentResult.Success {
		t.Error("expected success")
	}
	if agentResult.CommandID != "test-cmd-1" {
		t.Errorf("got %s, want test-cmd-1", agentResult.CommandID)
	}
}

func TestProgressStreaming(t *testing.T) {
	updates := []BackupProgress{
		{CommandID: "cmd-1", Phase: "scan", Current: 0, Total: 100},
		{CommandID: "cmd-1", Phase: "upload", Current: 50, Total: 100, Message: "uploading chunk 5/10"},
		{CommandID: "cmd-1", Phase: "complete", Current: 100, Total: 100},
	}

	for _, p := range updates {
		data, err := json.Marshal(p)
		if err != nil {
			t.Fatalf("failed to marshal progress: %v", err)
		}
		var decoded BackupProgress
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Fatalf("failed to unmarshal progress: %v", err)
		}
		if decoded.CommandID != "cmd-1" {
			t.Errorf("got %s, want cmd-1", decoded.CommandID)
		}
	}
}

func TestErrorCommandRoundTrip(t *testing.T) {
	req := BackupCommandRequest{
		CommandID:   "test-err-1",
		CommandType: "backup_restore",
		Payload:     json.RawMessage(`{"snapshotId":"snap-404"}`),
		TimeoutMs:   30000,
	}

	data, err := json.Marshal(req)
	if err != nil {
		t.Fatal(err)
	}

	var received BackupCommandRequest
	if err := json.Unmarshal(data, &received); err != nil {
		t.Fatal(err)
	}

	// Simulate error response
	result := BackupCommandResult{
		CommandID:  received.CommandID,
		Success:    false,
		Stderr:     "snapshot snap-404 not found",
		DurationMs: 50,
	}

	resultData, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}

	var agentResult BackupCommandResult
	if err := json.Unmarshal(resultData, &agentResult); err != nil {
		t.Fatal(err)
	}

	if agentResult.Success {
		t.Error("expected failure")
	}
	if agentResult.Stderr != "snapshot snap-404 not found" {
		t.Errorf("unexpected error: %s", agentResult.Stderr)
	}
}

func TestAllCommandTypes(t *testing.T) {
	// Verify all backup command types can be serialized and deserialized
	types := []string{
		"backup_run", "backup_list", "backup_stop", "backup_restore",
		"backup_verify", "backup_test_restore", "backup_cleanup",
		"vss_status", "vss_writer_list",
		"mssql_discover", "mssql_backup", "mssql_restore", "mssql_verify",
		"hyperv_discover", "hyperv_backup", "hyperv_restore", "hyperv_checkpoint", "hyperv_vm_state",
		"system_state_collect", "hardware_profile",
		"vm_restore_estimate", "vm_restore_from_backup", "bmr_recover",
	}

	for _, cmdType := range types {
		req := BackupCommandRequest{
			CommandID:   "test-" + cmdType,
			CommandType: cmdType,
			Payload:     json.RawMessage(`{}`),
			TimeoutMs:   10000,
		}

		data, err := json.Marshal(req)
		if err != nil {
			t.Errorf("failed to marshal %s: %v", cmdType, err)
			continue
		}

		var decoded BackupCommandRequest
		if err := json.Unmarshal(data, &decoded); err != nil {
			t.Errorf("failed to unmarshal %s: %v", cmdType, err)
			continue
		}

		if decoded.CommandType != cmdType {
			t.Errorf("round-trip failed for %s: got %s", cmdType, decoded.CommandType)
		}
	}
}
