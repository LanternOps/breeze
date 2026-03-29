//go:build !windows

package hyperv

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestDiscoverVMs_ReturnsNotSupported(t *testing.T) {
	vms, err := DiscoverVMs()
	if !errors.Is(err, ErrHyperVNotSupported) {
		t.Errorf("expected ErrHyperVNotSupported, got %v", err)
	}
	if vms != nil {
		t.Errorf("expected nil VMs, got %v", vms)
	}
}

func TestExportVM_ReturnsNotSupported(t *testing.T) {
	result, err := ExportVM("test-vm", "/tmp/export", "application")
	if !errors.Is(err, ErrHyperVNotSupported) {
		t.Errorf("expected ErrHyperVNotSupported, got %v", err)
	}
	if result != nil {
		t.Errorf("expected nil result, got %v", result)
	}
}

func TestImportVM_ReturnsNotSupported(t *testing.T) {
	result, err := ImportVM("/tmp/export", "test-vm", true)
	if !errors.Is(err, ErrHyperVNotSupported) {
		t.Errorf("expected ErrHyperVNotSupported, got %v", err)
	}
	if result != nil {
		t.Errorf("expected nil result, got %v", result)
	}
}

func TestManageCheckpoint_ReturnsNotSupported(t *testing.T) {
	result, err := ManageCheckpoint("test-vm", "create", "cp-1")
	if !errors.Is(err, ErrHyperVNotSupported) {
		t.Errorf("expected ErrHyperVNotSupported, got %v", err)
	}
	if result != nil {
		t.Errorf("expected nil result, got %v", result)
	}
}

func TestChangeVMState_ReturnsNotSupported(t *testing.T) {
	result, err := ChangeVMState("test-vm", "start")
	if !errors.Is(err, ErrHyperVNotSupported) {
		t.Errorf("expected ErrHyperVNotSupported, got %v", err)
	}
	if result != nil {
		t.Errorf("expected nil result, got %v", result)
	}
}

func TestTypeSerialization(t *testing.T) {
	tests := []struct {
		name string
		val  any
	}{
		{
			name: "HyperVVM",
			val: HyperVVM{
				ID:             "abc-123",
				Name:           "TestVM",
				State:          "Running",
				Generation:     2,
				MemoryMB:       4096,
				ProcessorCount: 4,
				VHDPaths: []VHDInfo{
					{Path: `C:\VMs\disk.vhdx`, SizeGB: 100, Type: "vhdx"},
				},
				RCTEnabled:  true,
				Checkpoints: []Checkpoint{{ID: "cp1", Name: "snap1", CreatedAt: "2026-01-01T00:00:00Z"}},
			},
		},
		{
			name: "BackupResult",
			val: BackupResult{
				VMName:          "TestVM",
				VMID:            "abc-123",
				BackupType:      "full",
				ConsistencyType: "application",
				ExportPath:      `D:\Exports\TestVM`,
				SizeBytes:       1073741824,
				VHDCount:        2,
				DurationMs:      5000,
			},
		},
		{
			name: "RestoreResult",
			val: RestoreResult{
				VMName:     "TestVM",
				NewVMID:    "def-456",
				Status:     "completed",
				DurationMs: 3000,
			},
		},
		{
			name: "CheckpointResult",
			val: CheckpointResult{
				Action:       "create",
				CheckpointID: "cp-1",
				VMName:       "TestVM",
				Status:       "completed",
			},
		},
		{
			name: "VMStateResult",
			val: VMStateResult{
				VMName: "TestVM",
				State:  "start",
				Status: "completed",
			},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			data, err := json.Marshal(tc.val)
			if err != nil {
				t.Fatalf("failed to marshal %s: %v", tc.name, err)
			}
			if len(data) == 0 {
				t.Fatalf("marshalled %s to empty bytes", tc.name)
			}
		})
	}
}

func TestEmptyVHDPaths(t *testing.T) {
	vm := HyperVVM{
		Name:    "EmptyVM",
		VHDPaths: nil,
	}
	data, err := json.Marshal(vm)
	if err != nil {
		t.Fatalf("failed to marshal VM with nil VHDPaths: %v", err)
	}
	// Ensure nil serializes as null, not as an error
	if len(data) == 0 {
		t.Fatal("empty marshalled output")
	}
}
