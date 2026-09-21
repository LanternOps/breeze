package syscleanup

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"
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

// Issue #6484 (W05 lab BUG-2): btrfs releases freed extents lazily, so a
// single disk.Usage read taken immediately after the cleaner exits can still
// see the pre-delete free space and report freedBytes=0 for a run that really
// deleted 94 MB. settleVolumes must force a filesystem sync and retry until
// the reading stabilizes (or its attempt budget runs out) instead of trusting
// the first sample.
func TestSettleVolumesRetriesUntilTheReadingStabilizes(t *testing.T) {
	originalUsage, originalSleep, originalSync := usageFreeFn, sleepFn, syncMountFn
	t.Cleanup(func() { usageFreeFn, sleepFn, syncMountFn = originalUsage, originalSleep, originalSync })

	var syncCalls int32
	syncMountFn = func(string) { atomic.AddInt32(&syncCalls, 1) }
	var sleeps int32
	sleepFn = func(time.Duration) { atomic.AddInt32(&sleeps, 1) }

	var call int32
	usageFreeFn = func(mount string) (int64, error) {
		n := atomic.AddInt32(&call, 1)
		if n == 1 {
			return 1_000, nil // stale: reads as if nothing was freed
		}
		return 1_094_000, nil // settled: the real ~94 MB delta is now visible
	}

	got := settleVolumes([]string{"/data"})
	if len(got) != 1 || got[0].FreeBytes != 1_094_000 {
		t.Fatalf("settleVolumes() = %+v, want the settled 1094000 reading, not the stale first sample", got)
	}
	if atomic.LoadInt32(&syncCalls) == 0 {
		t.Fatal("settleVolumes must force a filesystem sync before sampling, not just resample blind")
	}
	if atomic.LoadInt32(&sleeps) == 0 {
		t.Fatal("settleVolumes must wait between the stale and settled reads")
	}
}

// A reading that never changes (ext4/NTFS/APFS update free space immediately)
// must not pay the full retry budget — settleVolumes stops as soon as two
// consecutive samples agree.
func TestSettleVolumesStopsEarlyOnceStable(t *testing.T) {
	originalUsage, originalSleep, originalSync := usageFreeFn, sleepFn, syncMountFn
	t.Cleanup(func() { usageFreeFn, sleepFn, syncMountFn = originalUsage, originalSleep, originalSync })

	syncMountFn = func(string) {}
	var sleeps int32
	sleepFn = func(time.Duration) { atomic.AddInt32(&sleeps, 1) }
	usageFreeFn = func(mount string) (int64, error) { return 42, nil }

	got := settleVolumes([]string{"/"})
	if len(got) != 1 || got[0].FreeBytes != 42 {
		t.Fatalf("settleVolumes() = %+v, want {/, 42}", got)
	}
	if s := atomic.LoadInt32(&sleeps); s > 1 {
		t.Fatalf("settleVolumes slept %d times for an already-stable reading, want at most 1", s)
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
