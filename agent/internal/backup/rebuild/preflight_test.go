package rebuild

import "testing"

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
