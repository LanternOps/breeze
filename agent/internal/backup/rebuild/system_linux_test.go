//go:build linux

package rebuild

import "testing"

func TestPartitionDevice(t *testing.T) {
	for _, tt := range []struct {
		disk string
		n    int
		want string
	}{
		{"/dev/sda", 2, "/dev/sda2"},
		{"/dev/nvme0n1", 3, "/dev/nvme0n1p3"},
		{"/dev/loop0", 1, "/dev/loop0p1"},
		{"/dev/mmcblk0", 2, "/dev/mmcblk0p2"},
		{"/dev/vda", 1, "/dev/vda1"},
	} {
		if got := partitionDevice(tt.disk, tt.n); got != tt.want {
			t.Errorf("%s #%d = %s want %s", tt.disk, tt.n, got, tt.want)
		}
	}
}

func TestParseMountSources(t *testing.T) {
	in := "sysfs /sys sysfs rw 0 0\n/dev/sda2 / ext4 rw 0 0\n/dev/sda1 /boot/efi vfat rw 0 0\n"
	got := parseMountSources(in)
	if len(got) != 3 || got[1] != "/dev/sda2" || got[2] != "/dev/sda1" {
		t.Errorf("got %v", got)
	}
}
