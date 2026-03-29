//go:build windows

package hyperv

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// VMRestoreFromBackupConfig configures a VM restore from a backup snapshot.
type VMRestoreFromBackupConfig struct {
	SnapshotID string `json:"snapshotId"`
	VMName     string `json:"vmName"`
	MemoryMB   int64  `json:"memoryMb,omitempty"`
	CPUCount   int    `json:"cpuCount,omitempty"`
	DiskSizeGB int64  `json:"diskSizeGb,omitempty"`
	SwitchName string `json:"switchName,omitempty"`
}

// VMRestoreFromBackupResult holds the outcome of a VM restore from backup.
type VMRestoreFromBackupResult struct {
	VMName     string   `json:"vmName"`
	NewVMID    string   `json:"newVmId"`
	VHDXPath   string   `json:"vhdxPath"`
	Status     string   `json:"status"` // completed, failed
	DurationMs int64    `json:"durationMs"`
	Warnings   []string `json:"warnings,omitempty"`
	Error      string   `json:"error,omitempty"`
}

// vmRestoreManifest matches the snapshot manifest shape for deserialization.
type vmRestoreManifest struct {
	ID    string               `json:"id"`
	Files []vmRestoreManifFile `json:"files"`
	Size  int64                `json:"size"`
}

type vmRestoreManifFile struct {
	SourcePath string `json:"sourcePath"`
	BackupPath string `json:"backupPath"`
	Size       int64  `json:"size"`
}

