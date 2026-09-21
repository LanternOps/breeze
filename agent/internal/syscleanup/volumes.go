package syscleanup

import (
	"sort"
	"strings"
	"time"

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
func fixedVolumes() []string {
	partitions, err := partitionsFn(false)
	if err != nil && len(partitions) == 0 {
		log.Warn("could not enumerate volumes for cleanup measurement", "error", err.Error())
		return nil
	}
	seen := make(map[string]bool, len(partitions))
	mounts := make([]string, 0, len(partitions))
	for _, partition := range partitions {
		if partition.Mountpoint == "" || seen[partition.Mountpoint] {
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
		seen[partition.Mountpoint] = true
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

// syncMountFn commits mount's pending filesystem transactions. Real
// implementation (Linux only — syncMount in volumes_linux.go) forces a
// syncfs(2); everywhere else it is a no-op. Indirected for tests.
var syncMountFn = syncMount

// settleAttempts and settleInterval bound how long settleVolumes waits for a
// lazy-reclaim filesystem to catch up before trusting a free-space reading
// (issue #6484 / W05 lab BUG-2): btrfs releases extents asynchronously on
// delete, so a single disk.Usage call taken immediately after a cleaner exits
// can still report the pre-delete free space and make a run that really freed
// 94 MB read as freedBytes=0. A forced sync plus a short bounded retry — not
// an unbounded wait — catches the common case without holding up every run on
// filesystems (ext4, APFS, NTFS) that already update immediately.
var settleAttempts = 5
var settleInterval = 300 * time.Millisecond

// sleepFn is time.Sleep, indirected so tests don't pay the real interval.
var sleepFn = time.Sleep

// settleVolumes samples free space for mounts, forcing a filesystem sync
// before each attempt and retrying until two consecutive readings agree per
// mount or the attempt budget is exhausted. It returns the LAST sample taken,
// which is at least as fresh as a single immediate read and — on a
// lazy-reclaim filesystem — usually catches the real delta the naive
// immediate sample misses.
func settleVolumes(mounts []string) []VolumeFree {
	if len(mounts) == 0 {
		return sampleVolumes(mounts)
	}

	syncMounts(mounts)
	sample := sampleVolumes(mounts)
	prev := freeByMount(sample)

	for attempt := 1; attempt < settleAttempts; attempt++ {
		sleepFn(settleInterval)
		syncMounts(mounts)
		next := sampleVolumes(mounts)
		nextByMount := freeByMount(next)
		stable := len(nextByMount) == len(prev)
		if stable {
			for mount, freeBytes := range nextByMount {
				if prevBytes, ok := prev[mount]; !ok || prevBytes != freeBytes {
					stable = false
					break
				}
			}
		}
		sample = next
		prev = nextByMount
		if stable {
			break
		}
	}
	return sample
}

func syncMounts(mounts []string) {
	for _, mount := range mounts {
		syncMountFn(mount)
	}
}

func freeByMount(samples []VolumeFree) map[string]int64 {
	out := make(map[string]int64, len(samples))
	for _, sample := range samples {
		out[sample.Mount] = sample.FreeBytes
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
