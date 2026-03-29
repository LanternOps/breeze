//go:build windows

package hyperv

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// InstantBootConfig configures an instant boot VM from a backup snapshot.
type InstantBootConfig struct {
	SnapshotID string `json:"snapshotId"`
	VMName     string `json:"vmName"`
	MemoryMB   int64  `json:"memoryMb,omitempty"`
	CPUCount   int    `json:"cpuCount,omitempty"`
	DiskSizeGB int64  `json:"diskSizeGb,omitempty"`
	WorkDir    string `json:"workDir,omitempty"`
}

// InstantBootResult holds the outcome of an instant boot operation.
type InstantBootResult struct {
	VMName               string `json:"vmName"`
	NewVMID              string `json:"newVmId"`
	Status               string `json:"status"` // completed, failed
	BootTimeMs           int64  `json:"bootTimeMs"`
	BackgroundSyncActive bool   `json:"backgroundSyncActive"`
	Error                string `json:"error,omitempty"`
}

// bootCriticalPatterns lists path patterns that must be present for a
// Windows VM to boot. Files matching these prefixes are downloaded first
// during instant boot.
var bootCriticalPatterns = []string{
	"Windows/System32/config/",
	"Windows/System32/ntoskrnl.exe",
	"Windows/System32/hal.dll",
	"Windows/System32/ci.dll",
	"Windows/System32/drivers/",
	"Windows/System32/winload",
	"Windows/System32/ntdll.dll",
	"Windows/System32/kernel32.dll",
	"Windows/System32/advapi32.dll",
	"boot/",
	"Boot/",
	"EFI/",
}

