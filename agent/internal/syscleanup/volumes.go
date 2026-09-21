package syscleanup

import (
	"sort"
	"strings"

	"github.com/shirou/gopsutil/v3/disk"
)

// VolumeFree is one volume's free space at a point in time.
type VolumeFree struct {
	Mount     string `json:"mount"`
	FreeBytes int64  `json:"freeBytes"`
}

// VolumeDelta is one volume's free space either side of a run (spec §7.3).
type VolumeDelta struct {
	Mount      string `json:"mount"`
	FreeBefore int64  `json:"freeBefore"`
	FreeAfter  int64  `json:"freeAfter"`
}

// usageFreeFn is disk.Usage's free field, indirected so measurement can be
// tested without a real filesystem. Mirrors the partitionsFn seam in
// internal/collectors/inventory.go.
var usageFreeFn = func(mount string) (int64, error) {
	usage, err := disk.Usage(mount)
	if err != nil {
		return 0, err
	}
	return int64(usage.Free), nil
}

var partitionsFn = disk.Partitions

// nonMeasurableFsTypes never carry reclaimable space, and sampling them costs
// a syscall per action. Kept deliberately short: a volume wrongly included only
// contributes a zero delta, while one wrongly excluded silently under-reports.
var nonMeasurableFsTypes = []string{
	"squashfs", "tmpfs", "devtmpfs", "devfs", "overlay", "iso9660", "udf", "cdfs", "proc", "sysfs", "autofs",
}

// fixedVolumes lists the mount points worth measuring on this host.
//
// Errors are swallowed to a partial list on purpose: gopsutil's Windows
// implementation returns the drives it DID enumerate alongside a non-fatal
// warnings aggregate (an empty card reader is enough to populate it), so
// treating any error as fatal would report zero volumes on a healthy machine —
// the same trap CollectDisks documents.
//
// Bind-mounted filesystems collapse to one representative mount per backing
// Device (issue #6483): a btrfs host commonly exposes one subvolume per bind
// mount under the SAME block device — an OrbStack Ubuntu VM observed 228 of
// them — and every one measures identical free space. Reporting each as a
// distinct volume both wastes syscalls and can blow past the API's fixed
// volume-count cap, turning the whole cleanup catalog into a 502. A partition
// with no Device (some virtual/synthetic mounts) is never deduped against
// another empty-Device partition, since there is no real identity to key on.
func fixedVolumes() []string {
	partitions, err := partitionsFn(false)
	if err != nil && len(partitions) == 0 {
		log.Warn("could not enumerate volumes for cleanup measurement", "error", err.Error())
		return nil
	}
	seenMounts := make(map[string]bool, len(partitions))
	seenDevices := make(map[string]bool, len(partitions))
	mounts := make([]string, 0, len(partitions))
	for _, partition := range partitions {
		if partition.Mountpoint == "" || seenMounts[partition.Mountpoint] {
			continue
		}
		skip := false
		for _, fsType := range nonMeasurableFsTypes {
			if strings.HasPrefix(strings.ToLower(partition.Fstype), fsType) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		if partition.Device != "" {
			if seenDevices[partition.Device] {
				continue
			}
			seenDevices[partition.Device] = true
		}
		seenMounts[partition.Mountpoint] = true
		mounts = append(mounts, partition.Mountpoint)
	}
	sort.Strings(mounts)
	return mounts
}

// sampleVolumes reads free space for each mount, skipping the ones that cannot
// be read rather than failing the whole measurement.
func sampleVolumes(mounts []string) []VolumeFree {
	out := make([]VolumeFree, 0, len(mounts))
	for _, mount := range mounts {
		free, err := usageFreeFn(mount)
		if err != nil {
			log.Debug("volume unreadable during cleanup measurement", "mount", mount, "error", err.Error())
			continue
		}
		out = append(out, VolumeFree{Mount: mount, FreeBytes: free})
	}
	return out
}

// measureFreed pairs two samples by mount point.
//
// Two deliberate asymmetries:
//   - a NEGATIVE delta contributes 0 to the total but is still reported per
//     volume. A concurrent download during a 90-minute DISM run must not turn
//     a real reclamation into a smaller — or negative — headline number, and
//     hiding the regression entirely would make the headline unexplainable.
//   - a mount present in only one sample is dropped. Unmounting a disk
//     mid-run would otherwise read as reclaiming all of its free space.
func measureFreed(before, after []VolumeFree) ([]VolumeDelta, int64) {
	afterByMount := make(map[string]int64, len(after))
	for _, volume := range after {
		afterByMount[volume.Mount] = volume.FreeBytes
	}

	deltas := make([]VolumeDelta, 0, len(before))
	var freed int64
	for _, volume := range before {
		freeAfter, ok := afterByMount[volume.Mount]
		if !ok {
			continue
		}
		deltas = append(deltas, VolumeDelta{
			Mount:      volume.Mount,
			FreeBefore: volume.FreeBytes,
			FreeAfter:  freeAfter,
		})
		if delta := freeAfter - volume.FreeBytes; delta > 0 {
			freed += delta
		}
	}
	return deltas, freed
}
