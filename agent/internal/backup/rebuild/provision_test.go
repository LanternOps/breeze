package rebuild

import (
	"context"
	"errors"
	"testing"
	"time"
)

// withFastMkfsRetry shrinks the retry delay to keep this test fast, and
// restores it afterward so other tests never see a modified package var.
func withFastMkfsRetry(t *testing.T) {
	t.Helper()
	orig := mkfsBusyRetryDelay
	mkfsBusyRetryDelay = time.Millisecond
	t.Cleanup(func() { mkfsBusyRetryDelay = orig })
}

// TestRunMkfsWithBusyRetry_RetriesOnDeviceBusyThenSucceeds is the red-first
// regression test for the W04b QEMU end-to-end finding: mkfs.vfat on a
// freshly-partitioned virtio-blk target failed twice in a row with "Device
// or resource busy" immediately after Rescan (udevadm settle) returned —
// see provision.go's mkfsBusyRetryAttempts doc comment. Reproduces the
// exact failure text via fakeSystem.failTimes, proves the retry recovers.
func TestRunMkfsWithBusyRetry_RetriesOnDeviceBusyThenSucceeds(t *testing.T) {
	withFastMkfsRetry(t)
	sys := newFakeSystem(t.TempDir(), 8<<30)
	sys.failTimes = map[string]*failTimesEntry{
		"mkfs.vfat": {
			remaining: 2,
			out:       []byte("mkfs.vfat: unable to open /dev/vda1: Device or resource busy"),
			err:       errors.New("exit status 1"),
		},
	}

	out, err := runMkfsWithBusyRetry(context.Background(), sys, "mkfs.vfat", "-F", "32", "/dev/vda1")
	if err != nil {
		t.Fatalf("runMkfsWithBusyRetry() error = %v, want nil after retrying past the busy window", err)
	}
	if len(out) != 0 {
		t.Errorf("out = %q, want empty (the eventual successful call)", out)
	}

	count := 0
	for _, c := range sys.cmds {
		if c == "mkfs.vfat -F 32 /dev/vda1" {
			count++
		}
	}
	if count != 3 {
		t.Errorf("mkfs.vfat was run %d times, want 3 (2 busy failures + 1 success)", count)
	}
}

// TestRunMkfsWithBusyRetry_RetriesOnExt4InUseThenSucceeds proves the same
// retry also recognizes mkfs.ext4's own phrasing of the identical race
// ("apparently in use by the system") — found immediately after the vfat
// fix above, on the very next partition of the same W04b QEMU run:
// mkfs.vfat on /dev/vda1 succeeded via the retry, then mkfs.ext4 on
// /dev/vda2 failed on its first attempt with this exact e2fsprogs message.
func TestRunMkfsWithBusyRetry_RetriesOnExt4InUseThenSucceeds(t *testing.T) {
	withFastMkfsRetry(t)
	sys := newFakeSystem(t.TempDir(), 8<<30)
	sys.failTimes = map[string]*failTimesEntry{
		"mkfs.ext4": {
			remaining: 1,
			out:       []byte("/dev/vda2 is apparently in use by the system; will not make a filesystem here!"),
			err:       errors.New("exit status 1"),
		},
	}

	_, err := runMkfsWithBusyRetry(context.Background(), sys, "mkfs.ext4", "-F", "-q", "/dev/vda2")
	if err != nil {
		t.Fatalf("runMkfsWithBusyRetry() error = %v, want nil after retrying past the busy window", err)
	}
}

// TestRunMkfsWithBusyRetry_DoesNotRetryOtherFailures proves the retry is
// scoped to the exact "device busy" signature — any other mkfs failure
// (a malformed FSUUID, a genuinely wrong/missing device, ...) must fail
// provision immediately, not silently retry and mask a real defect.
func TestRunMkfsWithBusyRetry_DoesNotRetryOtherFailures(t *testing.T) {
	withFastMkfsRetry(t)
	sys := newFakeSystem(t.TempDir(), 8<<30)
	sys.fail = map[string]error{
		"mkfs.ext4": errors.New("exit status 1"),
	}

	_, err := runMkfsWithBusyRetry(context.Background(), sys, "mkfs.ext4", "-F", "-q", "/dev/vda2")
	if err == nil {
		t.Fatal("expected an error for a non-busy mkfs failure")
	}

	count := 0
	for _, c := range sys.cmds {
		if c == "mkfs.ext4 -F -q /dev/vda2" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("mkfs.ext4 was run %d times, want 1 (no retry on a non-busy failure)", count)
	}
}

// TestRunMkfsWithBusyRetry_BoundedGivesUpAndReturnsLastError proves the
// retry does not loop forever: a device that stays busy past
// mkfsBusyRetryAttempts must still fail provision, with the last attempt's
// error surfaced.
func TestRunMkfsWithBusyRetry_BoundedGivesUpAndReturnsLastError(t *testing.T) {
	withFastMkfsRetry(t)
	sys := newFakeSystem(t.TempDir(), 8<<30)
	sys.failTimes = map[string]*failTimesEntry{
		"mkfs.vfat": {
			remaining: 1000, // never recovers
			out:       []byte("Device or resource busy"),
			err:       errors.New("exit status 1"),
		},
	}

	_, err := runMkfsWithBusyRetry(context.Background(), sys, "mkfs.vfat", "-F", "32", "/dev/vda1")
	if err == nil {
		t.Fatal("expected an error once the retry budget is exhausted")
	}

	count := 0
	for _, c := range sys.cmds {
		if c == "mkfs.vfat -F 32 /dev/vda1" {
			count++
		}
	}
	if count != mkfsBusyRetryAttempts {
		t.Errorf("mkfs.vfat was run %d times, want exactly mkfsBusyRetryAttempts=%d", count, mkfsBusyRetryAttempts)
	}
}
