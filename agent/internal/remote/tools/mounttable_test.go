package tools

import (
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestParseMountInfo(t *testing.T) {
	const sample = `22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw
23 22 0:21 / /proc rw,nosuid shared:2 - proc proc rw
40 22 8:1 / /mnt/old\040root rw,relatime shared:1 - ext4 /dev/sda1 rw
41 22 8:1 /var/lib/breeze /srv/agent\134data rw - ext4 /dev/sda1 rw
42 22 0:50 / /var/lib/docker/overlay2/abc/merged rw - overlay overlay rw
malformed line
`
	got := parseMountInfo(strings.NewReader(sample))
	want := []string{"/", "/proc", "/mnt/old root", `/srv/agent\data`, "/var/lib/docker/overlay2/abc/merged"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mount points = %q, want %q", got, want)
	}
}

// Every mount point is a volume top, including a bind mount that shares its
// device with its source.
func TestScanVolumeTopsComeFromTheMountTable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mounted folders are anchored by drive letter on Windows")
	}
	base := t.TempDir()
	vol := filepath.Join(base, "mnt", "x")
	shadow := filepath.Join(vol, "etc", "shadow")
	alike := filepath.Join(base, "other", "etc", "shadow")
	writeScanFixture(t, shadow, "x")
	writeScanFixture(t, alike, "x")
	canonicalVol := vol
	if resolved, ok := resolveForContainment(vol); ok {
		canonicalVol = resolved
	}
	orig := loadMountTable
	loadMountTable = func() ([]string, bool) { return []string{"/", canonicalVol}, true }
	t.Cleanup(func() { loadMountTable = orig })

	s := NewScanScope()
	r, err := s.CheckRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Skip(r, shadow, lstatT(t, shadow)) {
		t.Error("a protected file at the top of a mount point was not recognised")
	}
	if s.Skip(r, alike, lstatT(t, alike)) {
		t.Error("a name-alike folder away from any mount point was skipped")
	}
}

func TestVolumeTopIsTheLongestEnclosingMountPoint(t *testing.T) {
	table := []string{"/", "/mnt", "/mnt/x", "/mnt/xy"}
	for p, want := range map[string]string{
		"/mnt/x/etc/shadow":  "/mnt/x",
		"/mnt/xy/etc/shadow": "/mnt/xy",
		"/mnt/xz/etc":        "/mnt",
		"/etc/shadow":        "/",
		"/mnt/x":             "/mnt/x",
	} {
		if got := longestMountPoint(table, filepath.FromSlash(p)); filepath.ToSlash(got) != want {
			t.Errorf("%s: top = %q, want %q", p, got, want)
		}
	}
}
