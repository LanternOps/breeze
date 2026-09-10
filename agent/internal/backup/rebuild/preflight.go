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
			if m == r.opts.Target.Path || strings.HasPrefix(m, r.opts.Target.Path) {
				return &RefusalError{Reason: fmt.Sprintf("target disk %s is in use (%s is mounted)", r.opts.Target.Path, m)}
			}
		}
		roots, _ := r.sys.RootSources()
		for _, m := range roots {
			if m == r.opts.Target.Path || strings.HasPrefix(m, r.opts.Target.Path) {
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
			return &RefusalError{Reason: "system state verification failed: " + err.Error()}
		}
	} else {
		r.warnings = append(r.warnings, warnings...)
	}
	r.progress(PhasePreflight, "verified", 3, 3)
	return nil
}
