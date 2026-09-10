package rebuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// deviceBelongsTo reports whether dev names disk itself or one of its
// partitions. A bare strings.HasPrefix(dev, disk) is not enough — disk
// "/dev/sda" is a STRING prefix of the unrelated disk "/dev/sdaa1" too — so
// this checks the suffix left after the prefix matches partitionDevice's
// own naming rule: a disk whose name ends in a digit (nvme0n1, mmcblk0,
// loop0) always gets a "p" infix before the partition number, so anything
// else immediately after the prefix (including a bare digit, as in
// "/dev/nvme0n10" — a DIFFERENT nvme namespace, not a partition of
// nvme0n1) does not belong to it; a disk ending in a letter (sda, vda)
// never gets that infix, so the suffix must be digits directly.
func deviceBelongsTo(disk, dev string) bool {
	if dev == disk {
		return true
	}
	if !strings.HasPrefix(dev, disk) {
		return false
	}
	rest := dev[len(disk):]
	if n := len(disk); n > 0 && disk[n-1] >= '0' && disk[n-1] <= '9' {
		if !strings.HasPrefix(rest, "p") {
			return false
		}
		rest = rest[1:]
	}
	if rest == "" {
		return false
	}
	for _, c := range rest {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// preflight verifies everything it can before any write happens: the
// layout is restorable by this engine, the target is big enough and not in
// use / not the running system, and the ordinary manifest + system state
// artifacts download and verify (checksums) against the snapshot. Nothing
// in this phase touches the target disk.
func preflight(ctx context.Context, r *run) error {
	// 1. Layout + guard.
	lay := r.opts.Layout
	if lay == nil {
		var err error
		if lay, err = fetchLayout(ctx, r.opts.Provider, r.opts.SnapshotID); err != nil {
			return err
		}
	} else if lay.SchemaVersion != layout.SchemaVersion {
		return &RefusalError{Reason: fmt.Sprintf("layout schema version %d is not supported by this helper (supports %d)", lay.SchemaVersion, layout.SchemaVersion)}
	}
	if v := layout.Assess(lay); !v.Restorable {
		return &RefusalError{Reason: "layout is not bare-metal restorable: " + strings.Join(v.Reasons, "; ")}
	}
	if lay.Platform != "linux" {
		return &RefusalError{Reason: fmt.Sprintf("snapshot platform %q cannot be rebuilt by the Linux engine", lay.Platform)}
	}
	r.layout = lay
	src := lay.SystemDisk()

	// 2. Target sizing and safety. Nothing below writes.
	var targetSize int64
	switch r.opts.Target.Kind {
	case TargetDisk:
		mounted, err := r.sys.MountedSources()
		if err != nil {
			return err
		}
		for _, m := range mounted {
			if deviceBelongsTo(r.opts.Target.Path, m) {
				return &RefusalError{Reason: fmt.Sprintf("target disk %s is in use (%s is mounted)", r.opts.Target.Path, m)}
			}
		}
		roots, _ := r.sys.RootSources()
		for _, m := range roots {
			if deviceBelongsTo(r.opts.Target.Path, m) {
				return &RefusalError{Reason: fmt.Sprintf("target disk %s backs the running system (%s)", r.opts.Target.Path, m)}
			}
		}
		size, err := r.sys.BlockDeviceSize(r.opts.Target.Path)
		if err != nil {
			return err
		}
		targetSize = size
	case TargetImage:
		targetSize = r.opts.Target.ImageSizeBytes
		if fi, err := os.Stat(r.opts.Target.Path); err == nil {
			targetSize = fi.Size()
		}
		if targetSize <= 0 {
			return &RefusalError{Reason: "image target needs a size (--image-size) when the file does not exist"}
		}
	}
	sector := src.SectorSize
	if sector == 0 {
		sector = 512
	}
	plan, err := PlanPartitions(src, targetSize, sector)
	if err != nil {
		return err
	}
	plan.TargetPath = r.opts.Target.Path
	r.result.Plan = plan
	r.progress(PhasePreflight, "plan ready", 1, 3)

	// 3. Verify what we will restore: ordinary manifest + system state (checksums).
	man, err := fetchManifest(ctx, r.opts.Provider, r.opts.SnapshotID)
	if err != nil {
		return err
	}
	r.manifest = man
	staging, err := os.MkdirTemp("", "breeze-rebuild-state-*")
	if err != nil {
		return err
	}
	r.stateStaging = staging
	if _, warnings, err := bmr.DownloadSystemState(ctx, r.opts.Provider, r.opts.SnapshotID, false, staging); err != nil {
		if errors.Is(err, bmr.ErrNoSystemState) {
			r.warn("snapshot has no system state; only files will be restored")
		} else {
			return &RefusalError{Reason: "system state could not be verified: " + err.Error()}
		}
	} else {
		r.warnings = append(r.warnings, warnings...)
	}
	r.progress(PhasePreflight, "verified", 3, 3)
	return nil
}
