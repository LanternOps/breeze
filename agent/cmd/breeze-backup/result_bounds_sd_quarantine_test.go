package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// TestFitBackupResultBoundsQuarantinedPaths: the per-entry list of
// quarantined security descriptors is bounded like failedFiles — an
// oversize list is dropped (and the drop recorded in the warning) while the
// quarantined COUNT, a summary scalar, always survives.
func TestFitBackupResultBoundsQuarantinedPaths(t *testing.T) {
	paths := make([]string, 0, 200000)
	for i := 0; i < 200000; i++ {
		paths = append(paths, fmt.Sprintf(`C:\Users\jdoe\Documents\archive\report_%06d.docx`, i))
	}
	restore := backup.RestoreResult{
		SnapshotID:                         "snapshot-20260801T125517Z-5edfcd7e",
		Status:                             "completed",
		FilesRestored:                      len(paths),
		SecurityDescriptorQuarantined:      len(paths),
		SecurityDescriptorQuarantinedPaths: paths,
	}
	data, err := json.Marshal(restore)
	if err != nil {
		t.Fatal(err)
	}
	fitted, degraded := fitBackupResultForDelivery(backupipc.BackupCommandResult{CommandID: "restore-1", Success: true, Stdout: string(data)})
	if degraded == "" {
		t.Fatal("expected the oversize quarantine list to degrade the result")
	}
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	var out backup.RestoreResult
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	if out.SecurityDescriptorQuarantined != len(paths) {
		t.Errorf("securityDescriptorQuarantined = %d, want %d to survive", out.SecurityDescriptorQuarantined, len(paths))
	}
	if len(out.SecurityDescriptorQuarantinedPaths) != 0 {
		t.Errorf("expected the quarantined path list to be dropped, got %d entries", len(out.SecurityDescriptorQuarantinedPaths))
	}
	if !strings.Contains(degraded, "securityDescriptorQuarantinedPaths") {
		t.Errorf("degradation note %q does not record the dropped list", degraded)
	}
}
