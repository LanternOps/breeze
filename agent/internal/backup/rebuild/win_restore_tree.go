// win_restore_tree.go — the Windows engine's restore phase (Part 0 §2 row
// 3) and its mount-tree helper.
package rebuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// winMountTree mounts root and Recovery at folder mount points under the
// staging root (Global Constraint "No PowerShell, no diskpart … Mounts") for
// Part C's external tools, records the root volume path the restore and
// validate go through (Ruling B1), remembers the ESP's volume for the
// boot and validate phases, and warns about every data partition left empty.
func (r *run) winMountTree(_ context.Context) error {
	root := filepath.Join(r.staging, "root")
	mounted := false
	for number, guidPath := range r.volumes {
		pp := r.plannedPartition(number)
		if pp == nil {
			continue
		}
		switch pp.Role {
		case layout.RoleRoot:
			if err := r.opts.WinSystem.MountVolume(guidPath, root); err != nil {
				return err
			}
			r.rootDir, r.rootVolume = root, guidPath
			mounted = true
		case layout.RoleRecovery:
			dir := filepath.Join(r.staging, "recovery")
			if err := r.opts.WinSystem.MountVolume(guidPath, dir); err != nil {
				return err
			}
			r.recoveryDir = dir
		case layout.RoleEFI:
			r.espVolume = guidPath
		}
	}
	// A data partition on the system disk is recreated and formatted but
	// never restored into (multi-volume snapshots are refused in
	// preflight, so its files were not in the snapshot) — say so, once per
	// partition (final-review ruling, Imp 3). winMountTree runs once per
	// process, from the restore phase or a resume's winReattach.
	if r.result.Plan != nil {
		for _, pp := range r.result.Plan.Partitions {
			if pp.Role != layout.RoleData {
				continue
			}
			label := pp.Label
			if label == "" {
				label = "no label"
			}
			r.warn("data partition %d (%s) was recreated empty; its contents were not restored", pp.Number, label)
		}
	}
	if !mounted {
		return errors.New("plan has no root (C:) volume to mount")
	}
	return nil
}

func (r *run) plannedPartition(number int) *PlannedPartition {
	if r.result.Plan == nil {
		return nil
	}
	for i := range r.result.Plan.Partitions {
		if r.result.Plan.Partitions[i].Number == number {
			return &r.result.Plan.Partitions[i]
		}
	}
	return nil
}

// winRestoreTree mounts the provisioned partitions (unless a resumed
// winReattach already did), restores the whole-machine file snapshot into
// the root VOLUME path r.rootVolume — not the r.rootDir folder mount point,
// which securefs would refuse as a reparse point (Ruling B1) — then runs
// the offline system-state step (applyWindowsSystemState,
// win_system_state.go), which alone decides Result.StateApplied.
func winRestoreTree(ctx context.Context, r *run) error {
	if r.rootDir == "" {
		if err := r.winMountTree(ctx); err != nil {
			return err
		}
	}
	workRoot := r.opts.WorkRoot
	if workRoot == "" {
		// disk: (WinPE) target: X: is a ≤512 MB RAM drive, too small for
		// restore scratch (Global Constraint "Work dir"); winValidate
		// removes this directory before release.
		workRoot = filepath.Join(r.rootVolume, "$breeze-rebuild-work")
	}
	if err := os.MkdirAll(workRoot, 0o700); err != nil {
		return fmt.Errorf("create restore work root: %w", err)
	}
	res, err := backup.RestoreFromSnapshotContext(ctx, r.opts.Provider, backup.RestoreConfig{SnapshotID: r.opts.SnapshotID, TargetPath: r.rootVolume, WorkRoot: workRoot}, func(_ string, cur, total int64, msg string) {
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
	return applyWindowsSystemState(ctx, r)
}