// RestoreAsVM creates a new Hyper-V Generation 2 VM from a backup snapshot.
//
// Steps:
//  1. Download snapshot manifest
//  2. Create a dynamic VHDX
//  3. Mount, partition (GPT), and format (NTFS)
//  4. Restore snapshot files to the mounted volume
//  5. Inject Hyper-V enlightenment drivers
//  6. Dismount the VHDX
//  7. Create and configure the VM
func RestoreAsVM(
	ctx context.Context,
	cfg VMRestoreFromBackupConfig,
	provider providers.BackupProvider,
	progressFn func(string, int64, int64),
) (*VMRestoreFromBackupResult, error) {
	start := time.Now()
	result := &VMRestoreFromBackupResult{
		VMName: cfg.VMName,
		Status: "failed",
	}

	if cfg.VMName == "" {
		return result, fmt.Errorf("vmrestore: vmName is required")
	}
	if cfg.SnapshotID == "" {
		return result, fmt.Errorf("vmrestore: snapshotId is required")
	}
	if provider == nil {
		return result, fmt.Errorf("vmrestore: backup provider is required")
	}

	// Apply defaults.
	memoryMB := cfg.MemoryMB
	if memoryMB <= 0 {
		memoryMB = 4096
	}
	cpuCount := cfg.CPUCount
	if cpuCount <= 0 {
		cpuCount = 2
	}
	diskSizeGB := cfg.DiskSizeGB
	if diskSizeGB <= 0 {
		diskSizeGB = 60
	}

	progress := func(phase string, step, total int64) {
		if progressFn != nil {
			progressFn(phase, step, total)
		}
	}

	// 1. Download manifest.
	progress("downloading_manifest", 1, 7)
	slog.Info("vmrestore: downloading snapshot manifest", "snapshotId", cfg.SnapshotID)

	manifest, err := downloadVMRestoreManifest(cfg.SnapshotID, provider)
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: download manifest: %w", err)
	}
	slog.Info("vmrestore: manifest downloaded", "files", len(manifest.Files))

	// 2. Create work directory and VHDX.
	progress("creating_vhdx", 2, 7)
	workDir, err := os.MkdirTemp("", "breeze-vmrestore-*")
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: create work dir: %w", err)
	}
	defer func() {
		if result.Status != "completed" {
			os.RemoveAll(workDir)
		}
	}()

	vhdxPath := filepath.Join(workDir, cfg.VMName+".vhdx")
	result.VHDXPath = vhdxPath
	sizeBytes := diskSizeGB * 1024 * 1024 * 1024

	slog.Info("vmrestore: creating VHDX", "path", vhdxPath, "sizeGB", diskSizeGB)
	createCmd := fmt.Sprintf(
		`New-VHD -Path '%s' -SizeBytes %d -Dynamic`,
		escapePSString(vhdxPath), sizeBytes,
	)
	if _, err := runPS(createCmd); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: create VHDX: %w", err)
	}

	// 3. Mount VHDX, initialize disk, partition, and format.
	progress("mounting_vhdx", 3, 7)
	slog.Info("vmrestore: mounting and partitioning VHDX")

	driveLetter, err := mountAndPartitionVHDX(vhdxPath)
	if err != nil {
		result.Error = err.Error()
		dismountVHDX(vhdxPath)
		return result, fmt.Errorf("vmrestore: mount/partition: %w", err)
	}

	targetRoot := driveLetter + `:\`
	slog.Info("vmrestore: VHDX mounted", "drive", targetRoot)

	// 4. Restore snapshot files to the mounted volume.
	progress("restoring_files", 4, 7)
	slog.Info("vmrestore: restoring files to volume", "target", targetRoot, "files", len(manifest.Files))

	restoreWarnings := restoreFilesToVolume(manifest, provider, targetRoot)
	result.Warnings = append(result.Warnings, restoreWarnings...)

	// 5. Inject Hyper-V enlightenment drivers.
	progress("injecting_drivers", 5, 7)
	slog.Info("vmrestore: injecting Hyper-V drivers")

	if driverErr := injectHyperVDrivers(targetRoot); driverErr != nil {
		warnMsg := fmt.Sprintf("driver injection failed: %s", driverErr.Error())
		slog.Warn("vmrestore: " + warnMsg)
		result.Warnings = append(result.Warnings, warnMsg)
	}

	// 6. Dismount VHDX.
	progress("dismounting_vhdx", 6, 7)
	slog.Info("vmrestore: dismounting VHDX")

	if err := dismountVHDX(vhdxPath); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: dismount VHDX: %w", err)
	}

	// 7. Create and configure the VM.
	progress("creating_vm", 7, 7)
	slog.Info("vmrestore: creating VM", "name", cfg.VMName, "memoryMB", memoryMB, "cpus", cpuCount)

	if err := createAndConfigureVM(cfg.VMName, vhdxPath, memoryMB, cpuCount, cfg.SwitchName); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: create VM: %w", err)
	}

	// Retrieve the new VM ID.
	newVMID := getVMID(cfg.VMName)
	result.NewVMID = newVMID
	result.Status = "completed"
	result.DurationMs = time.Since(start).Milliseconds()

	slog.Info("vmrestore: VM restore completed",
		"vmName", cfg.VMName,
		"vmId", newVMID,
		"durationMs", result.DurationMs,
	)

	return result, nil
}

// downloadVMRestoreManifest fetches and parses a snapshot manifest from the provider.
func downloadVMRestoreManifest(snapshotID string, provider providers.BackupProvider) (*vmRestoreManifest, error) {
	manifestKey := path.Join("snapshots", snapshotID, "manifest.json")

	tmpFile, err := os.CreateTemp("", "vmrestore-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("create temp: %w", err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer os.Remove(tmpPath)

	if err := provider.Download(manifestKey, tmpPath); err != nil {
		return nil, fmt.Errorf("download manifest: %w", err)
	}

	data, err := os.ReadFile(tmpPath)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}

	var manifest vmRestoreManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil, fmt.Errorf("decode manifest: %w", err)
	}
	return &manifest, nil
}

// mountAndPartitionVHDX mounts a VHDX, initializes the disk as GPT, creates a
// max-size partition, formats it as NTFS, and returns the assigned drive letter.
func mountAndPartitionVHDX(vhdxPath string) (string, error) {
	psScript := fmt.Sprintf(`
