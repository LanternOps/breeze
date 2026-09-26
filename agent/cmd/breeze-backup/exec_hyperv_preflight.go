package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/shirou/gopsutil/v3/disk"
)

// Seams over the Hyper-V PowerShell calls and the disk query, so the command
// handlers are testable off Windows.
var (
	exportHypervVM            = hyperv.ExportVM
	importHypervVM            = hyperv.ImportVM
	estimateHypervExportBytes = hyperv.EstimateExportBytes
	hypervImportTargetDir     = hyperv.DefaultVirtualHardDiskPath
	volumeFreeBytes           = diskFreeBytes
	hypervVolumeKey           = volumeKey
)

// hypervStagingHeadroomBytes is required on top of every estimate: the export's
// configuration files, filesystem slack, and not driving the volume — often
// the system drive — to zero free bytes.
const hypervStagingHeadroomBytes = int64(1) << 30

// hypervStagingDirPrefix is shared by the export ("breeze-hyperv-*") and
// restore ("breeze-hyperv-restore-*") staging dirs.
const hypervStagingDirPrefix = "breeze-hyperv-"

func diskFreeBytes(dir string) (int64, error) {
	usage, err := disk.Usage(dir)
	if err != nil {
		return 0, err
	}
	return int64(usage.Free), nil
}

// hypervStagingBase is the directory the Hyper-V staging dirs are created in:
// agent.yaml's backup_staging_dir when set, else the OS temp dir (what
// os.MkdirTemp does with an empty dir).
func hypervStagingBase(mgr *backup.BackupManager) string {
	if mgr != nil {
		if dir := strings.TrimSpace(mgr.GetStagingDir()); dir != "" {
			return dir
		}
	}
	return os.TempDir()
}

// hypervSpaceNeed is one write the operation will make: bytes into dir.
type hypervSpaceNeed struct {
	dir   string
	bytes int64
	what  string
}

// volumeKey groups directories that share a volume. On Windows that is the
// drive letter or UNC share; elsewhere (a platform where Hyper-V never runs)
// each directory is treated as its own volume. A directory mounted as a volume
// under another drive's path is grouped with that drive, which can only
// over-count the need, never under-count it.
func volumeKey(dir string) string {
	if vol := filepath.VolumeName(dir); vol != "" {
		return strings.ToUpper(vol)
	}
	return filepath.Clean(dir)
}

// volumeProbeDir is the path whose free space is read for dir: its volume
// root on Windows, so a target directory that does not exist yet (Hyper-V's
// default virtual hard disk path on a host that never stored a VHD there)
// still resolves.
func volumeProbeDir(dir string) string {
	if vol := filepath.VolumeName(dir); vol != "" {
		return vol + string(filepath.Separator)
	}
	return dir
}

func formatGiB(n int64) string {
	return fmt.Sprintf("%.1f GiB", float64(n)/float64(1<<30))
}

// checkHypervSpace sums the needs per volume and refuses when a volume has less
// free space than its total plus headroom. A volume whose free space cannot be
// read is skipped with a returned warning: the preflight must never fail an
// operation that would have run before it existed.
func checkHypervSpace(operation string, needs []hypervSpaceNeed) (warnings []string, err error) {
	type volume struct {
		dir   string
		bytes int64
		what  []string
	}
	var order []string
	volumes := map[string]*volume{}
	for _, need := range needs {
		key := hypervVolumeKey(need.dir)
		v, ok := volumes[key]
		if !ok {
			v = &volume{dir: need.dir}
			volumes[key] = v
			order = append(order, key)
		}
		v.bytes += need.bytes
		v.what = append(v.what, need.what)
	}
	for _, key := range order {
		v := volumes[key]
		free, freeErr := volumeFreeBytes(volumeProbeDir(v.dir))
		if freeErr != nil {
			msg := fmt.Sprintf("free-space preflight skipped for %s: cannot read free space: %v", v.dir, freeErr)
			slog.Warn("hyperv: "+msg, "operation", operation)
			warnings = append(warnings, msg)
			continue
		}
		required := v.bytes + hypervStagingHeadroomBytes
		if free < required {
			return warnings, fmt.Errorf(
				"not enough free space for %s: %s needs about %s (%s, plus %s headroom) but its volume has only %s free. "+
					"Free up space there, or set backup_staging_dir in agent.yaml to a directory on a volume with more room",
				operation, v.dir, formatGiB(required), strings.Join(v.what, " + "),
				formatGiB(hypervStagingHeadroomBytes), formatGiB(free))
		}
	}
	return warnings, nil
}

// preflightHypervExport refuses an export that cannot fit in stagingBase.
// When the VM's size cannot be estimated it lets the export run and returns a
// warning instead.
func preflightHypervExport(vmName, stagingBase string) ([]string, error) {
	operation := fmt.Sprintf("the Hyper-V export of VM %q", vmName)
	estimate, err := estimateHypervExportBytes(vmName)
	if err != nil {
		msg := fmt.Sprintf("free-space preflight skipped: cannot estimate the size of VM %q: %v", vmName, err)
		slog.Warn("hyperv: " + msg)
		return []string{msg}, nil
	}
	return checkHypervSpace(operation, []hypervSpaceNeed{{
		dir:   stagingBase,
		bytes: estimate,
		what:  fmt.Sprintf("%s VM export", formatGiB(estimate)),
	}})
}

