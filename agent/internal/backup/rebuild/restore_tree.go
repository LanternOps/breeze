package rebuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/bmr"
)

// mountTree mounts every planned partition with a mount point under the
// staging root, shallowest first (/ then /boot then /boot/efi).
func mountTree(ctx context.Context, r *run) error {
	parts := make([]PlannedPartition, 0, len(r.result.Plan.Partitions))
	for _, p := range r.result.Plan.Partitions {
		if p.MountPoint != "" && p.Filesystem != "swap" && p.Filesystem != "" {
			parts = append(parts, p)
		}
	}
	sort.Slice(parts, func(i, j int) bool {
		di, dj := strings.Count(parts[i].MountPoint, "/"), strings.Count(parts[j].MountPoint, "/")
		if di != dj {
			return di < dj
		}
		return parts[i].MountPoint < parts[j].MountPoint
	})
	if len(parts) == 0 || parts[0].MountPoint != "/" {
		return errors.New("plan has no root mount point")
	}
	for _, p := range parts {
		dir := filepath.Join(r.staging, filepath.FromSlash(strings.TrimPrefix(p.MountPoint, "/")))
		fstype := p.Filesystem
		if fstype == "fat32" {
			fstype = "vfat"
		}
		if err := mountWithBusyRetry(ctx, r.sys, r.sys.PartitionDevice(r.disk, p.Number), dir, fstype); err != nil {
			return err
		}
		if p.MountPoint == "/" {
			r.rootMount = dir
		} else {
			r.treeMounts = append(r.treeMounts, dir)
		}
	}
	return nil
}

// restoreTree mounts the provisioned partitions (if not already mounted by
// a resumed reattach), restores the whole-machine file snapshot into the
// staging root, and layers the offline system-state apply on top.
func restoreTree(ctx context.Context, r *run) error {
	if r.rootMount == "" {
		if err := mountTree(ctx, r); err != nil {
			return err
		}
	}
	// A persistent work root keeps the restore's resume state across engine
	// runs: without it RestoreFromSnapshotContext creates an ephemeral work
	// dir and deletes it on return, so a resumed rebuild re-restores every
	// file instead of skipping the ones already on disk (found live on the
	// W03 boot proof: 104k files restored twice).
	workRoot := restoreWorkRoot(r.opts.StateDir)
	if err := os.MkdirAll(workRoot, 0o700); err != nil {
		return fmt.Errorf("create restore work root: %w", err)
	}
	res, err := backup.RestoreFromSnapshotContext(ctx, r.opts.Provider, backup.RestoreConfig{SnapshotID: r.opts.SnapshotID, TargetPath: r.staging, WorkRoot: workRoot}, func(phase string, cur, total int64, msg string) {
		r.progress(PhaseRestore, msg, cur, total)
	})
	if err != nil {
		return fmt.Errorf("restore files: %w", err)
	}
	if err := restoreInterrupted(ctx, res); err != nil {
		return err
	}
	if err := r.recordRestoreFailures(res); err != nil {
		return err
	}
	// Belt-and-braces (#5493): run this even when boot() will be skipped
	// (Options.SkipBoot) — boot() is the phase that actually bind-mounts
	// /proc, /sys, /dev, /run, but a SkipBoot run still produces a staging
	// tree that must be a bootable disk image, so the mount points must
	// exist regardless of whether boot() itself runs.
	if err := ensureMountpoints(r.staging); err != nil {
		return fmt.Errorf("ensure mount points: %w", err)
	}
	// System state: apply whatever preflight staged. StateApplied flips
	// only on a nil return from the offline apply; with ExpectSystemState
	// an apply that never ran (nothing staged) is as fatal as one that
	// failed — the run must not reach "completed" without it (#5412).
	staged := false
	if r.stateStaging != "" {
		if entries, _ := os.ReadDir(r.stateStaging); len(entries) > 0 {
			staged = true
			warnings, err := bmr.RestoreSystemStateOffline(ctx, r.staging, r.stateStaging)
			r.warnings = append(r.warnings, warnings...)
			if err != nil {
				return fmt.Errorf("apply system state: %w", err)
			}
			r.result.StateApplied = true
			r.state.StateApplied = true
		}
	}
	if r.opts.ExpectSystemState && !staged {
		return errors.New("apply system state: system state expected but no artifacts were staged by preflight")
	}
	return nil
}

// restoreInterrupted fails the restore phase when the file restore stopped
// early because ctx ended: RestoreFromSnapshotContext then returns its
// partial result with a nil error, and without this check the phase would
// be recorded completed, so a resumed run would skip the files that were
// never restored (#6664). Shared by restoreTree and winRestoreTree.
func restoreInterrupted(ctx context.Context, res *backup.RestoreResult) error {
	if ctx.Err() == nil {
		return nil
	}
	restored := 0
	if res != nil {
		restored = res.FilesRestored
	}
	return fmt.Errorf("restore files interrupted after %d files: %w", restored, context.Cause(ctx))
}

// restoreWorkRoot is where the restore keeps its resume state and manifest
// scratch between engine runs. Removed by Run once the rebuild completes.
func restoreWorkRoot(stateDir string) string { return filepath.Join(stateDir, "work") }

// recordRestoreFailures copies a file restore's counts and warnings into the
// result and, when files failed, records them for validate and in the
// result; without AllowPartialRestore any failure is the phase's error.
// Shared by the Linux restoreTree and the Windows winRestoreTree.
func (r *run) recordRestoreFailures(res *backup.RestoreResult) error {
	r.result.FilesRestored, r.result.BytesRestored = res.FilesRestored, res.BytesRestored
	r.warnings = append(r.warnings, res.Warnings...)
	if res.FilesFailed == 0 {
		return nil
	}
	// The internal failedFiles map is never truncated — validate.go
	// (which consumes it) must see every failed source path even
	// though the reported message/sample below is bounded.
	r.failedFiles = make(map[string]bool, len(res.FailedFiles))
	for _, f := range res.FailedFiles {
		r.failedFiles[f] = true
	}

	const maxFailedFilesSample = 50
	sample := make([]string, 0, len(r.failedFiles))
	for f := range r.failedFiles {
		sample = append(sample, f)
	}
	sort.Strings(sample) // deterministic "first N" — map iteration order is not
	r.result.FilesFailed = len(sample)
	if len(sample) > maxFailedFilesSample {
		r.result.FailedFilesSample = sample[:maxFailedFilesSample]
		r.result.FailedFilesOmitted = len(sample) - maxFailedFilesSample
	} else {
		r.result.FailedFilesSample = sample
	}

	msg := fmt.Sprintf("%d file(s) failed to restore (first %d shown): %s", len(sample), len(r.result.FailedFilesSample), strings.Join(r.result.FailedFilesSample, ", "))
	r.warn("%s", msg)
	if !r.opts.AllowPartialRestore {
		return errors.New(msg)
	}
	return nil
}
