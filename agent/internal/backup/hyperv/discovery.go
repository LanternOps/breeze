//go:build windows

package hyperv

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"strings"
)

// psVMPayload is the JSON shape returned by Get-VM | ConvertTo-Json.
type psVMPayload struct {
	Name            string `json:"Name"`
	Id              string `json:"Id"`
	State           int    `json:"State"`
	Generation      int    `json:"Generation"`
	MemoryAssigned  int64  `json:"MemoryAssigned"`
	ProcessorCount  int    `json:"ProcessorCount"`
	Notes           string `json:"Notes"`
	ReplicationMode int    `json:"ReplicationMode"`
}

// psVHDPayload is the JSON shape returned by Get-VMHardDiskDrive.
type psVHDPayload struct {
	Path string `json:"Path"`
}

// psCheckpointPayload is the JSON shape returned by Get-VMSnapshot.
type psCheckpointPayload struct {
	Id                string `json:"Id"`
	Name              string `json:"Name"`
	CreationTime      string `json:"CreationTime"`
	ParentSnapshotId  string `json:"ParentSnapshotId"`
}

// DiscoverVMs enumerates all Hyper-V VMs on the local host.
func DiscoverVMs() ([]HyperVVM, error) {
	psCmd := `Get-VM | Select-Object Name,Id,State,Generation,MemoryAssigned,ProcessorCount,Notes,ReplicationMode | ConvertTo-Json -Compress`
	out, err := runPS(psCmd)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPowerShellFailed, err)
	}

	if strings.TrimSpace(out) == "" {
		return []HyperVVM{}, nil
	}

	var raw json.RawMessage
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		return nil, fmt.Errorf("failed to parse Get-VM output: %w", err)
	}

	// PowerShell returns a single object (not array) when there is exactly one VM.
	var payloads []psVMPayload
	if err := json.Unmarshal(raw, &payloads); err != nil {
		var single psVMPayload
		if err2 := json.Unmarshal(raw, &single); err2 != nil {
			return nil, fmt.Errorf("failed to parse VM list: %w", err)
		}
		payloads = []psVMPayload{single}
	}

	vms := make([]HyperVVM, 0, len(payloads))
	for _, p := range payloads {
		vm := HyperVVM{
			ID:             p.Id,
			Name:           p.Name,
			State:          vmStateString(p.State),
			Generation:     p.Generation,
			MemoryMB:       p.MemoryAssigned / (1024 * 1024),
			ProcessorCount: p.ProcessorCount,
			Notes:          p.Notes,
			RCTEnabled:     p.ReplicationMode != 0,
		}

		vhds, hasPassthrough := discoverVHDs(p.Name)
		vm.VHDPaths = vhds
		vm.HasPassthrough = hasPassthrough

		checkpoints := discoverCheckpoints(p.Name)
		vm.Checkpoints = checkpoints

		vms = append(vms, vm)
	}

	slog.Info("hyperv: discovered VMs", "count", len(vms))
	return vms, nil
}

// discoverVHDs retrieves VHD info for a given VM.
func discoverVHDs(vmName string) ([]VHDInfo, bool) {
	psCmd := fmt.Sprintf(`Get-VMHardDiskDrive -VMName '%s' | Select-Object Path | ConvertTo-Json -Compress`, escapePSString(vmName))
	out, err := runPS(psCmd)
	if err != nil {
		slog.Warn("hyperv: failed to get VHD info", "vm", vmName, "error", err.Error())
		return nil, false
	}

	if strings.TrimSpace(out) == "" {
		return nil, false
	}

	var rawVHDs json.RawMessage
	if err := json.Unmarshal([]byte(out), &rawVHDs); err != nil {
		slog.Warn("hyperv: failed to parse VHD JSON", "vm", vmName, "error", err.Error())
		return nil, false
	}

	var vhdPayloads []psVHDPayload
	if err := json.Unmarshal(rawVHDs, &vhdPayloads); err != nil {
		var single psVHDPayload
		if err2 := json.Unmarshal(rawVHDs, &single); err2 != nil {
			slog.Warn("hyperv: failed to parse VHD info", "vm", vmName, "error", err2.Error())
			return nil, false
		}
		vhdPayloads = []psVHDPayload{single}
	}

	hasPassthrough := false
	vhds := make([]VHDInfo, 0, len(vhdPayloads))
	for _, v := range vhdPayloads {
		if v.Path == "" {
			hasPassthrough = true
			continue
		}
		ext := strings.ToLower(filepath.Ext(v.Path))
		vhdType := "vhdx"
		if ext == ".vhd" {
			vhdType = "vhd"
		}
		vhds = append(vhds, VHDInfo{
			Path:   v.Path,
			SizeGB: 0, // Size computed during backup
			Type:   vhdType,
		})
	}

	return vhds, hasPassthrough
}

// discoverCheckpoints retrieves checkpoint info for a given VM.
func discoverCheckpoints(vmName string) []Checkpoint {
	psCmd := fmt.Sprintf(`Get-VMSnapshot -VMName '%s' | Select-Object Id,Name,CreationTime,ParentSnapshotId | ConvertTo-Json -Compress`, escapePSString(vmName))
	out, err := runPS(psCmd)
	if err != nil || strings.TrimSpace(out) == "" {
		return nil
	}

	var rawCPs json.RawMessage
	if err := json.Unmarshal([]byte(out), &rawCPs); err != nil {
		slog.Warn("hyperv: failed to parse checkpoint JSON", "vm", vmName, "error", err.Error())
		return nil
	}

	var cpPayloads []psCheckpointPayload
	if err := json.Unmarshal(rawCPs, &cpPayloads); err != nil {
		var single psCheckpointPayload
		if err2 := json.Unmarshal(rawCPs, &single); err2 != nil {
			slog.Warn("hyperv: failed to parse checkpoint info", "vm", vmName, "error", err2.Error())
			return nil
		}
		cpPayloads = []psCheckpointPayload{single}
	}

	cps := make([]Checkpoint, 0, len(cpPayloads))
	for _, cp := range cpPayloads {
		cps = append(cps, Checkpoint{
			ID:        cp.Id,
			Name:      cp.Name,
			CreatedAt: cp.CreationTime,
			ParentID:  cp.ParentSnapshotId,
		})
	}

	return cps
}

// vmStateString converts the Hyper-V VM state enum to a string.
func vmStateString(state int) string {
	switch state {
	case 2:
		return "Running"
	case 3:
		return "Off"
	case 6:
		return "Saved"
	case 9:
		return "Paused"
	default:
		return fmt.Sprintf("Unknown(%d)", state)
	}
}

// runPS executes a PowerShell command and returns stdout.
func runPS(command string) (string, error) {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("powershell failed: %w: %s", err, string(out))
	}
	return string(out), nil
}

// escapePSString escapes single quotes for PowerShell string literals.
func escapePSString(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}
