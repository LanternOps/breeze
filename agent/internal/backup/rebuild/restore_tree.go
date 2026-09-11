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
		if err := r.sys.Mount(ctx, r.sys.PartitionDevice(r.disk, p.Number), dir, fstype); err != nil {
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
	r.result.FilesRestored, r.result.BytesRestored = res.FilesRestored, res.BytesRestored
	r.warnings = append(r.warnings, res.Warnings...)
	if res.FilesFailed > 0 {
		msg := fmt.Sprintf("%d file(s) failed to restore: %s", res.FilesFailed, strings.Join(res.FailedFiles, ", "))
		if !r.opts.AllowPartialRestore {
			return errors.New(msg)
		}
		r.warn("%s", msg)
		r.failedFiles = make(map[string]bool, len(res.FailedFiles))
		for _, f := range res.FailedFiles {
			r.failedFiles[f] = true
		}
	}
	if r.stateStaging != "" {
		if entries, _ := os.ReadDir(r.stateStaging); len(entries) > 0 {
			warnings, err := bmr.RestoreSystemStateOffline(ctx, r.staging, r.stateStaging)
			r.warnings = append(r.warnings, warnings...)
			if err != nil {
				return fmt.Errorf("apply system state: %w", err)
			}
		}
	}
	return nil
}

// restoreWorkRoot is where the restore keeps its resume state and manifest
// scratch between engine runs. Removed by Run once the rebuild completes.
func restoreWorkRoot(stateDir string) string { return filepath.Join(stateDir, "work") }