$ErrorActionPreference = 'Stop'
$disk = Mount-VHD -Path '%s' -PassThru | Get-Disk
Initialize-Disk -Number $disk.Number -PartitionStyle GPT
$part = New-Partition -DiskNumber $disk.Number -UseMaximumSize -AssignDriveLetter
Format-Volume -Partition $part -FileSystem NTFS -NewFileSystemLabel 'BreezeRestore' -Confirm:$false | Out-Null
$part.DriveLetter
`, escapePSString(vhdxPath))

	out, err := runPS(psScript)
	if err != nil {
		return "", fmt.Errorf("mount/partition: %w", err)
	}

	driveLetter := strings.TrimSpace(out)
	if len(driveLetter) == 0 {
		return "", fmt.Errorf("no drive letter assigned after partitioning")
	}
	// Take only the last line (the drive letter) in case of extra output.
	lines := strings.Split(driveLetter, "\n")
	driveLetter = strings.TrimSpace(lines[len(lines)-1])
	if len(driveLetter) != 1 {
		return "", fmt.Errorf("unexpected drive letter: %q", driveLetter)
	}

	return driveLetter, nil
}

// dismountVHDX safely dismounts a VHDX.
func dismountVHDX(vhdxPath string) error {
	cmd := fmt.Sprintf(`Dismount-VHD -Path '%s'`, escapePSString(vhdxPath))
	if _, err := runPS(cmd); err != nil {
		return fmt.Errorf("dismount VHDX: %w", err)
	}
	return nil
}

// restoreFilesToVolume downloads each file from the manifest and writes it to
// the target volume.
func restoreFilesToVolume(
	manifest *vmRestoreManifest,
	provider providers.BackupProvider,
	targetRoot string,
) []string {
	var warnings []string

	for _, file := range manifest.Files {
		targetPath := filepath.Join(targetRoot, filepath.FromSlash(file.SourcePath))

		dir := filepath.Dir(targetPath)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			warnings = append(warnings, fmt.Sprintf("mkdir failed for %s: %s", dir, err.Error()))
			continue
		}

		if err := provider.Download(file.BackupPath, targetPath); err != nil {
			warnings = append(warnings, fmt.Sprintf("restore failed for %s: %s", file.SourcePath, err.Error()))
			continue
		}
	}

	return warnings
}

// injectHyperVDrivers uses DISM to add Hyper-V enlightenment drivers to a
// mounted Windows image volume. This ensures the restored OS can boot on Hyper-V.
func injectHyperVDrivers(targetRoot string) error {
	// Hyper-V enlightenment drivers are typically at:
	// C:\Windows\System32\drivers\vmbus.sys (and others in DriverStore)
	// Use DISM /Add-Driver with the driver store for the most reliable injection.
	drivers := []string{
		`C:\Windows\System32\drivers\vmbus.sys`,
		`C:\Windows\System32\drivers\storvsc.sys`,
		`C:\Windows\System32\drivers\netvsc.sys`,
	}

	var lastErr error
	injected := 0
	for _, drv := range drivers {
		if _, statErr := os.Stat(drv); statErr != nil {
			continue // driver not found on host, skip
		}
		drvDir := filepath.Dir(drv)
		cmd := fmt.Sprintf(
			`dism /Image:%s /Add-Driver /Driver:%s /ForceUnsigned`,
			escapePSString(strings.TrimSuffix(targetRoot, `\`)),
			escapePSString(drvDir),
		)
		if _, err := runPS(cmd); err != nil {
			lastErr = err
			continue
		}
		injected++
	}

	if injected == 0 && lastErr != nil {
		return fmt.Errorf("no drivers injected: %w", lastErr)
	}
	return nil
}

// createAndConfigureVM creates a Generation 2 Hyper-V VM and configures it
// with the specified resources.
func createAndConfigureVM(vmName, vhdxPath string, memoryMB int64, cpuCount int, switchName string) error {
	vmNameEsc := escapePSString(vmName)
	vhdxPathEsc := escapePSString(vhdxPath)
	memBytes := memoryMB * 1024 * 1024

	// Create VM.
	createCmd := fmt.Sprintf(
		`New-VM -Name '%s' -Generation 2 -MemoryStartupBytes %d -VHDPath '%s'`,
		vmNameEsc, memBytes, vhdxPathEsc,
	)
	if _, err := runPS(createCmd); err != nil {
		return fmt.Errorf("New-VM: %w", err)
	}

	// Set CPU count.
	cpuCmd := fmt.Sprintf(`Set-VM -Name '%s' -ProcessorCount %d`, vmNameEsc, cpuCount)
	if _, err := runPS(cpuCmd); err != nil {
		slog.Warn("vmrestore: failed to set CPU count", "error", err.Error())
	}

	// Connect network adapter to specified or default switch.
	if switchName != "" {
		netCmd := fmt.Sprintf(
			`Connect-VMNetworkAdapter -VMName '%s' -SwitchName '%s'`,
			vmNameEsc, escapePSString(switchName),
		)
		if _, err := runPS(netCmd); err != nil {
			slog.Warn("vmrestore: failed to connect specified switch",
				"switch", switchName, "error", err.Error())
		}
	} else {
		// Try to find a default switch.
		defaultSwitchCmd := `Get-VMSwitch | Select-Object -First 1 -ExpandProperty Name`
		out, err := runPS(defaultSwitchCmd)
		if err == nil {
			defSwitch := strings.TrimSpace(out)
			if defSwitch != "" {
				netCmd := fmt.Sprintf(
					`Connect-VMNetworkAdapter -VMName '%s' -SwitchName '%s'`,
					vmNameEsc, escapePSString(defSwitch),
				)
				if _, err := runPS(netCmd); err != nil {
					slog.Warn("vmrestore: failed to connect default switch",
						"switch", defSwitch, "error", err.Error())
				}
			}
		}
	}

	return nil
}
