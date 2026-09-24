// win_provision.go — the Windows engine's provision phase (Part 0 §2 row
// 2) and its attach/reattach/teardown twins (provision.go / engine.go on
// Linux).
package rebuild

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/wingpt"
)

// gptAttrNoDriveLetter is GPT_BASIC_DATA_ATTRIBUTE_NO_DRIVE_LETTER: set on
// every partition for the run (Global Constraint "No automount
// surprises"); winValidate's last layout write clears it on root/data.
const gptAttrNoDriveLetter = uint64(0x8000000000000000)

// winRunWithRetry is runWithBusyRetry's WinSystem twin — same
// deviceBusyRetryAttempts/deviceBusyRetryDelay budget and the same
// isDeviceBusyOutput classifier (provision.go): format.com on a partition
// Windows has just created can race an antivirus/indexer filter-driver open
// the way mkfs races udev on Linux. Used by the real Format (Task 12).
func winRunWithRetry(ctx context.Context, sys WinSystem, name string, args ...string) ([]byte, error) {
	var out []byte
	var err error
	for attempt := 1; attempt <= deviceBusyRetryAttempts; attempt++ {
		out, err = sys.Run(ctx, name, args...)
		busy := isDeviceBusyOutput(out) || isWindowsVolumeBusyOutput(out)
		if err == nil || !busy || attempt == deviceBusyRetryAttempts {
			return out, err
		}
		select {
		case <-ctx.Done():
			return out, ctx.Err()
		case <-time.After(deviceBusyRetryDelay):
		}
	}
	return out, err
}

// isWindowsVolumeBusyOutput recognises format.com's "someone else still
// has this volume open" wording (an indexer/AV filter racing the new
// volume) — the only failure winRunWithRetry retries besides the Linux
// busy texts.
func isWindowsVolumeBusyOutput(out []byte) bool {
	s := strings.ToLower(string(out))
	return strings.Contains(s, "cannot lock current drive") ||
		strings.Contains(s, "in use by another process") ||
		strings.Contains(s, "being used by another process")
}

// winProvision partitions and formats the target per r.result.Plan:
// WipeDisk clears any existing table; WriteGPT lays down the recorded disk
// and partition GUIDs (a fresh GUID only where the layout recorded none),
// the plan's role-default names, and the source's GPT attributes verbatim
// plus the no-drive-letter bit for the run (Global Constraints "Partition
// GUIDs are identity", "No automount surprises"); then each partition with
// a filesystem is formatted through WinSystem.Format.
func winProvision(ctx context.Context, r *run) error {
	if err := r.winAttach(ctx, true); err != nil {
		return err
	}
	plan := r.result.Plan
	if err := r.opts.WinSystem.WipeDisk(ctx, r.diskNumber); err != nil {
		return err
	}
	diskGUID := r.layout.SystemDisk().GUID
	if diskGUID == "" {
		g, err := wingpt.NewGUID()
		if err != nil {
			return err
		}
		diskGUID = g
	}
	var gptParts []WinGPTPartition
	formatted := 0
	for _, p := range plan.Partitions {
		partGUID := p.PartUUID
		if partGUID == "" {
			g, err := wingpt.NewGUID()
			if err != nil {
				return err
			}
			partGUID = g
		}
		gptParts = append(gptParts, WinGPTPartition{
			Number: p.Number, TypeGUID: p.TypeGUID, PartGUID: partGUID, Name: p.Name,
			StartBytes: p.StartBytes, SizeBytes: p.SizeBytes, Attributes: p.Attributes | gptAttrNoDriveLetter,
		})
		if p.Filesystem != "" {
			formatted++
		}
	}
	if err := r.opts.WinSystem.WriteGPT(r.diskNumber, diskGUID, gptParts); err != nil {
		return err
	}
	vols, err := r.opts.WinSystem.WaitForVolumes(ctx, r.diskNumber, formatted)
	if err != nil {
		return err
	}
	byNumber := map[int]WinVolume{}
	for _, v := range vols {
		byNumber[v.PartitionNumber] = v
	}
	r.volumes = map[int]string{}
	for i, p := range plan.Partitions {
		if p.Filesystem == "" {
			continue // the MSR carries no filesystem/volume
		}
		v, ok := byNumber[p.Number]
		if !ok {
			return fmt.Errorf("volume for partition %d did not appear after WriteGPT", p.Number)
		}
		fsName := "ntfs"
		if p.Filesystem == "fat32" || p.Filesystem == "vfat" {
			fsName = "fat32"
		}
		if err := r.opts.WinSystem.Format(ctx, v.GUIDPath, fsName, strings.ToUpper(p.Label)); err != nil {
			return fmt.Errorf("format %s (partition %d): %w", v.GUIDPath, p.Number, err)
		}
		r.volumes[p.Number] = v.GUIDPath
		r.progress(PhaseProvision, fmt.Sprintf("formatted partition %d", p.Number), int64(i+1), int64(len(plan.Partitions)))
	}
	r.state.Volumes = r.volumes
	return nil
}

