// win_preflight.go — the Windows engine's preflight phase (Part 0 §2 row
// 1). Nothing here writes to the target — same invariant preflight.go's
// Linux preflight documents.
package rebuild

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

func winPreflight(ctx context.Context, r *run) error {
	lay := r.layout // fetched + schema/platform-checked by resolvePlatform
	if v := layout.Assess(lay); !v.Restorable {
		return &RefusalError{Reason: "layout is not bare-metal restorable: " + strings.Join(v.Reasons, "; ")}
	}
	src := lay.SystemDisk()

	man, err := fetchManifest(ctx, r.opts.Provider, r.opts.SnapshotID)
	if err != nil {
		return err
	}
	r.manifest = man
	var manifestBytes int64
	for _, f := range man.Files {
		if f.HasContent() {
			manifestBytes += f.Size
		}
	}

	var targetSize int64
	switch r.opts.Target.Kind {
	case TargetDisk:
		// Controller ruling B5: ForceDisk overrides ONLY the Windows-tree
		// refusal below (R7), never the WinPE gate — the Global Constraint
		// is "a live Windows host may only write vhdx: targets", and that
		// invariant is not something --force-disk can waive.
		if !r.opts.WinSystem.InWinPE() {
			return &RefusalError{Reason: "disk targets are only supported from Breeze recovery media (WinPE); use a vhdx target on a running Windows host"}
		}
		diskNumber, perr := parseDiskTargetPath(r.opts.Target.Path)
		if perr != nil {
			return &RefusalError{Reason: perr.Error()}
		}
		sysDisk, err := r.opts.WinSystem.SystemDiskNumber()
		if err != nil {
			return err
		}
		if sysDisk == diskNumber {
			return &RefusalError{Reason: fmt.Sprintf("target disk %d holds the running system", diskNumber)}
		}
		media, err := r.opts.WinSystem.MediaDiskNumbers()
		if err != nil {
			return err
		}
		for _, m := range media {
			if m == diskNumber {
				return &RefusalError{Reason: fmt.Sprintf("target disk %d holds the recovery media", diskNumber)}
			}
		}
		info, err := r.opts.WinSystem.DiskInfo(diskNumber)
		if err != nil {
			return err
		}
		if info.ReadOnly || info.Offline {
			return &RefusalError{Reason: fmt.Sprintf("target disk %d is read-only or offline", diskNumber)}
		}
		if !r.opts.ForceDisk {
			vols, err := r.opts.WinSystem.VolumesOnDisk(diskNumber)
			if err != nil {
				return err
			}
			for _, v := range vols {
				has, err := r.opts.WinSystem.HasWindowsTree(v.GUIDPath)
				if err != nil {
					return err
				}
				if has {
					return &RefusalError{Reason: fmt.Sprintf("target disk %d contains a Windows installation; pass --force-disk to overwrite it", diskNumber)}
				}
			}
		}
		targetSize = info.SizeBytes
		r.diskNumber = diskNumber
	case TargetVHDX:
		// A dynamic VHDX grows to what is written, not to its virtual size:
		// the free-space check below uses the plan's minimum.
		targetSize = r.defaultImageSize(src)
	default:
		return &RefusalError{Reason: fmt.Sprintf("target kind %q is not supported by the Windows engine (disk, vhdx)", r.opts.Target.Kind)}
	}

	sector := src.SectorSize
	if sector == 0 {
		sector = 512
	}
	plan, err := PlanPartitionsWindows(src, targetSize, sector, manifestBytes)
	if err != nil {
		return err
	}
	plan.TargetPath = r.opts.Target.Path
	if r.opts.Target.Kind == TargetVHDX {
		free, err := r.opts.WinSystem.FreeSpace(filepath.Dir(r.opts.Target.Path))
		if err != nil {
			return err
		}
		if free < plan.MinimumBytes {
			return &RefusalError{Reason: fmt.Sprintf("not enough free space for the VHDX: need %d, have %d", plan.MinimumBytes, free)}
		}
	}
	r.result.Plan = plan
	r.progress(PhasePreflight, "plan ready", 1, 3)

	if err := preflightVerify(ctx, r); err != nil {
		return err
	}

	if !r.opts.AllowDomainController {
		isDC, err := r.hasNTDS()
		if err != nil {
			return err
		}
		if isDC {
			return &RefusalError{Reason: `source is a domain controller (Services\NTDS present); pass --allow-domain-controller and read the DC recovery guidance`}
		}
	}
	r.progress(PhasePreflight, "verified", 3, 3)
	return nil
}

// hasNTDS checks the domain-controller signal against the STAGED
// system-state/registry/SYSTEM artifact (downloaded by preflightVerify into
// r.stateStaging) — a fast, artifact-only early refusal. No staged SYSTEM
// artifact (a files-only snapshot, or a snapshot where the artifact was
// itself missing) means "cannot tell from here"; the W06c state apply
// (Part C Task 14, bmr.RestoreSystemStateOfflineWindows) applies the same
// winhive.HasNTDS check to the FILE-TREE SYSTEM hive before any hive edit,
// per the Global Constraint "Hives: file tree first".
func (r *run) hasNTDS() (bool, error) {
	hivePath := filepath.Join(r.stateStaging, "registry", "SYSTEM")
	if _, err := os.Stat(hivePath); err != nil {
		return false, nil
	}
	mountName := "BRZ_" + targetKey(r.opts.Target) + "_PRE"
	h, err := r.opts.WinSystem.LoadHive(hivePath, mountName)
	if err != nil {
		return false, fmt.Errorf("load SYSTEM hive for domain-controller check: %w", err)
	}
	defer func() { _ = h.Close() }()
	return winhive.HasNTDS(h.Root())
}

// parseDiskTargetPath extracts the disk number from a Windows physical
// drive path (\\.\PhysicalDrive3) — the shape a disk: target's Path already
// carries verbatim (parseTargetFlag, agent/cmd/breeze-backup/rebuild_cmd.go,
// unmodified by this wave: "disk" already maps straight to
// Target{Kind: TargetDisk, Path: p}).
func parseDiskTargetPath(path string) (int, error) {
	const prefix = `\\.\PhysicalDrive`
	if !strings.HasPrefix(path, prefix) {
		return 0, fmt.Errorf(`disk target path must be \\.\PhysicalDrive<n>, got %q`, path)
	}
	n, err := strconv.Atoi(strings.TrimPrefix(path, prefix))
	if err != nil || n < 0 {
		return 0, fmt.Errorf(`disk target path must be \\.\PhysicalDrive<n>, got %q`, path)
	}
	return n, nil
}
