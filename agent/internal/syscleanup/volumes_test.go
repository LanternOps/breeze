package syscleanup

import (
	"errors"
	"testing"

	"github.com/shirou/gopsutil/v3/disk"
)

// Freed bytes are MEASURED, never estimated (spec §7.1): the sum over affected
// volumes of free-after minus free-before, floored at 0.
func TestMeasureFreedSumsPositiveDeltasOnly(t *testing.T) {
	before := []VolumeFree{{Mount: "/", FreeBytes: 1_000}, {Mount: "/data", FreeBytes: 500}}
	after := []VolumeFree{{Mount: "/", FreeBytes: 4_000}, {Mount: "/data", FreeBytes: 500}}

	deltas, freed := measureFreed(before, after)
	if freed != 3_000 {
		t.Fatalf("freed = %d, want 3000", freed)
	}
	if len(deltas) != 2 {
		t.Fatalf("len(deltas) = %d, want 2", len(deltas))
	}
	if deltas[0] != (VolumeDelta{Mount: "/", FreeBefore: 1_000, FreeAfter: 4_000}) {
		t.Fatalf("deltas[0] = %+v", deltas[0])
	}
}

// A volume that LOST space during the run (a concurrent download, a log burst)
// must not subtract from the reported total — that would understate the real
// reclamation and, with a large enough write, report a negative number.
func TestMeasureFreedFloorsANegativeDeltaAtZero(t *testing.T) {
	before := []VolumeFree{{Mount: "/", FreeBytes: 1_000}, {Mount: "/data", FreeBytes: 9_000}}
	after := []VolumeFree{{Mount: "/", FreeBytes: 3_000}, {Mount: "/data", FreeBytes: 1_000}}

	deltas, freed := measureFreed(before, after)
	if freed != 2_000 {
		t.Fatalf("freed = %d, want 2000 (the /data regression contributes 0, not -8000)", freed)
	}
	if deltas[1].FreeAfter != 1_000 {
		t.Fatalf("the regression must still be REPORTED per volume; deltas[1] = %+v", deltas[1])
	}
}

// A volume present in one sample and not the other is dropped rather than
// treated as a delta against zero — unmounting a disk mid-run would otherwise
// be reported as reclaiming its entire free space.
func TestMeasureFreedIgnoresAVolumeMissingFromEitherSample(t *testing.T) {
	before := []VolumeFree{{Mount: "/", FreeBytes: 1_000}, {Mount: "/media", FreeBytes: 800_000}}
	after := []VolumeFree{{Mount: "/", FreeBytes: 1_500}}

	deltas, freed := measureFreed(before, after)
	if freed != 500 {
		t.Fatalf("freed = %d, want 500", freed)
	}
	if len(deltas) != 1 || deltas[0].Mount != "/" {
		t.Fatalf("deltas = %+v, want only the volume present in both samples", deltas)
	}
}

func TestSampleVolumesSkipsUnreadableMounts(t *testing.T) {
	original := usageFreeFn
	t.Cleanup(func() { usageFreeFn = original })
	usageFreeFn = func(mount string) (int64, error) {
		if mount == "/broken" {
			return 0, errors.New("permission denied")
		}
		return 42, nil
	}

	got := sampleVolumes([]string{"/", "/broken", "/data"})
	if len(got) != 2 {
		t.Fatalf("sampleVolumes() = %+v, want the two readable mounts", got)
	}
	if got[0].Mount != "/" || got[1].Mount != "/data" || got[0].FreeBytes != 42 {
		t.Fatalf("sampleVolumes() = %+v", got)
	}
}

// A btrfs host commonly bind-mounts many subvolumes of the SAME backing
// device (e.g. an OrbStack Ubuntu VM observed 228 such mounts — issue #6483).
// Each bind mount is a distinct Mountpoint but shares one Device, so counting
// every mountpoint blows the API's 64-volume cap and the catalog comes back
// as a 502 "unreadable" on the panel. fixedVolumes must collapse repeats of
// the same device down to a single representative mount.
func TestFixedVolumesDedupesBindMountsOfTheSameDevice(t *testing.T) {
	original := partitionsFn
	t.Cleanup(func() { partitionsFn = original })

	partitions := []disk.PartitionStat{
		{Device: "/dev/sda2", Mountpoint: "/", Fstype: "btrfs"},
	}
	// 227 additional bind mounts of the same backing device under distinct
	// subvolume paths, as btrfs bind-mounts subvolumes.
	for i := 0; i < 227; i++ {
		partitions = append(partitions, disk.PartitionStat{
			Device:     "/dev/sda2",
			Mountpoint: "/var/lib/docker/btrfs/subvolumes/vol" + string(rune('a'+i%26)) + string(rune('0'+i/26)),
			Fstype:     "btrfs",
		})
	}
	// A genuinely distinct volume must still be reported.
	partitions = append(partitions, disk.PartitionStat{Device: "/dev/sdb1", Mountpoint: "/data", Fstype: "ext4"})

	partitionsFn = func(all bool) ([]disk.PartitionStat, error) {
		return partitions, nil
	}

	got := fixedVolumes()
	if len(got) != 2 {
		t.Fatalf("fixedVolumes() returned %d mounts, want 2 (one per distinct device) — got %v", len(got), got)
	}
	// Identity, not just count: the /dev/sda2 group must be represented by
	// the FIRST mount seen for that device ("/"), and /data must survive as
	// its own distinct device. A regression that instead kept the LAST bind
	// mount seen for /dev/sda2 would still pass a count-only assertion.
	if got[0] != "/" || got[1] != "/data" {
		t.Fatalf("fixedVolumes() = %v, want [\"/\" \"/data\"]", got)
	}
}

// A partition with no Device (some virtual/synthetic mounts report an empty
// string) must not collapse into other empty-Device mounts — dedupe only
// applies when we have a real device identity to key on.
func TestFixedVolumesKeepsDistinctMountsWithoutADevice(t *testing.T) {
	original := partitionsFn
	t.Cleanup(func() { partitionsFn = original })

	partitionsFn = func(all bool) ([]disk.PartitionStat, error) {
		return []disk.PartitionStat{
			{Device: "", Mountpoint: "/mnt/a", Fstype: "ext4"},
			{Device: "", Mountpoint: "/mnt/b", Fstype: "ext4"},
		}, nil
	}

	got := fixedVolumes()
	if len(got) != 2 {
		t.Fatalf("fixedVolumes() = %v, want both no-device mounts kept", got)
	}
}

// A non-measurable partition (e.g. an overlay/tmpfs mount) sharing a Device
// with a later, measurable partition must not "use up" that device: the
// skip check happens before the device is recorded as seen, so the
// measurable mount on the same device is still reported.
func TestFixedVolumesSkippedFsTypeDoesNotBlockLaterSameDeviceMount(t *testing.T) {
	original := partitionsFn
	t.Cleanup(func() { partitionsFn = original })

	partitionsFn = func(all bool) ([]disk.PartitionStat, error) {
		return []disk.PartitionStat{
			{Device: "/dev/sda2", Mountpoint: "/var/lib/docker/overlay2/abc/merged", Fstype: "overlay"},
			{Device: "/dev/sda2", Mountpoint: "/", Fstype: "ext4"},
		}, nil
	}

	got := fixedVolumes()
	if len(got) != 1 || got[0] != "/" {
		t.Fatalf("fixedVolumes() = %v, want [\"/\"] (the overlay mount must be skipped, not consume the device)", got)
	}
}