// preflightHypervRestore refuses a restore whose download (into stagingBase)
// and Import-VM -Copy (into the host's virtual hard disk path) cannot both fit.
// When they share a volume, that volume needs two copies. Like the export
// preflight it fails open, returning a warning for each check it could not
// make.
func preflightHypervRestore(manifest *hypervSnapshotManifest, stagingBase string) ([]string, error) {
	if manifest == nil {
		return nil, nil
	}
	size := manifest.Size
	if size <= 0 {
		for _, f := range manifest.Files {
			size += f.Size
		}
	}
	if size <= 0 {
		msg := fmt.Sprintf("free-space preflight skipped: snapshot %q records no size", manifest.ID)
		slog.Warn("hyperv: " + msg)
		return []string{msg}, nil
	}
	operation := fmt.Sprintf("the Hyper-V restore of snapshot %q", manifest.ID)
	needs := []hypervSpaceNeed{{
		dir:   stagingBase,
		bytes: size,
		what:  fmt.Sprintf("%s download", formatGiB(size)),
	}}
	var warnings []string
	importDir, err := hypervImportTargetDir()
	if err != nil {
		msg := fmt.Sprintf("free-space preflight skipped for the import destination: %v", err)
		slog.Warn("hyperv: " + msg)
		warnings = append(warnings, msg)
	} else {
		needs = append(needs, hypervSpaceNeed{
			dir:   importDir,
			bytes: size,
			what:  fmt.Sprintf("%s Import-VM copy", formatGiB(size)),
		})
	}
	spaceWarnings, err := checkHypervSpace(operation, needs)
	return append(warnings, spaceWarnings...), err
}

// hypervStagingAliveMarker is a file at the root of every live Hyper-V staging
// dir, touched every hypervStagingHeartbeatInterval while its owner runs. The
// directory's own mtime is no liveness signal: it freezes once Export-VM has
// created its subfolders, however long the copy then takes.
const hypervStagingAliveMarker = ".breeze-hyperv-alive"

const hypervStagingHeartbeatInterval = 5 * time.Minute

// hypervOrphanMinAge: a staging dir whose marker has not been touched for this
// long has no live owner (12 missed heartbeats).
const hypervOrphanMinAge = time.Hour

// hypervOrphanLegacyMinAge applies to a staging dir with no marker — written
// by a helper that predates it, which may still be running during an update.
// Only directories that old are treated as orphans.
const hypervOrphanLegacyMinAge = 24 * time.Hour

// startHypervStagingHeartbeat writes the liveness marker into dir now and
// refreshes it every interval until the returned stop func is called (safe to
// call more than once).
func startHypervStagingHeartbeat(dir string, interval time.Duration) (stop func()) {
	marker := filepath.Join(dir, hypervStagingAliveMarker)
	touch := func() {
		now := time.Now()
		if err := os.Chtimes(marker, now, now); err == nil {
			return
		}
		if err := os.WriteFile(marker, nil, 0o600); err != nil {
			slog.Warn("hyperv: cannot write staging liveness marker", "path", marker, "error", err.Error())
		}
	}
	touch()
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				touch()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(done)
			<-finished
		})
	}
}

// sweepOrphanedHypervStaging removes Breeze Hyper-V staging dirs left behind
// by a helper that was killed mid-export or mid-restore — its deferred cleanup
// never ran, and each one is the size of a VM. Only direct children of each
// base named breeze-hyperv-* are considered: one whose liveness marker is
// older than minAge, or, with no marker, whose own mtime is older than
// legacyMinAge. Returns how many were removed.
func sweepOrphanedHypervStaging(bases []string, minAge, legacyMinAge time.Duration) int {
	removed := 0
	seen := map[string]bool{}
	now := time.Now()
	for _, base := range bases {
		base = strings.TrimSpace(base)
		if base == "" {
			continue
		}
		base = filepath.Clean(base)
		if seen[base] {
			continue
		}
		seen[base] = true
		entries, err := os.ReadDir(base)
		if err != nil {
			if !os.IsNotExist(err) {
				slog.Warn("hyperv: cannot list staging base for orphan sweep", "dir", base, "error", err.Error())
			}
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !strings.HasPrefix(entry.Name(), hypervStagingDirPrefix) {
				continue
			}
			dir := filepath.Join(base, entry.Name())
			var lastAlive time.Time
			maxAge := minAge
			if info, err := os.Stat(filepath.Join(dir, hypervStagingAliveMarker)); err == nil {
				lastAlive = info.ModTime()
			} else if info, err := entry.Info(); err == nil {
				lastAlive = info.ModTime()
				maxAge = legacyMinAge
			} else {
				continue
			}
			if now.Sub(lastAlive) < maxAge {
				continue
			}
			if err := os.RemoveAll(dir); err != nil {
				slog.Warn("hyperv: failed to remove orphaned staging dir", "dir", dir, "error", err.Error())
				continue
			}
			slog.Info("hyperv: removed orphaned staging dir", "dir", dir, "lastAlive", lastAlive)
			removed++
		}
	}
	return removed
}
