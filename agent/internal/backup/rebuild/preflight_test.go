package rebuild

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeviceBelongsTo(t *testing.T) {
	for _, tt := range []struct {
		disk, dev string
		want      bool
	}{
		{"/dev/sda", "/dev/sda1", true},
		{"/dev/sda", "/dev/sdaa1", false},
		{"/dev/nvme0n1", "/dev/nvme0n1p2", true},
		{"/dev/nvme0n1", "/dev/nvme0n10", false},
		{"/dev/loop0", "/dev/loop0p1", true},
		{"/dev/sda", "/dev/sda", true},
	} {
		if got := deviceBelongsTo(tt.disk, tt.dev); got != tt.want {
			t.Errorf("deviceBelongsTo(%q, %q) = %v, want %v", tt.disk, tt.dev, got, tt.want)
		}
	}
}

// vhdxOptions seeds a snapshot the same way engine_test's full-flow tests
// do and points the engine at a vhdx target under dir.
func vhdxOptions(t *testing.T, dir string, sys *fakeSystem) Options {
	t.Helper()
	p := seedSnapshot(t, "snap-vhdx", testLayout())
	return Options{
		SnapshotID: "snap-vhdx", Provider: p,
		Target:   Target{Kind: TargetVHDX, Path: filepath.Join(dir, "out.vhdx"), ImageSizeBytes: 100 * GiB},
		Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), System: sys,
	}
}

func TestPreflight_VhdxRefusesWithoutQemuImg(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	sys.lookPathErr = map[string]error{"qemu-img": exec.ErrNotFound}
	res, err := Run(context.Background(), vhdxOptions(t, dir, sys))
	if err == nil {
		t.Fatalf("expected refusal, got %+v", res)
	}
	if res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, "qemu-img not installed on this host; install qemu-utils") || res.PhaseReached != PhasePreflight {
		t.Fatalf("res = %+v err=%v", res, err)
	}
	if sys.has("losetup") || sys.has("sgdisk") || sys.has("mkfs") {
		t.Fatalf("refusal must not write: %s", sys.dump())
	}
	if _, statErr := os.Stat(filepath.Join(dir, "out.vhdx.raw")); !os.IsNotExist(statErr) {
		t.Fatalf("refusal must not create the raw staging file (stat err=%v)", statErr)
	}
}

func TestPreflight_VhdxRefusesWhenFreeSpaceBelowOneAndHalfImage(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	sys.freeSpace = 10 * GiB
	opts := vhdxOptions(t, dir, sys)
	opts.Target.ImageSizeBytes = 8 * GiB // needs 12 GiB
	res, err := Run(context.Background(), opts)
	if err == nil {
		t.Fatalf("expected refusal, got %+v", res)
	}
	want := fmt.Sprintf("not enough free space for raw image plus VHDX: need %d, have %d", 12*GiB, 10*GiB)
	if res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, want) || res.PhaseReached != PhasePreflight {
		t.Fatalf("res = %+v err=%v", res, err)
	}
	if sys.has("losetup") || sys.has("sgdisk") || sys.has("mkfs") {
		t.Fatalf("refusal must not write: %s", sys.dump())
	}
}

func TestPreflight_VhdxRefusesWithoutImageSize(t *testing.T) {
	dir := t.TempDir()
	sys := newFakeSystem(dir, 100*GiB)
	opts := vhdxOptions(t, dir, sys)
	opts.Target.ImageSizeBytes = 0
	res, err := Run(context.Background(), opts)
	if err == nil || res == nil || res.Status != "refused" || !strings.Contains(res.Refusal, "vhdx target needs a size") {
		t.Fatalf("res = %+v err=%v", res, err)
	}
}
