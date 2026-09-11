package rebuild

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

var supportedFilesystems = map[string]bool{"vfat": true, "fat32": true, "ext4": true, "xfs": true, "swap": true}

// uuidPattern is what mkfs.ext4 -U / mkfs.xfs -m uuid= / mkswap -U actually
// accept: a real 8-4-4-4-12 hex UUID. vfatUUIDPattern is what mkfs.vfat -i
// accepts: the FAT volume id, 8 hex digits with an optional separating
// dash (the form layout captures it in, e.g. "ABCD-1234").
var (
	uuidPattern     = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	vfatUUIDPattern = regexp.MustCompile(`^[0-9A-Fa-f]{4}-?[0-9A-Fa-f]{4}$`)
)

// validateFSUUID checks a partition's recorded filesystem UUID against the
// shape mkfs actually accepts for fs. A malformed value reaches provision
// only after sgdisk has already written the partition table — at which
// point mkfs's own rejection ("could not parse UUID") aborts mid-provision
// with the target already wiped. Refusing here, before any write, is
// strictly better. An EMPTY uuid is fine (mkfs generates a fresh one) and
// only produces a warning, since the restored fstab's UUID= entry for that
// partition then won't resolve to anything on the rebuilt disk.
func validateFSUUID(number int, fs, uuid string) (warning string, err error) {
	if uuid == "" {
		return fmt.Sprintf("partition %d has no recorded UUID; fstab entries using UUID= for it will not resolve", number), nil
	}
	switch fs {
	case "vfat", "fat32":
		if !vfatUUIDPattern.MatchString(uuid) {
			return "", &RefusalError{Reason: fmt.Sprintf("partition %d filesystem UUID %q is not a valid vfat UUID (expected 4-4 hex, e.g. ABCD-1234)", number, uuid)}
		}
	case "ext4", "xfs", "swap":
		if !uuidPattern.MatchString(uuid) {
			return "", &RefusalError{Reason: fmt.Sprintf("partition %d filesystem UUID %q is not a valid %s UUID (expected 8-4-4-4-12 hex)", number, uuid, fs)}
		}
	}
	return "", nil
}

func alignUp(n, a int64) int64 { return (n + a - 1) / a * a }

// PlanPartitions lays the source disk's partitions onto a target of
// targetSizeBytes. Fixed partitions keep their recorded size; the last
// root/data partition absorbs the remainder (or shrinks to used×1.1 on a
// smaller target). Non-partition children (Kind != "") are ignored — the W01
// guard already refused layouts that depend on them.
func PlanPartitions(src *layout.Disk, targetSizeBytes int64, sectorSize int) (*Plan, error) {
	if src == nil {
		return nil, &RefusalError{Reason: "no source disk in layout"}
	}
	if sectorSize <= 0 {
		sectorSize = 512
	}
	var parts []layout.Partition
	for _, p := range src.Partitions {
		if p.Kind == "" && p.Number > 0 {
			parts = append(parts, p)
		}
	}
	if len(parts) == 0 {
		return nil, &RefusalError{Reason: "source disk has no partitions"}
	}
	growIdx := -1
	for i, p := range parts {
		if p.Role == layout.RoleRoot || p.Role == layout.RoleData {
			growIdx = i
		}
	}
	var warnings []string
	var fixed, growMin int64
	for i, p := range parts {
		fs := strings.ToLower(p.Filesystem)
		if fs != "" && !supportedFilesystems[fs] && p.Role != layout.RoleMSR {
			return nil, &RefusalError{Reason: fmt.Sprintf("partition %d filesystem %q is not supported by the Linux engine (vfat, ext4, xfs, swap)", p.Number, p.Filesystem)}
		}
		if fs != "" && p.Role != layout.RoleMSR {
			if w, err := validateFSUUID(p.Number, fs, p.FSUUID); err != nil {
				return nil, err
			} else if w != "" {
				warnings = append(warnings, w)
			}
		}
		if i == growIdx {
			growMin = int64(float64(p.UsedBytes) * 1.1)
			if growMin < GiB {
				growMin = GiB
			}
			continue
		}
		fixed += alignUp(p.SizeBytes, MiB)
	}
	plan := &Plan{SourceDisk: src.Name, SourceSizeBytes: src.SizeBytes, TargetSizeBytes: targetSizeBytes, SectorSize: sectorSize, MinimumBytes: fixed + growMin + 2*MiB, Warnings: warnings}
	if targetSizeBytes < plan.MinimumBytes {
		return nil, &RefusalError{Reason: fmt.Sprintf("target is too small: %d bytes available, %d bytes needed (fixed partitions %d + root data %d + GPT reserve)", targetSizeBytes, plan.MinimumBytes, fixed, growMin)}
	}
	usableEnd := targetSizeBytes - MiB
	cursor := MiB
	for i, p := range parts {
		size := alignUp(p.SizeBytes, MiB)
		grown := false
		if i == growIdx {
			// Everything after this partition is fixed; leave room for it.
			var after int64
			for _, q := range parts[i+1:] {
				after += alignUp(q.SizeBytes, MiB)
			}
			size = usableEnd - after - cursor
			grown = true
		}
		plan.Partitions = append(plan.Partitions, PlannedPartition{
			Number: p.Number, Role: p.Role, TypeGUID: p.TypeGUID, PartUUID: p.PartUUID, Name: p.Label,
			StartBytes: cursor, SizeBytes: size, Filesystem: strings.ToLower(p.Filesystem), FSUUID: p.FSUUID, Label: p.Label, MountPoint: p.MountPoint, Grown: grown,
		})
		cursor += size
	}
	if cursor > usableEnd {
		return nil, &RefusalError{Reason: fmt.Sprintf("target is too small: plan ends at %d bytes but only %d are usable", cursor, usableEnd)}
	}
	return plan, nil
}
