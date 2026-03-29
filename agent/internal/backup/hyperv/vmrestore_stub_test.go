//go:build !windows

package hyperv

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestRestoreAsVM_ReturnsNotSupported(t *testing.T) {
	result, err := RestoreAsVM(context.Background(), VMRestoreFromBackupConfig{
		SnapshotID: "snap-123",
		VMName:     "TestVM",
	}, nil, nil)
	if !errors.Is(err, ErrHyperVNotSupported) {
		t.Errorf("expected ErrHyperVNotSupported, got %v", err)
	}
	if result != nil {
		t.Errorf("expected nil result, got %v", result)
	}
}

func TestInstantBoot_ReturnsNotSupported(t *testing.T) {
	result, err := InstantBoot(context.Background(), InstantBootConfig{
		SnapshotID: "snap-123",
		VMName:     "TestVM",
	}, nil, nil)
	if !errors.Is(err, ErrHyperVNotSupported) {
		t.Errorf("expected ErrHyperVNotSupported, got %v", err)
	}
	if result != nil {
		t.Errorf("expected nil result, got %v", result)
	}
}

func TestVMRestoreFromBackupConfig_JSON(t *testing.T) {
	cfg := VMRestoreFromBackupConfig{
		SnapshotID: "snap-abc",
		VMName:     "RestoreVM",
		MemoryMB:   8192,
		CPUCount:   4,
		DiskSizeGB: 100,
		SwitchName: "Default Switch",
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("failed to marshal VMRestoreFromBackupConfig: %v", err)
	}

	var decoded VMRestoreFromBackupConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal VMRestoreFromBackupConfig: %v", err)
	}

	if decoded.SnapshotID != cfg.SnapshotID {
		t.Errorf("SnapshotID mismatch: got %q, want %q", decoded.SnapshotID, cfg.SnapshotID)
	}
	if decoded.VMName != cfg.VMName {
		t.Errorf("VMName mismatch: got %q, want %q", decoded.VMName, cfg.VMName)
	}
	if decoded.MemoryMB != cfg.MemoryMB {
		t.Errorf("MemoryMB mismatch: got %d, want %d", decoded.MemoryMB, cfg.MemoryMB)
	}
	if decoded.CPUCount != cfg.CPUCount {
		t.Errorf("CPUCount mismatch: got %d, want %d", decoded.CPUCount, cfg.CPUCount)
	}
	if decoded.DiskSizeGB != cfg.DiskSizeGB {
		t.Errorf("DiskSizeGB mismatch: got %d, want %d", decoded.DiskSizeGB, cfg.DiskSizeGB)
	}
	if decoded.SwitchName != cfg.SwitchName {
		t.Errorf("SwitchName mismatch: got %q, want %q", decoded.SwitchName, cfg.SwitchName)
	}
}

func TestVMRestoreFromBackupResult_JSON(t *testing.T) {
	result := VMRestoreFromBackupResult{
		VMName:     "RestoredVM",
		NewVMID:    "guid-123-456",
		VHDXPath:   `C:\VMs\test.vhdx`,
		Status:     "completed",
		DurationMs: 120000,
		Warnings:   []string{"driver injection skipped"},
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("failed to marshal VMRestoreFromBackupResult: %v", err)
	}

	var decoded VMRestoreFromBackupResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal VMRestoreFromBackupResult: %v", err)
	}

	if decoded.Status != "completed" {
		t.Errorf("Status mismatch: got %q, want %q", decoded.Status, "completed")
	}
	if decoded.VHDXPath != result.VHDXPath {
		t.Errorf("VHDXPath mismatch: got %q, want %q", decoded.VHDXPath, result.VHDXPath)
	}
	if len(decoded.Warnings) != 1 {
		t.Errorf("Warnings length mismatch: got %d, want 1", len(decoded.Warnings))
	}
}

func TestVMRestoreFromBackupResult_FailedJSON(t *testing.T) {
	result := VMRestoreFromBackupResult{
		VMName: "FailedVM",
		Status: "failed",
		Error:  "disk creation failed",
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("failed to marshal failed result: %v", err)
	}

	var decoded VMRestoreFromBackupResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal failed result: %v", err)
	}

	if decoded.Status != "failed" {
		t.Errorf("Status mismatch: got %q, want %q", decoded.Status, "failed")
	}
	if decoded.Error != "disk creation failed" {
		t.Errorf("Error mismatch: got %q", decoded.Error)
	}
}

func TestInstantBootConfig_JSON(t *testing.T) {
	cfg := InstantBootConfig{
		SnapshotID: "snap-xyz",
		VMName:     "InstantVM",
		MemoryMB:   16384,
		CPUCount:   8,
		DiskSizeGB: 200,
		WorkDir:    `D:\Temp\instant`,
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("failed to marshal InstantBootConfig: %v", err)
	}

	var decoded InstantBootConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal InstantBootConfig: %v", err)
	}

	if decoded.SnapshotID != cfg.SnapshotID {
		t.Errorf("SnapshotID mismatch: got %q, want %q", decoded.SnapshotID, cfg.SnapshotID)
	}
	if decoded.WorkDir != cfg.WorkDir {
		t.Errorf("WorkDir mismatch: got %q, want %q", decoded.WorkDir, cfg.WorkDir)
	}
}

func TestInstantBootResult_JSON(t *testing.T) {
	result := InstantBootResult{
		VMName:               "InstantVM",
		NewVMID:              "guid-789",
		Status:               "completed",
		BootTimeMs:           3500,
		BackgroundSyncActive: true,
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("failed to marshal InstantBootResult: %v", err)
	}

	var decoded InstantBootResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("failed to unmarshal InstantBootResult: %v", err)
	}

	if decoded.BootTimeMs != 3500 {
		t.Errorf("BootTimeMs mismatch: got %d, want 3500", decoded.BootTimeMs)
	}
	if !decoded.BackgroundSyncActive {
		t.Error("BackgroundSyncActive should be true")
	}
}

func TestInstantBootResult_OmitsEmptyError(t *testing.T) {
	result := InstantBootResult{
		VMName: "TestVM",
		Status: "completed",
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	// The "error" field should be omitted when empty.
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("failed to unmarshal to map: %v", err)
	}
	if _, exists := raw["error"]; exists {
		t.Error("expected 'error' field to be omitted when empty")
	}
}

func TestVMRestoreFromBackupResult_OmitsEmptyWarnings(t *testing.T) {
	result := VMRestoreFromBackupResult{
		VMName: "TestVM",
		Status: "completed",
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("failed to unmarshal to map: %v", err)
	}
	if _, exists := raw["warnings"]; exists {
		t.Error("expected 'warnings' field to be omitted when nil/empty")
	}
}
