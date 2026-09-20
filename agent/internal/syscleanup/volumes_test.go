package syscleanup

import (
	"errors"
	"testing"
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