// InstantBoot performs a fast selective restore: it downloads only the
// boot-critical files from a backup snapshot, creates a VM with a
// differencing VHDX, starts it, and then schedules background sync
// for the remaining files.
//
// The approach:
//  1. Download manifest
//  2. Create base VHDX with boot-critical files only
//  3. Create differencing VHDX on top
//  4. Create and start the VM pointing at the differencing disk
//  5. Schedule background download of remaining files
func InstantBoot(
	ctx context.Context,
	cfg InstantBootConfig,
	provider providers.BackupProvider,
	progressFn func(string, int64, int64),
) (*InstantBootResult, error) {
	start := time.Now()
	result := &InstantBootResult{
		VMName: cfg.VMName,
		Status: "failed",
	}

	if cfg.VMName == "" {
		return result, fmt.Errorf("instantboot: vmName is required")
	}
	if cfg.SnapshotID == "" {
		return result, fmt.Errorf("instantboot: snapshotId is required")
	}
	if provider == nil {
		return result, fmt.Errorf("instantboot: backup provider is required")
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
	progress("downloading_manifest", 1, 8)
	slog.Info("instantboot: downloading snapshot manifest", "snapshotId", cfg.SnapshotID)

	manifest, err := downloadVMRestoreManifest(cfg.SnapshotID, provider)
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: download manifest: %w", err)
	}

	// 2. Classify files into boot-critical and remaining.
	bootFiles, remainingFiles := classifyFiles(manifest.Files)
	slog.Info("instantboot: file classification",
		"bootCritical", len(bootFiles),
		"remaining", len(remainingFiles),
		"total", len(manifest.Files),
	)

	// 3. Create work directory.
	progress("creating_vhdx", 2, 8)
	workDir := cfg.WorkDir
	if workDir == "" {
		workDir, err = os.MkdirTemp("", "breeze-instantboot-*")
		if err != nil {
			result.Error = err.Error()
			return result, fmt.Errorf("instantboot: create work dir: %w", err)
		}
	}

	// 4. Create base VHDX.
	baseVHDX := filepath.Join(workDir, cfg.VMName+"-base.vhdx")
	sizeBytes := diskSizeGB * 1024 * 1024 * 1024

	slog.Info("instantboot: creating base VHDX", "path", baseVHDX, "sizeGB", diskSizeGB)
	createCmd := fmt.Sprintf(
		`New-VHD -Path '%s' -SizeBytes %d -Dynamic`,
		escapePSString(baseVHDX), sizeBytes,
	)
	if _, err := runPS(createCmd); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: create VHDX: %w", err)
	}

	// 5. Mount base VHDX and partition.
	progress("mounting_vhdx", 3, 8)
	if ctx.Err() != nil {
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		return result, ctx.Err()
	}
	slog.Info("instantboot: mounting and partitioning base VHDX")

	driveLetter, err := mountAndPartitionVHDX(baseVHDX)
	if err != nil {
		result.Error = err.Error()
		dismountVHDX(baseVHDX)
		return result, fmt.Errorf("instantboot: mount/partition: %w", err)
	}
	targetRoot := driveLetter + `:\`

	// 6. Download ONLY boot-critical files.
	progress("restoring_boot_files", 4, 8)
	if ctx.Err() != nil {
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		dismountVHDX(baseVHDX)
		return result, ctx.Err()
	}
	slog.Info("instantboot: restoring boot-critical files", "count", len(bootFiles))

	var criticalFailures []string
	for _, file := range bootFiles {
		targetPath := filepath.Join(targetRoot, filepath.FromSlash(file.SourcePath))
		dir := filepath.Dir(targetPath)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			slog.Warn("instantboot: mkdir failed", "dir", dir, "error", err.Error())
			criticalFailures = append(criticalFailures, file.SourcePath)
			continue
		}
		if err := provider.Download(file.BackupPath, targetPath); err != nil {
			slog.Warn("instantboot: download failed", "file", file.SourcePath, "error", err.Error())
			criticalFailures = append(criticalFailures, file.SourcePath)
		}
	}
	if len(criticalFailures) > 0 {
		dismountVHDX(baseVHDX)
		result.Status = "degraded"
		result.Error = fmt.Sprintf("failed to download %d boot-critical files: %v", len(criticalFailures), criticalFailures)
		return result, nil
	}

	// 7. Create boot configuration.
	progress("configuring_boot", 5, 8)
	if ctx.Err() != nil {
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		dismountVHDX(baseVHDX)
		return result, ctx.Err()
	}
	slog.Info("instantboot: configuring boot loader")

	if bootErr := configureBootLoader(driveLetter); bootErr != nil {
		slog.Warn("instantboot: boot config failed, VM may not boot automatically",
			"error", bootErr.Error())
	}

	// 8. Dismount base VHDX.
	progress("dismounting_vhdx", 6, 8)
	if err := dismountVHDX(baseVHDX); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: dismount base VHDX: %w", err)
	}

	// 9. Create differencing VHDX.
	progress("creating_diff_vhdx", 7, 8)
	if ctx.Err() != nil {
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		return result, ctx.Err()
	}
	diffVHDX := filepath.Join(workDir, cfg.VMName+"-diff.vhdx")
	slog.Info("instantboot: creating differencing VHDX", "diff", diffVHDX, "parent", baseVHDX)

	diffCmd := fmt.Sprintf(
		`New-VHD -Path '%s' -ParentPath '%s' -Differencing`,
		escapePSString(diffVHDX), escapePSString(baseVHDX),
	)
	if _, err := runPS(diffCmd); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: create diff VHDX: %w", err)
	}

	// 10. Create and start VM with the differencing disk.
	progress("creating_vm", 8, 8)
	if ctx.Err() != nil {
		result.Error = fmt.Sprintf("operation cancelled: %v", ctx.Err())
		return result, ctx.Err()
	}
	slog.Info("instantboot: creating and starting VM")

	if err := createAndConfigureVM(cfg.VMName, diffVHDX, memoryMB, cpuCount, ""); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: create VM: %w", err)
	}

	// Start the VM.
	startCmd := fmt.Sprintf(`Start-VM -Name '%s'`, escapePSString(cfg.VMName))
	if _, err := runPS(startCmd); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: start VM: %w", err)
	}

	bootTime := time.Since(start).Milliseconds()
	result.BootTimeMs = bootTime
	result.NewVMID = getVMID(cfg.VMName)
	result.Status = "completed"

	// 11. Launch background goroutine for remaining files.
	if len(remainingFiles) > 0 {
		result.BackgroundSyncActive = true
		go func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("instantboot: background sync panicked", "error", fmt.Sprintf("%v", r))
				}
			}()
			backgroundSync(cfg.VMName, baseVHDX, diffVHDX, remainingFiles, provider)
		}()
	}

	slog.Info("instantboot: VM booted",
		"vmName", cfg.VMName,
		"vmId", result.NewVMID,
		"bootTimeMs", bootTime,
		"remainingFiles", len(remainingFiles),
	)

	return result, nil
}

// classifyFiles separates manifest files into boot-critical and remaining.
func classifyFiles(files []vmRestoreManifFile) (bootCritical, remaining []vmRestoreManifFile) {
	for _, f := range files {
		if isBootCritical(f.SourcePath) {
			bootCritical = append(bootCritical, f)
		} else {
			remaining = append(remaining, f)
		}
	}
	return bootCritical, remaining
}

// isBootCritical returns true if the file path matches a boot-critical pattern.
func isBootCritical(sourcePath string) bool {
	// Normalize to forward slashes for matching.
	normalized := strings.ReplaceAll(sourcePath, `\`, "/")
	for _, pattern := range bootCriticalPatterns {
		if strings.Contains(normalized, pattern) {
			return true
		}
	}
	return false
}

// configureBootLoader runs bcdboot to set up the Windows boot loader on
// the mounted volume.
func configureBootLoader(driveLetter string) error {
	winDir := driveLetter + `:\Windows`
	if _, err := os.Stat(winDir); err != nil {
		return fmt.Errorf("Windows directory not found on %s: %w", driveLetter, err)
	}

	// bcdboot populates the EFI System Partition boot files.
	cmd := fmt.Sprintf(
		`bcdboot %s:\Windows /s %s: /f UEFI`,
		driveLetter, driveLetter,
	)
	if _, err := runPS(cmd); err != nil {
		return fmt.Errorf("bcdboot: %w", err)
	}
	return nil
}

// backgroundSync downloads remaining (non-boot-critical) files after the VM
// has booted. It writes files to a sync staging directory alongside the base
// VHDX. A merge into the base can be done later when the VM is stopped.
func backgroundSync(
	vmName, baseVHDX, diffVHDX string,
	files []vmRestoreManifFile,
	provider providers.BackupProvider,
) {
	syncDir := filepath.Join(filepath.Dir(baseVHDX), "sync-staging")
	if err := os.MkdirAll(syncDir, 0o755); err != nil {
		slog.Error("instantboot: failed to create sync staging dir",
			"dir", syncDir, "error", err.Error())
		return
	}

	slog.Info("instantboot: background sync started",
		"vmName", vmName,
		"files", len(files),
		"syncDir", syncDir,
	)

	synced := 0
	failed := 0
	for _, file := range files {
		targetPath := filepath.Join(syncDir, filepath.FromSlash(file.SourcePath))
		dir := filepath.Dir(targetPath)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			slog.Warn("instantboot: sync mkdir failed", "dir", dir, "error", err.Error())
			failed++
			continue
		}
		if err := provider.Download(file.BackupPath, targetPath); err != nil {
			slog.Warn("instantboot: sync download failed",
				"file", file.SourcePath, "error", err.Error())
			failed++
			continue
		}
		synced++
	}

	slog.Info("instantboot: background sync completed",
		"vmName", vmName,
		"synced", synced,
		"failed", failed,
		"syncDir", syncDir,
	)

	// Write a manifest of synced files for later merge.
	manifestPath := filepath.Join(syncDir, "sync-manifest.txt")
	var sb strings.Builder
	for _, file := range files {
		sb.WriteString(file.SourcePath)
		sb.WriteString("\n")
	}
	if err := os.WriteFile(manifestPath, []byte(sb.String()), 0o644); err != nil {
		slog.Warn("instantboot: failed to write sync manifest", "error", err.Error())
	}
}
