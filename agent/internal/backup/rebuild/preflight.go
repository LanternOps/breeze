package rebuild

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
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
	// 1. Layout + guard. resolvePlatform (engine.go) already fetched and
	// schema/platform-checked the layout.
	lay := r.layout
	if v := layout.Assess(lay); !v.Restorable {
		return &RefusalError{Reason: "layout is not bare-metal restorable: " + strings.Join(v.Reasons, "; ")}
	}
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
		targetSize = r.defaultImageSize(src)
		if fi, err := os.Stat(r.opts.Target.Path); err == nil {
			targetSize = fi.Size()
		}
		if targetSize <= 0 {
			return &RefusalError{Reason: "image target needs a size (--image-size) when the file does not exist"}
		}
	case TargetVHDX:
		// The raw staging file is created by attach() at ImageSizeBytes and
		// the VHDX is written next to it by convert, so the host needs
		// room for both — checked here, before anything is written.
		targetSize = r.defaultImageSize(src)
		if fi, err := os.Stat(r.opts.Target.RawPath()); err == nil {
			targetSize = fi.Size()
		}
		if targetSize <= 0 {
			return &RefusalError{Reason: "vhdx target needs a size (--image-size) when the raw staging file does not exist"}
		}
		if _, err := r.sys.LookPath("qemu-img"); err != nil {
			return &RefusalError{Reason: "qemu-img not installed on this host; install qemu-utils"}
		}
		free, err := r.sys.FreeSpace(filepath.Dir(r.opts.Target.Path))
		if err != nil {
			return err
		}
		if need := targetSize * 3 / 2; free < need {
			return &RefusalError{Reason: fmt.Sprintf("not enough free space for raw image plus VHDX: need %d, have %d", need, free)}
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

	man, err := fetchManifest(ctx, r.opts.Provider, r.opts.SnapshotID)
	if err != nil {
		return err
	}
	r.manifest = man
	if err := preflightVerify(ctx, r); err != nil {
		return err
	}
	r.progress(PhasePreflight, "verified", 3, 3)
	return nil
}

// preflightVerify is preflight's admission-sweep + system-state-download
// tail, shared verbatim by the Linux and Windows preflights (Part 0 §2 row
// 1 "shared preflightVerify(ctx, r) extracted from preflight.go:143-198").
// r.manifest must already be set. Populates r.stateStaging,
// r.result.StateManifestFound, and appends to r.warnings — never writes to
// the rebuild target itself.
func preflightVerify(ctx context.Context, r *run) error {
	// Belt to bmr.ApplyManifestScope's braces: if the provider tracks its
	// own admissible set (token-mode recovery), refuse here — before any
	// target write — rather than letting an unadmitted entry surface as a
	// download failure mid-restore.
	if admitter, ok := r.opts.Provider.(ObjectAdmission); ok {
		var n int
		var first string
		for _, f := range r.manifest.Files {
			if !f.HasContent() {
				continue
			}
			if !admitter.Admits(f.BackupPath) {
				if first == "" {
					first = f.BackupPath
				}
				n++
			}
		}
		if n > 0 {
			return &RefusalError{Reason: fmt.Sprintf("%d file(s) reference objects outside the authorized download scope (first: %s); upgrade the Breeze server or choose a self-contained snapshot", n, first)}
		}
	}
	staging, err := os.MkdirTemp("", "breeze-rebuild-state-*")
	if err != nil {
		return err
	}
	r.stateStaging = staging
	// #5412 gate: when the caller says the snapshot carries system state
	// (a system_image backup / a bootstrap advertising a state manifest), a
	// confirmed-absent or artifact-less manifest is a refusal, not the
	// "files only" warning below — that warning is exactly how a
	// system_image restore once reported completed/validated while
	// applying no OS state. Nothing has been written yet at this point.
	if _, warnings, err := bmr.DownloadSystemState(ctx, r.opts.Provider, r.opts.SnapshotID, r.opts.ExpectSystemState, staging); err != nil {
		switch {
		case r.opts.ExpectSystemState && (errors.Is(err, bmr.ErrNoSystemState) || errors.Is(err, providers.ErrObjectNotFound)):
			return &RefusalError{Reason: "system state expected but system-state/manifest.json is missing from the snapshot"}
		case r.opts.ExpectSystemState && errors.Is(err, bmr.ErrNoSystemStateArtifacts):
			return &RefusalError{Reason: "system state expected but system-state/manifest.json lists no artifacts"}
		case !r.opts.ExpectSystemState && errors.Is(err, bmr.ErrNoSystemState):
			r.warn("snapshot has no system state; only files will be restored")
		default:
			return &RefusalError{Reason: "system state could not be verified: " + err.Error()}
		}
	} else {
		r.result.StateManifestFound = true
		r.warnings = append(r.warnings, warnings...)
	}
	return nil
}

// defaultImageSize sizes an image/vhdx target that was dispatched without
// an explicit size (a DR rehearsal carries none) at the snapshot's system
// disk size, and records it on the target so attach() creates the raw file
// at that size. An explicit size always wins.
func (r *run) defaultImageSize(src *layout.Disk) int64 {
	if r.opts.Target.ImageSizeBytes <= 0 && src != nil && src.SizeBytes > 0 {
		r.opts.Target.ImageSizeBytes = src.SizeBytes
		r.warn("no image size given; using the source system disk size (%d bytes)", src.SizeBytes)
	}
	return r.opts.Target.ImageSizeBytes
}
