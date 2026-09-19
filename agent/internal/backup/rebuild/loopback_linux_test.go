//go:build linux

package rebuild

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestRun_LoopbackRealSystem runs only as root with
// BREEZE_REBUILD_LOOP_TEST=1 (CI: a privileged step in the test-agent job;
// locally: sudo). It proves sgdisk/mkfs/mount/restore on a real loop device
// — boot is skipped (SkipBoot) because the synthetic root has no GRUB.
func TestRun_LoopbackRealSystem(t *testing.T) {
	if os.Getenv("BREEZE_REBUILD_LOOP_TEST") != "1" || os.Geteuid() != 0 {
		t.Skip("needs root and BREEZE_REBUILD_LOOP_TEST=1")
	}
	for _, tool := range []string{"sgdisk", "losetup", "mkfs.vfat", "mkfs.ext4", "partprobe", "blkid"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not installed", tool)
		}
	}
	dir := t.TempDir()
	lay := testLayout()
	// Shrink the source so a 3 GiB image is enough: EFI 64 MiB, boot 256 MiB, root used 512 MiB.
	d := &lay.Disks[0]
	d.Partitions[0].SizeBytes = 64 * MiB
	d.Partitions[1].SizeBytes = 256 * MiB
	d.Partitions[2].UsedBytes = 512 * MiB
	p := seedSnapshot(t, "loop-1", lay)
	img := filepath.Join(dir, "disk.img")
	res, err := Run(context.Background(), Options{SnapshotID: "loop-1", Provider: p, Target: Target{Kind: TargetImage, Path: img, ImageSizeBytes: 3 * GiB}, Identity: IdentityNew, StateDir: dir, StagingRoot: filepath.Join(dir, "mnt"), SkipBoot: true})
	if err != nil {
		t.Fatalf("run: %v\n%+v", err, res)
	}
	dev, detach, err := NewSystem().AttachImage(img, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = detach() }()
	out, _ := exec.Command("blkid", "-o", "export", partitionDevice(dev, 3)).CombinedOutput()
	if !strings.Contains(string(out), "UUID="+testRootFSUUID) || !strings.Contains(string(out), "TYPE=ext4") {
		t.Fatalf("root partition: %s", out)
	}
	out, _ = exec.Command("blkid", "-o", "export", partitionDevice(dev, 1)).CombinedOutput()
	if !strings.Contains(string(out), "UUID=ABCD-1234") || !strings.Contains(string(out), "TYPE=vfat") {
		t.Fatalf("efi partition: %s", out)
	}
	mnt := filepath.Join(dir, "verify")
	if err := os.MkdirAll(mnt, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("mount", partitionDevice(dev, 3), mnt).CombinedOutput(); err != nil {
		t.Fatalf("mount: %s", out)
	}
	defer func() { _ = exec.Command("umount", mnt).Run() }()
	if b, err := os.ReadFile(filepath.Join(mnt, "etc", "hostname")); err != nil || string(b) != "srv-1-restored\n" {
		t.Fatalf("hostname = %q err=%v", b, err)
	}
	if got, err := os.Readlink(filepath.Join(mnt, "bin")); err != nil || got != "usr/bin" {
		t.Fatalf("symlink = %q err=%v", got, err)
	}
}
