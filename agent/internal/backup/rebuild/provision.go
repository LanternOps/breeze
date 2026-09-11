package rebuild

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// partitionDeviceWaitTimeout bounds how long provision/reattach will poll
// for a partition's device node to appear after a Rescan (partprobe). A
// package var, not a const, so a test could shrink it (none currently need
// to — the fake System's Exists always reports true immediately).
var partitionDeviceWaitTimeout = 10 * time.Second

// mkfsBusyRetryAttempts/mkfsBusyRetryDelay bound a short retry around an
// mkfs/mkswap call that fails with "device or resource busy" immediately
// after Rescan. Rescan's udevadm settle waits for the kernel's udev EVENT
// QUEUE to drain, not for every worker process an event spawned (e.g. a
// blkid filesystem-probe rule firing on the newly-appeared partition
// device) to actually finish and release its fd — a narrow, genuine race,
// not merely "wait longer for the node to exist" (waitForPartitionDevices
// already confirms the node exists before this ever runs). Package vars so
// a test can shrink both. Found by the W04b QEMU end-to-end proof: a fresh
// target disk's first mkfs.vfat call reproduced this consistently (2/2)
// against a virtio-blk target under TCG emulation, where drastically
// slower emulated execution makes a normally sub-millisecond probe-worker
// window wide enough to lose the race.
var (
	mkfsBusyRetryAttempts = 5
	mkfsBusyRetryDelay    = 500 * time.Millisecond
)

// isDeviceBusyOutput reports whether out (an mkfs/mkswap command's
// stdout+stderr) is the specific "something else has this device node
// open" failure the retry above targets — never a generic non-zero exit,
// which could mean anything from a malformed filesystem UUID to a
// genuinely wrong device and must keep failing provision immediately.
func isDeviceBusyOutput(out []byte) bool {
	s := strings.ToLower(string(out))
	return strings.Contains(s, "device or resource busy") ||
		strings.Contains(s, "resource busy") ||
		// e2fsprogs' own safety check (mkfs.ext4/mkfs.xfs) phrases the
		// identical "something else still has this partition open" race
		// differently from the kernel's EBUSY errno text — same root
		// cause the mkfs.vfat case above was found with (a udev probe
		// worker's fd, or the kernel's own partition-table re-read, not
		// yet released when this runs), different tool, different words.
		// Found immediately after the vfat fix on the very next partition
		// in the same W04b QEMU run: mkfs.vfat on /dev/vda1 succeeded via
		// the retry above, then mkfs.ext4 on /dev/vda2 failed with this
		// exact message on the first attempt.
		strings.Contains(s, "apparently in use by the system")
}

// runMkfsWithBusyRetry runs one mkfs/mkswap invocation, retrying up to
// mkfsBusyRetryAttempts times (with mkfsBusyRetryDelay between attempts,
// cancellable via ctx) only while the failure is isDeviceBusyOutput — see
// that function and mkfsBusyRetryAttempts's doc comment. Any other failure,
// or exhausting the retry budget, returns immediately on the last attempt's
// output/error.
func runMkfsWithBusyRetry(ctx context.Context, sys System, name string, args ...string) ([]byte, error) {
	var out []byte
	var err error
	for attempt := 1; attempt <= mkfsBusyRetryAttempts; attempt++ {
		out, err = sys.Run(ctx, name, args...)
		if err == nil || !isDeviceBusyOutput(out) || attempt == mkfsBusyRetryAttempts {
			return out, err
		}
		select {
		case <-ctx.Done():
			return out, ctx.Err()
		case <-time.After(mkfsBusyRetryDelay):
		}
	}
	return out, err
}

