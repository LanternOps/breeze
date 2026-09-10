package rebuild

import (
	"context"
	"fmt"
	"strings"
)

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
		if out, err := r.sys.Run(ctx, name, args...); err != nil {
			return fmt.Errorf("%s %s: %s: %w", name, dev, strings.TrimSpace(string(out)), err)
		}
		r.progress(PhaseProvision, "formatted "+dev, int64(i+1), int64(len(plan.Partitions)))
	}
	return nil
}

// attach resolves r.disk: the block device itself, or the loop device for an image.
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
	r.state.Disk = r.disk
	return nil
}

// reattach is used on resume: attach (images) and mount the planned
// partitions without touching the partition table or filesystems.
func (r *run) reattach(ctx context.Context) error {
	if r.disk == "" {
		if err := r.attach(ctx); err != nil {
			return err
		}
	}
	if r.rootMount == "" && r.state.Completed[PhaseProvision] {
		return mountTree(ctx, r)
	}
	return nil
}
