//go:build windows

// Package hyperv provides Hyper-V VM backup, restore, and checkpoint management.
// All operations are Windows-only; non-Windows platforms receive stubs.
package hyperv

import "errors"

// Sentinel errors returned by the hyperv package.
var (
	ErrHyperVNotSupported = errors.New("hyperv: not supported on this platform")
	ErrVMNotFound         = errors.New("hyperv: VM not found")
	ErrExportFailed       = errors.New("hyperv: export operation failed")
	ErrImportFailed       = errors.New("hyperv: import operation failed")
	ErrCheckpointFailed   = errors.New("hyperv: checkpoint operation failed")
	ErrPowerShellFailed   = errors.New("hyperv: powershell command failed")
)

// HyperVVM describes a discovered Hyper-V virtual machine.
type HyperVVM struct {
	ID             string       `json:"id"`              // Hyper-V GUID
	Name           string       `json:"name"`
	State          string       `json:"state"`           // Running, Off, Saved, Paused
	Generation     int          `json:"generation"`      // 1 or 2
	MemoryMB       int64        `json:"memoryMb"`
	ProcessorCount int          `json:"processorCount"`
	VHDPaths       []VHDInfo    `json:"vhdPaths"`
	RCTEnabled     bool         `json:"rctEnabled"`
	HasPassthrough bool         `json:"hasPassthrough"`
	Checkpoints    []Checkpoint `json:"checkpoints"`
	Notes          string       `json:"notes,omitempty"`
}

// VHDInfo describes a virtual hard disk attached to a VM.
type VHDInfo struct {
	Path   string `json:"path"`
	SizeGB int64  `json:"sizeGb"`
	Type   string `json:"type"` // vhdx, vhd
}

// Checkpoint describes a VM checkpoint (snapshot).
type Checkpoint struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt string `json:"createdAt"`
	ParentID  string `json:"parentId,omitempty"`
}

// BackupResult holds the outcome of a Hyper-V VM export.
type BackupResult struct {
	VMName          string `json:"vmName"`
	VMID            string `json:"vmId"`
	BackupType      string `json:"backupType"`      // full, incremental
	ConsistencyType string `json:"consistencyType"` // application, crash
	ExportPath      string `json:"exportPath"`
	SizeBytes       int64  `json:"sizeBytes"`
	VHDCount        int    `json:"vhdCount"`
	DurationMs      int64  `json:"durationMs"`
	RCTReference    string `json:"rctReference,omitempty"`
}

// RestoreResult holds the outcome of a Hyper-V VM import.
type RestoreResult struct {
	VMName     string `json:"vmName"`
	NewVMID    string `json:"newVmId"`
	Status     string `json:"status"` // completed, failed
	DurationMs int64  `json:"durationMs"`
	Error      string `json:"error,omitempty"`
}

// CheckpointResult holds the outcome of a checkpoint management operation.
type CheckpointResult struct {
	Action       string `json:"action"` // create, delete, apply
	CheckpointID string `json:"checkpointId"`
	VMName       string `json:"vmName"`
	Status       string `json:"status"`
	Error        string `json:"error,omitempty"`
}

// VMStateResult holds the outcome of a VM state change.
type VMStateResult struct {
	VMName string `json:"vmName"`
	State  string `json:"state"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}