// waitForPartitionDevices polls for every planned partition's device node
// to exist before any mkfs/mount touches it. sgdisk/partprobe tell the
// kernel about a new partition table; the /dev entry itself is materialized
// asynchronously by udev — proceeding before it exists is exactly how a
// "no such file or directory" mkfs/mount failure happens on a slow or
// udev-less host (see the CI loopback job).
func waitForPartitionDevices(ctx context.Context, r *run) error {
	if r.result.Plan == nil {
		return nil
	}
	deadline := time.Now().Add(partitionDeviceWaitTimeout)
	for _, p := range r.result.Plan.Partitions {
		if p.Filesystem == "" {
			continue // MSR-style partitions carry no filesystem and are never formatted/mounted
		}
		dev := r.sys.PartitionDevice(r.disk, p.Number)
		for !r.sys.Exists(dev) {
			if ctx != nil && ctx.Err() != nil {
				return ctx.Err()
			}
			if time.Now().After(deadline) {
				return fmt.Errorf("partition device %s did not appear within %s of rescan", dev, partitionDeviceWaitTimeout)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	return nil
}

// provision partitions and formats the target per r.result.Plan: sgdisk lays
// down the GPT (type + partition GUIDs so the restored fstab/GRUB config
// resolves unchanged), then each partition is formatted with the recorded
// filesystem UUID/label.
func provision(ctx context.Context, r *run) error {
	if err := r.attach(ctx); err != nil {
		return err
	}
	plan := r.result.Plan
	sector := int64(plan.SectorSize)
	if out, err := r.sys.Run(ctx, "sgdisk", "--zap-all", r.disk); err != nil {
		return fmt.Errorf("sgdisk --zap-all: %s: %w", strings.TrimSpace(string(out)), err)
	}
	for _, p := range plan.Partitions {
		startSector := p.StartBytes / sector
		endSector := (p.StartBytes+p.SizeBytes)/sector - 1
		args := []string{fmt.Sprintf("--new=%d:%d:%d", p.Number, startSector, endSector)}
		if p.TypeGUID != "" {
			args = append(args, fmt.Sprintf("--typecode=%d:%s", p.Number, p.TypeGUID))
		}
		if p.PartUUID != "" {
			args = append(args, fmt.Sprintf("--partition-guid=%d:%s", p.Number, p.PartUUID))
		}
		if p.Name != "" {
			args = append(args, fmt.Sprintf("--change-name=%d:%s", p.Number, p.Name))
		}
		args = append(args, r.disk)
		if out, err := r.sys.Run(ctx, "sgdisk", args...); err != nil {
			return fmt.Errorf("sgdisk partition %d: %s: %w", p.Number, strings.TrimSpace(string(out)), err)
		}
	}
	if err := r.sys.Rescan(ctx, r.disk); err != nil {
		return err
	}
	if err := waitForPartitionDevices(ctx, r); err != nil {
		return err
	}
	for i, p := range plan.Partitions {
		dev := r.sys.PartitionDevice(r.disk, p.Number)
		var name string
		var args []string
		switch p.Filesystem {
		case "vfat", "fat32":
			name = "mkfs.vfat"
			args = []string{"-F", "32"}
			if id := strings.ReplaceAll(strings.ToUpper(p.FSUUID), "-", ""); len(id) == 8 {
				args = append(args, "-i", id)
			}
			if p.Label != "" {
				args = append(args, "-n", strings.ToUpper(p.Label))
			}
		case "ext4":
			name = "mkfs.ext4"
			args = []string{"-F", "-q"}
			if p.FSUUID != "" {
				args = append(args, "-U", p.FSUUID)
			}
			if p.Label != "" {
				args = append(args, "-L", p.Label)
			}
		case "xfs":
			name = "mkfs.xfs"
			args = []string{"-f", "-q"}
			if p.FSUUID != "" {
				args = append(args, "-m", "uuid="+p.FSUUID)
			}
			if p.Label != "" {
				args = append(args, "-L", p.Label)
			}
		case "swap":
			name = "mkswap"
			if p.FSUUID != "" {
				args = append(args, "-U", p.FSUUID)
			}
			if p.Label != "" {
				args = append(args, "-L", p.Label)
			}
		case "":
			continue // MSR-style partitions carry no filesystem
		default:
			return fmt.Errorf("unsupported filesystem %q reached provision (preflight bug)", p.Filesystem)
		}
		args = append(args, dev)
		if out, err := runMkfsWithBusyRetry(ctx, r.sys, name, args...); err != nil {
			return fmt.Errorf("%s %s: %s: %w", name, dev, strings.TrimSpace(string(out)), err)
		}
		r.progress(PhaseProvision, "formatted "+dev, int64(i+1), int64(len(plan.Partitions)))
	}
	return nil
}

// attach resolves r.disk: the block device itself, or a freshly attached
// loop device for an image target. Called both by provision() (first run)
// and reattach() (resume) — for TargetImage this ALWAYS performs a new
// losetup, never reuses a device path from a previous call, because a loop
// device does not survive across Run() calls (teardown always detaches it).
func (r *run) attach(ctx context.Context) error {
	switch r.opts.Target.Kind {
	case TargetDisk:
		r.disk = r.opts.Target.Path
	case TargetImage:
		dev, detach, err := r.sys.AttachImage(r.opts.Target.Path, r.opts.Target.ImageSizeBytes)
		if err != nil {
			return err
		}
		r.disk, r.detach = dev, detach
	}
	return nil
}

// reattach is used on resume: re-attach the target (always a fresh losetup
// for an image — see attach's doc comment — then a Rescan and a wait for
// the partition device nodes, since a resumed process's kernel/udev state
// is otherwise unknown; a disk target's real block device nodes need
// neither, they persist independently of this process) and mount the
// planned partitions without touching the partition table or filesystems.
func (r *run) reattach(ctx context.Context) error {
	if r.disk == "" {
		if err := r.attach(ctx); err != nil {
			return err
		}
		if r.opts.Target.Kind == TargetImage {
			if err := r.sys.Rescan(ctx, r.disk); err != nil {
				return err
			}
		}
		if err := waitForPartitionDevices(ctx, r); err != nil {
			return err
		}
	}
	if r.rootMount == "" && r.state.Completed[PhaseProvision] {
		return mountTree(ctx, r)
	}
	return nil
}
