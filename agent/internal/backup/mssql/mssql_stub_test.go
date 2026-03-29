//go:build !windows

package mssql

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestDiscoverInstances_ReturnsNotSupported(t *testing.T) {
	instances, err := DiscoverInstances()
	if !errors.Is(err, ErrMSSQLNotSupported) {
		t.Fatalf("expected ErrMSSQLNotSupported, got %v", err)
	}
	if instances != nil {
		t.Fatal("expected nil instances")
	}
}

func TestRunBackup_ReturnsNotSupported(t *testing.T) {
	result, err := RunBackup("MSSQLSERVER", "TestDB", "full", "/tmp/backup")
	if !errors.Is(err, ErrMSSQLNotSupported) {
		t.Fatalf("expected ErrMSSQLNotSupported, got %v", err)
	}
	if result != nil {
		t.Fatal("expected nil result")
	}
}

func TestListBackups_ReturnsNotSupported(t *testing.T) {
	results, err := ListBackups("MSSQLSERVER", "TestDB", 10)
	if !errors.Is(err, ErrMSSQLNotSupported) {
		t.Fatalf("expected ErrMSSQLNotSupported, got %v", err)
	}
	if results != nil {
		t.Fatal("expected nil results")
	}
}

func TestRunRestore_ReturnsNotSupported(t *testing.T) {
	result, err := RunRestore("MSSQLSERVER", "/tmp/backup.bak", "TestDB", false)
	if !errors.Is(err, ErrMSSQLNotSupported) {
		t.Fatalf("expected ErrMSSQLNotSupported, got %v", err)
	}
	if result != nil {
		t.Fatal("expected nil result")
	}
}

func TestVerifyBackup_ReturnsNotSupported(t *testing.T) {
	result, err := VerifyBackup("MSSQLSERVER", "/tmp/backup.bak")
	if !errors.Is(err, ErrMSSQLNotSupported) {
		t.Fatalf("expected ErrMSSQLNotSupported, got %v", err)
	}
	if result != nil {
		t.Fatal("expected nil result")
	}
}

func TestSQLInstance_JSONSerialization(t *testing.T) {
	inst := SQLInstance{
		Name:     "SQLEXPRESS",
		Version:  "16.0.1000",
		Edition:  "Express Edition",
		Port:     1433,
		AuthType: "windows",
		Status:   "online",
		Databases: []SQLDatabase{
			{
				Name:          "TestDB",
				SizeMB:        512,
				RecoveryModel: "FULL",
				TDEEnabled:    false,
				CompatLevel:   160,
			},
		},
	}

	data, err := json.Marshal(inst)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded SQLInstance
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Name != inst.Name {
		t.Fatalf("Name: expected %q, got %q", inst.Name, decoded.Name)
	}
	if decoded.Port != inst.Port {
		t.Fatalf("Port: expected %d, got %d", inst.Port, decoded.Port)
	}
	if len(decoded.Databases) != 1 {
		t.Fatalf("Databases: expected 1, got %d", len(decoded.Databases))
	}
	if decoded.Databases[0].SizeMB != 512 {
		t.Fatalf("SizeMB: expected 512, got %d", decoded.Databases[0].SizeMB)
	}
}

func TestBackupResult_JSONSerialization(t *testing.T) {
	result := BackupResult{
		InstanceName: "MSSQLSERVER",
		DatabaseName: "ProductionDB",
		BackupType:   "full",
		BackupFile:   `C:\Backups\ProductionDB_full_20260329.bak`,
		SizeBytes:    1073741824,
		Compressed:   true,
		FirstLSN:     "100000000001200001",
		LastLSN:      "100000000001300001",
		DatabaseLSN:  "100000000001100001",
		DurationMs:   15000,
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded BackupResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.SizeBytes != result.SizeBytes {
		t.Fatalf("SizeBytes: expected %d, got %d", result.SizeBytes, decoded.SizeBytes)
	}
	if decoded.Compressed != true {
		t.Fatal("expected Compressed=true")
	}
	if decoded.FirstLSN != result.FirstLSN {
		t.Fatalf("FirstLSN: expected %q, got %q", result.FirstLSN, decoded.FirstLSN)
	}
}

func TestRestoreResult_JSONSerialization(t *testing.T) {
	result := RestoreResult{
		DatabaseName:  "ProductionDB",
		RestoredAs:    "ProductionDB_restored",
		Status:        "completed",
		FilesRestored: 3,
		DurationMs:    25000,
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded RestoreResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Status != "completed" {
		t.Fatalf("Status: expected completed, got %q", decoded.Status)
	}
	if decoded.Error != "" {
		t.Fatalf("Error: expected empty, got %q", decoded.Error)
	}
}

func TestChainState_JSONSerialization(t *testing.T) {
	chain := ChainState{
		InstanceName:   "MSSQLSERVER",
		DatabaseName:   "ProductionDB",
		LastFullLSN:    "100000000001200001",
		LastDiffLSN:    "100000000001250001",
		LastLogLSN:     "100000000001280001",
		FullSnapshotID: "snap-abc123",
		IsActive:       true,
	}

	data, err := json.Marshal(chain)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded ChainState
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.IsActive != true {
		t.Fatal("expected IsActive=true")
	}

	// Verify omitempty works — when LastDiffLSN is empty
	chain2 := ChainState{
		InstanceName:   "SQLEXPRESS",
		DatabaseName:   "TestDB",
		LastFullLSN:    "100000000001200001",
		FullSnapshotID: "snap-def456",
		IsActive:       false,
	}
	data2, _ := json.Marshal(chain2)
	str := string(data2)
	if containsField(str, "lastDiffLsn") {
		t.Fatal("expected lastDiffLsn to be omitted")
	}
	if containsField(str, "lastLogLsn") {
		t.Fatal("expected lastLogLsn to be omitted")
	}
}

func TestVerifyResult_JSONSerialization(t *testing.T) {
	vr := VerifyResult{
		BackupFile: `C:\Backups\test.bak`,
		Valid:      true,
		DurationMs: 5000,
	}

	data, err := json.Marshal(vr)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded VerifyResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if !decoded.Valid {
		t.Fatal("expected Valid=true")
	}
	if decoded.Error != "" {
		t.Fatalf("expected empty Error, got %q", decoded.Error)
	}
}

func TestSentinelErrors(t *testing.T) {
	tests := []struct {
		name string
		err  error
		msg  string
	}{
		{"ErrMSSQLNotSupported", ErrMSSQLNotSupported, "mssql: not supported on this platform"},
		{"ErrInstanceNotFound", ErrInstanceNotFound, "mssql: SQL Server instance not found"},
		{"ErrBackupFailed", ErrBackupFailed, "mssql: backup operation failed"},
		{"ErrRestoreFailed", ErrRestoreFailed, "mssql: restore operation failed"},
		{"ErrVerifyFailed", ErrVerifyFailed, "mssql: backup verification failed"},
		{"ErrSqlcmdNotFound", ErrSqlcmdNotFound, "mssql: sqlcmd.exe not found on PATH"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.err.Error() != tt.msg {
				t.Fatalf("expected %q, got %q", tt.msg, tt.err.Error())
			}
		})
	}
}

// containsField checks if a JSON string contains the given field name.
func containsField(jsonStr, field string) bool {
	return len(jsonStr) > 0 && json.Valid([]byte(jsonStr)) &&
		(len(field) > 0 && jsonStr != "" && findInString(jsonStr, `"`+field+`"`))
}

func findInString(s, substr string) bool {
	return len(s) >= len(substr) && containsSubstring(s, substr)
}

func containsSubstring(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
