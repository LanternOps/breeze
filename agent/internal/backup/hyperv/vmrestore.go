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

	// Refuse an existing VM name and create the per-restore directory under
	// the host's default VM path before anything is downloaded. The restored
	// VM's disk and configuration live there, never under a temp directory.
	dirName, err := newRestoreDirName(cfg.VMName)
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: %w", err)
	}
	restoreDir, err := prepareVMRestoreWith(runPS, cfg.VMName, "", dirName)
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: prepare restore: %w", err)
	}
	result.RestorePath = restoreDir
	defer func() {
		if result.Status != "completed" {
			if rmErr := os.RemoveAll(restoreDir); rmErr != nil {
				slog.Warn("vmrestore: failed to clean up restore directory", "dir", restoreDir, "error", rmErr.Error())
			}
		}
	}()

	// 1. Download manifest.
	progress("downloading_manifest", 1, 7)
	slog.Info("vmrestore: downloading snapshot manifest", "snapshotId", cfg.SnapshotID)

	manifest, err := downloadVMRestoreManifest(cfg.SnapshotID, provider)
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: download manifest: %w", err)
	}
	slog.Info("vmrestore: manifest downloaded", "files", len(manifest.Files))

	// 2. Create the VHDX inside the restore directory.
	progress("creating_vhdx", 2, 7)
	vhdDir := filepath.Join(restoreDir, "Virtual Hard Disks")
	if err := os.MkdirAll(vhdDir, 0o750); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: create disk dir: %w", err)
	}

	vhdxPath := filepath.Join(vhdDir, safeFileStem(cfg.VMName)+".vhdx")
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
	if ctx.Err() != nil {
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		return result, ctx.Err()
	}
	slog.Info("vmrestore: mounting and partitioning VHDX")

	driveLetter, err := mountAndPartitionVHDX(vhdxPath)
	if err != nil {
		result.Error = err.Error()
		dismountVHDX(vhdxPath)
		return result, fmt.Errorf("vmrestore: mount/partition: %w", err)
	}
	// Ensure dismount on any failure after this point.
	dismounted := false
	defer func() {
		if !dismounted {
			slog.Warn("vmrestore: cleaning up mounted VHDX due to failure")
			dismountVHDX(vhdxPath)
		}
	}()

	targetRoot := driveLetter + `:\`
	slog.Info("vmrestore: VHDX mounted", "drive", targetRoot)

	// 4. Restore snapshot files to the mounted volume.
	progress("restoring_files", 4, 7)
	if ctx.Err() != nil {
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		return result, ctx.Err()
	}
	slog.Info("vmrestore: restoring files to volume", "target", targetRoot, "files", len(manifest.Files))

	tally := restoreManifestFiles(ctx, manifest.Files, provider, targetRoot)
	result.FilesRestored = tally.Restored
	result.FilesFailed = tally.Failed
	result.BytesRestored = tally.Bytes
	result.FailedFiles = tally.FailedFiles
	result.Warnings = append(result.Warnings, tally.Warnings...)
	if err := tally.err(); err != nil {
		// No VM is created from a disk that is missing files; the deferred
		// cleanup dismounts the disk and removes the restore directory.
		result.Error = err.Error()
		slog.Warn("vmrestore: file restore failed", "restored", tally.Restored, "failed", tally.Failed, "total", tally.Total)
		return result, fmt.Errorf("vmrestore: %w", err)
	}
	slog.Info("vmrestore: files restored", "restored", tally.Restored, "bytes", tally.Bytes)

	// 5. Inject Hyper-V enlightenment drivers.
	progress("injecting_drivers", 5, 7)
	if ctx.Err() != nil {
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		return result, ctx.Err()
	}
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
	dismounted = true

	// 7. Create and configure the VM.
	progress("creating_vm", 7, 7)
	if ctx.Err() != nil {
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		return result, ctx.Err()
	}
	slog.Info("vmrestore: creating VM", "name", cfg.VMName, "memoryMB", memoryMB, "cpus", cpuCount)

	newVMID, err := createAndConfigureVM(cfg.VMName, vhdxPath, restoreDir, memoryMB, cpuCount, cfg.SwitchName)
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("vmrestore: create VM: %w", err)
	}
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

// vmRestoreManifest matches the snapshot manifest shape for deserialization.
type vmRestoreManifest struct {
	ID    string               `json:"id"`
	Files []vmRestoreManifFile `json:"files"`
	Size  int64                `json:"size"`
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
// with the specified resources. It refuses a name that already exists and
// returns the new VM's ID; all configuration is applied by that ID.
func createAndConfigureVM(vmName, vhdxPath, vmPath string, memoryMB int64, cpuCount int, switchName string) (string, error) {
	return createAndConfigureVMWith(runPS, vmName, vhdxPath, vmPath, memoryMB, cpuCount, switchName)
}
