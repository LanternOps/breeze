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

// deviceBusyRetryAttempts/deviceBusyRetryDelay bound a short retry around an
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
	deviceBusyRetryAttempts = 5
	deviceBusyRetryDelay    = 500 * time.Millisecond
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
		strings.Contains(s, "apparently in use by the system") ||
		// mount(8)'s own ambiguous phrasing of the same race one step
		// later: mountTree's first mount of a just-formatted partition
		// (restore_tree.go) hit this immediately after the mkfs fixes
		// above resolved provisioning — same underlying "something else
		// still has an open fd on this device node" cause, mount(8) just
		// cannot distinguish "genuinely already mounted" from "busy" in
		// its own error text either. Safe to treat as retryable here
		// specifically because mountTree mounts each planned partition
		// exactly once, in order, within a single provision→mount
		// sequence — nothing else in this run could have mounted it
		// first.
		strings.Contains(s, "already mounted or mount point busy") ||
		strings.Contains(s, "mount point busy") ||
		// sgdisk's OWN partition-creation failure carries no diagnostic
		// detail at all ("Could not create partition N from A to B") —
		// unlike mkfs/mount above, it never says WHY. Found on the same
		// W04b QEMU run, one step EARLIER than the mkfs case: sgdisk
		// --zap-all followed immediately by --new=1:... for the first
		// partition hit this consistently, before udevadm settle had
		// fully caught up with the just-cleared GPT. Broadened here
		// (rather than kept mkfs-only) because by the time this was
		// found, the identical race had already been confirmed at THREE
		// other points in the exact same provision→mount sequence
		// (mkfs.vfat, mkfs.ext4, mount) — sgdisk's turn was simply the
		// first place in program order it could show up, not a
		// coincidence. A genuinely malformed partition spec (bad
		// sectors, oversized request) would keep failing after
		// deviceBusyRetryAttempts retries and is exactly what should
		// still surface as a hard failure.
		strings.Contains(s, "could not create partition")
}

// runWithBusyRetry runs one mkfs/mkswap invocation, retrying up to
// deviceBusyRetryAttempts times (with deviceBusyRetryDelay between attempts,
// cancellable via ctx) only while the failure is isDeviceBusyOutput — see
// that function and deviceBusyRetryAttempts's doc comment. Any other failure,
// or exhausting the retry budget, returns immediately on the last attempt's
// output/error.
func runWithBusyRetry(ctx context.Context, sys System, name string, args ...string) ([]byte, error) {
	var out []byte
	var err error
	for attempt := 1; attempt <= deviceBusyRetryAttempts; attempt++ {
		out, err = sys.Run(ctx, name, args...)
		if err == nil || !isDeviceBusyOutput(out) || attempt == deviceBusyRetryAttempts {
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

// mountWithBusyRetry runs one Mount call, retrying up to
// deviceBusyRetryAttempts times (mirroring runWithBusyRetry) only
// while the returned error's text is isDeviceBusyOutput — mountTree's
// first mount of a just-formatted partition hit this immediately after
// the mkfs fixes above resolved provisioning (see isDeviceBusyOutput's
// mount(8) case). realSystem.Mount already formats its error as
// "mount %s %s: %s: %w" (system_linux.go), so err.Error() carries the
// same text isDeviceBusyOutput matches against mkfs/mkswap's raw output.
func mountWithBusyRetry(ctx context.Context, sys System, device, dir, fstype string, opts ...string) error {
	var err error
	for attempt := 1; attempt <= deviceBusyRetryAttempts; attempt++ {
		err = sys.Mount(ctx, device, dir, fstype, opts...)
		if err == nil || !isDeviceBusyOutput([]byte(err.Error())) || attempt == deviceBusyRetryAttempts {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(deviceBusyRetryDelay):
		}
	}
	return err
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
	if out, err := runWithBusyRetry(ctx, r.sys, "sgdisk", "--zap-all", r.disk); err != nil {
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
		if out, err := runWithBusyRetry(ctx, r.sys, "sgdisk", args...); err != nil {
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
		if out, err := runWithBusyRetry(ctx, r.sys, name, args...); err != nil {
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