// winAttach resolves r.diskNumber: a disk: target's physical drive number
// (validated by winPreflight), or the VHDX's disk number once attached.
// create=true (provision) makes a fresh VHDX, removing a stale file from an
// earlier, unfinished run first — provision is destructive to the target by
// definition; create=false (resume) attaches the existing file. Like
// attach() on Linux, the attach never outlives this process: the VHDX is
// attached non-permanently and teardown's r.detach releases it.
func (r *run) winAttach(_ context.Context, create bool) error {
	switch r.opts.Target.Kind {
	case TargetDisk:
		n, err := parseDiskTargetPath(r.opts.Target.Path)
		if err != nil {
			return err
		}
		r.diskNumber = n
	case TargetVHDX:
		if create {
			size := r.opts.Target.ImageSizeBytes
			if size <= 0 {
				size = r.layout.SystemDisk().SizeBytes
			}
			sector := r.layout.SystemDisk().SectorSize
			if sector == 0 {
				sector = 512
			}
			if err := os.Remove(r.opts.Target.Path); err != nil && !os.IsNotExist(err) {
				return fmt.Errorf("remove stale VHDX %s: %w", r.opts.Target.Path, err)
			}
			if err := r.opts.WinSystem.CreateVHDX(r.opts.Target.Path, size, sector); err != nil {
				return err
			}
		}
		n, detach, err := r.opts.WinSystem.AttachVHDX(r.opts.Target.Path)
		if err != nil {
			return err
		}
		r.diskNumber, r.detach = n, detach
	default:
		return fmt.Errorf("winAttach: unsupported target kind %q", r.opts.Target.Kind)
	}
	r.winAttached = true
	return nil
}

// winReattach is the resume twin (reattach(), provision.go): attach the
// existing target once per process, restore r.volumes from the persisted
// runState.Volumes and remount the tree — never WriteGPT/Format again (R29).
// Run calls it for each skipped destructive phase (provision, restore), so
// every step is idempotent.
func (r *run) winReattach(ctx context.Context) error {
	if !r.winAttached {
		if err := r.winAttach(ctx, false); err != nil {
			return err
		}
	}
	if r.volumes == nil {
		r.volumes = r.state.Volumes
	}
	if r.rootDir == "" && r.state.Completed[PhaseProvision] {
		return r.winMountTree(ctx)
	}
	return nil
}

// winTeardown releases every Windows-host resource this run holds except
// the VHDX itself (teardown's r.detach, which runs after this): loaded
// hives, the ESP's temporary letter, then the folder mount points —
// ESP/Recovery first, root last; a root that will not unmount sets
// r.releaseErr (the VHDX would still be in use). No-op on Linux runs.
func (r *run) winTeardown() {
	if r.opts.WinSystem == nil {
		return
	}
	// Loaded hives first (W06c loads them; a hive mount outlives the
	// process, so every exit path must unload it). validateOSState closes
	// them explicitly on success; this is the failure-path backstop.
	for name, h := range r.hives {
		if err := h.Close(); err != nil {
			r.warn("unload %s hive: %v", name, err)
		}
	}
	r.hives = nil
	if r.espLetterRelease != nil {
		if err := r.espLetterRelease(); err != nil {
			r.warn("release ESP drive letter: %v", err)
		}
		r.espLetterRelease = nil
	}
	for _, d := range []*string{&r.espDir, &r.recoveryDir} {
		if *d == "" {
			continue
		}
		if err := r.opts.WinSystem.UnmountVolume(*d); err != nil {
			r.warn("unmount %s: %v", *d, err)
		}
		*d = ""
	}
	if r.rootDir != "" {
		if err := r.opts.WinSystem.UnmountVolume(r.rootDir); err != nil {
			r.warn("unmount %s: %v", r.rootDir, err)
			r.releaseErr = err
		}
		r.rootDir = ""
	}
}
