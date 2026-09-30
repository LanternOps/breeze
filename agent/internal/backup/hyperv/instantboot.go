//go:build windows

package hyperv

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
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
	// Integrity is the command's integrity expectation (nil when the
	// payload carried none). Not part of the JSON form.
	Integrity *integrity.Expectation `json:"-"`
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

	// Refuse an existing VM name before anything is downloaded. Without an
	// explicit work directory, the VM's disks go in a per-restore directory
	// under the host's default VM path rather than a temp directory.
	workDir := cfg.WorkDir
	createdWorkDir := false
	if workDir == "" {
		dirName, err := newRestoreDirName(cfg.VMName)
		if err != nil {
			result.Error = err.Error()
			return result, fmt.Errorf("instantboot: %w", err)
		}
		if workDir, err = prepareVMRestoreWith(runPS, cfg.VMName, "", dirName); err != nil {
			result.Error = err.Error()
			return result, fmt.Errorf("instantboot: prepare restore: %w", err)
		}
		createdWorkDir = true
	} else if err := requireVMNameFreeWith(runPS, cfg.VMName); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: %w", err)
	}
	defer func() {
		if createdWorkDir && result.Status == "failed" {
			if rmErr := os.RemoveAll(workDir); rmErr != nil {
				slog.Warn("instantboot: failed to clean up restore directory", "dir", workDir, "error", rmErr.Error())
			}
		}
	}()

	// 1. Download manifest.
	progress("downloading_manifest", 1, 8)
	slog.Info("instantboot: downloading snapshot manifest", "snapshotId", cfg.SnapshotID)

	manifest, manifestWarnings, err := fetchVMRestoreManifest(ctx, cfg.SnapshotID, provider, cfg.Integrity)
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: download manifest: %w", err)
	}
	result.Warnings = appendBoundedWarnings(result.Warnings, manifestWarnings...)

	// 2. Classify files into boot-critical and remaining.
	bootFiles, remainingFiles := classifyFiles(manifest.Files)
	slog.Info("instantboot: file classification",
		"bootCritical", len(bootFiles),
		"remaining", len(remainingFiles),
		"total", len(manifest.Files),
	)

	// 3. Create base VHDX in the work directory.
	progress("creating_vhdx", 2, 8)

	// 4. Create base VHDX.
	baseVHDX := filepath.Join(workDir, safeFileStem(cfg.VMName)+"-base.vhdx")
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

	bootTally := restoreManifestFiles(ctx, bootFiles, provider, targetRoot, cfg.Integrity)
	result.Warnings = appendBoundedWarnings(result.Warnings, bootTally.Warnings...)
	if bootTally.Failed > 0 {
		// A VM missing boot-critical files is not booted, and nothing is left
		// behind: the deferred cleanup removes the restore directory.
		dismountVHDX(baseVHDX)
		result.Error = fmt.Sprintf("failed to restore %d of %d boot-critical files: %v", bootTally.Failed, bootTally.Total, bootTally.FailedFiles)
		return result, fmt.Errorf("instantboot: %s", result.Error)
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
	diffVHDX := filepath.Join(workDir, safeFileStem(cfg.VMName)+"-diff.vhdx")
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

	newVMID, err := createAndConfigureVM(cfg.VMName, diffVHDX, workDir, memoryMB, cpuCount, "")
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: create VM: %w", err)
	}
	result.NewVMID = newVMID
	// The registered VM now owns the directory; never remove it from here on.
	createdWorkDir = false

	// Start the VM that was just created (by ID, never by name).
	startCmd, err := startVMByIDScript(newVMID)
	if err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: start VM: %w", err)
	}
	if _, err := runPS(startCmd); err != nil {
		result.Error = err.Error()
		return result, fmt.Errorf("instantboot: start VM: %w", err)
	}

	bootTime := time.Since(start).Milliseconds()
	result.BootTimeMs = bootTime
	result.Status = "completed"

	slog.Info("instantboot: VM booted",
		"vmName", cfg.VMName,
		"vmId", result.NewVMID,
		"bootTimeMs", bootTime,
		"remainingFiles", len(remainingFiles),
	)

	// 11. Sync the remaining files before returning. The command's context is
	// cancelled and its storage session revoked as soon as this returns, so
	// the sync runs inside the command, bounded by its run budget.
	runBackgroundSync(ctx, result, filepath.Join(workDir, "sync-staging"), remainingFiles, provider, cfg.Integrity)

	return result, nil
}

// classifyFiles separates manifest files into boot-critical and remaining.
func classifyFiles(files []vmRestoreManifFile) (bootCritical, remaining []vmRestoreManifFile) {
	for _, f := range files {
		if isBootCritical(restoreEntryPath(f)) {
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

// configureBootLoader runs the host's bcdboot (bcdbootCommand) to set up the
// Windows boot loader on the mounted volume.
func configureBootLoader(driveLetter string) error {
	exe, args, err := bcdbootCommand(driveLetter)
	if err != nil {
		return fmt.Errorf("bcdboot: %w", err)
	}
	winDir := args[0]
	if _, err := os.Stat(winDir); err != nil {
		return fmt.Errorf("Windows directory not found on %s: %w", driveLetter, err)
	}

	// bcdboot populates the EFI System Partition boot files.
	if out, err := exec.Command(exe, args...).CombinedOutput(); err != nil {
		return fmt.Errorf("bcdboot (%s): %w: %s", exe, err, strings.TrimSpace(string(out)))
	}
	return nil
}
