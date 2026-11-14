package collectors

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/shirou/gopsutil/v3/disk"
)

// Mountinfo samples are trimmed to the lines that matter for the decision
// (root, the ostree writable mounts, /boot and a few virtual filesystems) and
// follow the kernel's /proc/self/mountinfo layout. Mount IDs and device
// numbers are illustrative.

// Fedora Silverblue / Kinoite / Bazzite with composefs (F41+), btrfs storage.
// util-linux 2.40+ shows the overlay layers as lowerdir+/datadir+.
const mountinfoSilverblueComposefs = `22 1 0:21 / / ro,relatime shared:1 - overlay composefs ro,seclabel,lowerdir+=/run/ostree/.private/cfsroot-lower,datadir+=/sysroot/ostree/repo/objects,redirect_dir=on,metacopy=on
23 22 0:5 / /dev rw,nosuid shared:2 - devtmpfs devtmpfs rw,seclabel,size=4096k,nr_inodes=1048576,mode=755
24 22 0:22 / /sys rw,nosuid,nodev,noexec,relatime shared:3 - sysfs sysfs rw,seclabel
25 22 0:23 / /proc rw,nosuid,nodev,noexec,relatime shared:4 - proc proc rw
26 22 0:24 / /run rw,nosuid,nodev shared:5 - tmpfs tmpfs rw,seclabel,size=3256412k,nr_inodes=819200,mode=755
40 22 0:35 /root /sysroot ro,relatime shared:6 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,discard=async,space_cache=v2,subvolid=256,subvol=/root
41 22 0:35 /root/ostree/deploy/fedora/deploy/1f0c4b2a9d.0/etc /etc rw,relatime shared:7 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,discard=async,space_cache=v2,subvolid=256,subvol=/root
42 22 0:35 /root/ostree/deploy/fedora/var /var rw,relatime shared:8 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,discard=async,space_cache=v2,subvolid=256,subvol=/root
43 42 0:35 /home /var/home rw,relatime shared:9 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,discard=async,space_cache=v2,subvolid=257,subvol=/home
44 22 259:2 / /boot rw,relatime shared:10 - ext4 /dev/nvme0n1p2 rw,seclabel
45 44 259:1 / /boot/efi rw,relatime shared:11 - vfat /dev/nvme0n1p1 rw,fmask=0077,dmask=0077,codepage=437,iocharset=ascii,shortname=winnt,errors=remount-ro
`

// Older util-linux / kernels render the same composefs root with a single
// lowerdir= list using the "::" data-only separator.
const mountinfoSilverblueComposefsLegacyOpts = `22 1 0:21 / / ro,relatime shared:1 - overlay composefs ro,seclabel,lowerdir=/run/ostree/.private/cfsroot-lower::/sysroot/ostree/repo/objects,redirect_dir=on,metacopy=on
40 22 0:35 /root /sysroot ro,relatime shared:6 - btrfs /dev/sda3 rw,seclabel,compress=zstd:1,space_cache=v2,subvolid=256,subvol=/root
42 22 0:35 /root/ostree/deploy/fedora/var /var rw,relatime shared:8 - btrfs /dev/sda3 rw,seclabel,compress=zstd:1,space_cache=v2,subvolid=256,subvol=/root
`

// Fedora CoreOS with composefs, xfs root partition, read-only /sysroot.
const mountinfoCoreOSComposefs = `25 1 0:23 / / ro,relatime shared:1 - overlay composefs ro,seclabel,lowerdir+=/run/ostree/.private/cfsroot-lower,datadir+=/sysroot/ostree/repo/objects,redirect_dir=on,metacopy=on
26 25 252:4 / /sysroot ro,relatime shared:2 - xfs /dev/vda4 rw,seclabel,attr2,inode64,logbufs=8,logbsize=32k,prjquota
27 25 252:4 /ostree/deploy/fedora-coreos/deploy/9a7e1c0b3f.0/etc /etc rw,relatime shared:3 - xfs /dev/vda4 rw,seclabel,attr2,inode64,logbufs=8,logbsize=32k,prjquota
28 25 252:4 /ostree/deploy/fedora-coreos/var /var rw,relatime shared:4 - xfs /dev/vda4 rw,seclabel,attr2,inode64,logbufs=8,logbsize=32k,prjquota
29 25 252:3 / /boot ro,nosuid,nodev,relatime shared:5 - ext4 /dev/vda3 rw,seclabel
`

// A bootc image (CentOS Stream / Fedora bootc) with composefs and a separate
// /var partition; /sysroot is not mounted in this namespace.
const mountinfoBootcSeparateVar = `30 1 0:27 / / ro,relatime shared:1 - overlay composefs ro,seclabel,lowerdir+=/run/ostree/.private/cfsroot-lower,datadir+=/sysroot/ostree/repo/objects,redirect_dir=on,metacopy=on
31 30 252:3 /ostree/deploy/default/deploy/77aa01.0/etc /etc rw,relatime shared:2 - xfs /dev/vda3 rw,seclabel,attr2,inode64
32 30 252:4 / /var rw,relatime shared:3 - xfs /dev/vda4 rw,seclabel,attr2,inode64
`

// ostree before composefs: / is a bind mount of the deployment on the real
// filesystem, so statfs("/") already reports real capacity.
const mountinfoOstreeNoComposefs = `25 1 252:4 /ostree/deploy/fedora-coreos/deploy/9a7e1c0b3f.0 / rw,relatime shared:1 - xfs /dev/vda4 rw,seclabel,attr2,inode64,prjquota
26 25 252:4 / /sysroot ro,relatime shared:2 - xfs /dev/vda4 rw,seclabel,attr2,inode64,prjquota
27 25 252:4 /ostree/deploy/fedora-coreos/var /var rw,relatime shared:3 - xfs /dev/vda4 rw,seclabel,attr2,inode64,prjquota
`

// Plain ext4 install (Ubuntu / Debian server).
const mountinfoExt4Root = `25 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw,errors=remount-ro
26 25 0:23 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw
27 25 0:24 / /run rw,nosuid,nodev,noexec,relatime shared:13 - tmpfs tmpfs rw,size=401876k,mode=755
28 25 8:1 / /boot/efi rw,relatime shared:14 - vfat /dev/sda1 rw,fmask=0077,dmask=0077
29 25 7:0 / /snap/core22/1380 ro,nodev,relatime shared:15 - squashfs /dev/loop0 ro,errors=continue
`

// Fedora Workstation / openSUSE style btrfs subvolumes.
const mountinfoBtrfsSubvolumes = `35 1 0:32 /root / rw,relatime shared:1 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,space_cache=v2,subvolid=256,subvol=/root
36 35 0:32 /home /home rw,relatime shared:2 - btrfs /dev/nvme0n1p3 rw,seclabel,compress=zstd:1,ssd,space_cache=v2,subvolid=257,subvol=/home
37 35 259:2 / /boot rw,relatime shared:3 - ext4 /dev/nvme0n1p2 rw,seclabel
`

// Agent running inside a Docker/Podman container: the overlay root has a
// writable upper layer, so statfs("/") reports the backing filesystem.
const mountinfoContainerOverlay = `611 540 0:52 / / rw,relatime master:310 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/ABC:/var/lib/docker/overlay2/l/DEF,upperdir=/var/lib/docker/overlay2/0123abcd/diff,workdir=/var/lib/docker/overlay2/0123abcd/work
612 611 0:55 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
613 611 0:56 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
620 611 8:1 /var/lib/docker/volumes/data/_data /var rw,relatime - ext4 /dev/sda1 rw
`

// A read-only overlay root (no upper layer) whose lower layer is a squashfs
// image: statfs("/") reports the image.
const mountinfoReadOnlyOverlayOnImage = `20 1 7:0 / /run/rootfs/lower ro,relatime shared:9 - squashfs /dev/loop0 ro
22 1 0:21 / / ro,relatime shared:1 - overlay overlay ro,lowerdir=/run/rootfs/lower:/run/rootfs/extra
40 22 8:3 / /var rw,relatime shared:6 - ext4 /dev/sda3 rw
`

// A read-only overlay root whose lower layer is a directory on ext4:
// statfs("/") already reports that ext4 filesystem, so / stays.
const mountinfoReadOnlyOverlayOnDisk = `20 1 8:2 / /media/base ro,relatime shared:9 - ext4 /dev/sda2 rw
22 1 0:21 / / ro,relatime shared:1 - overlay overlay ro,lowerdir=/media/base/rootfs
40 22 8:3 / /var rw,relatime shared:6 - ext4 /dev/sda3 rw
`

// An image root whose /var is RAM-backed: tmpfs is not storage, so / stays
// rather than reporting a near-empty RAM disk.
const mountinfoImageRootTmpfsVar = `22 1 7:0 / / ro,relatime shared:1 - squashfs /dev/loop0 ro
23 22 0:30 / /var rw,relatime shared:2 - tmpfs tmpfs rw,size=1048576k
24 22 0:31 / /etc rw,relatime shared:3 - overlay overlay rw,lowerdir=/usr/etc,upperdir=/run/etc/upper,workdir=/run/etc/work
`

// An erofs/squashfs image root with nothing writable mounted at a known spot.
const mountinfoImageRootNoFallback = `22 1 7:0 / / ro,relatime shared:1 - erofs /dev/loop0 ro,user_xattr,acl,cache_strategy=readaround
23 22 0:24 / /run rw,nosuid,nodev shared:5 - tmpfs tmpfs rw,mode=755
`

// /var exists but is itself an image; /etc is the writable choice.
const mountinfoImageVarEtcFallback = `22 1 7:0 / / ro,relatime shared:1 - squashfs /dev/loop0 ro
23 22 7:1 / /var ro,relatime shared:2 - erofs /dev/loop1 ro
24 22 8:2 /etc /etc rw,relatime shared:3 - ext4 /dev/sda2 rw
`

// Escaped characters (space = \040) in a mount point.
const mountinfoEscapedMountpoint = `25 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw
26 25 8:3 / /mnt/My\040Disk rw,relatime shared:2 - ext4 /dev/sda3 rw
`

// Stacked mounts on /: the last entry is the one the process sees.
const mountinfoStackedRoot = `1 0 0:2 / / rw - rootfs rootfs rw
22 1 0:21 / / ro,relatime shared:1 - overlay composefs ro,lowerdir+=/run/ostree/.private/cfsroot-lower,datadir+=/sysroot/ostree/repo/objects
40 22 8:3 / /sysroot ro,relatime shared:6 - ext4 /dev/sda3 rw
`

func TestResolveOSMountPoint(t *testing.T) {
	tests := []struct {
		name      string
		mountinfo string
		want      string
	}{
		{"silverblue composefs uses sysroot", mountinfoSilverblueComposefs, "/sysroot"},
		{"silverblue composefs legacy lowerdir syntax", mountinfoSilverblueComposefsLegacyOpts, "/sysroot"},
		{"coreos composefs uses sysroot", mountinfoCoreOSComposefs, "/sysroot"},
		{"bootc without sysroot falls back to var", mountinfoBootcSeparateVar, "/var"},
		{"ostree without composefs keeps root", mountinfoOstreeNoComposefs, "/"},
		{"ext4 root keeps root", mountinfoExt4Root, "/"},
		{"btrfs subvolume root keeps root", mountinfoBtrfsSubvolumes, "/"},
		{"container overlay with upper layer keeps root", mountinfoContainerOverlay, "/"},
		{"read-only overlay on an image uses var", mountinfoReadOnlyOverlayOnImage, "/var"},
		{"read-only overlay on a disk directory keeps root", mountinfoReadOnlyOverlayOnDisk, "/"},
		{"image root without a writable mount keeps root", mountinfoImageRootNoFallback, "/"},
		{"image var is skipped in favour of etc", mountinfoImageVarEtcFallback, "/etc"},
		{"tmpfs and overlay candidates are not storage", mountinfoImageRootTmpfsVar, "/"},
		{"stacked root uses the topmost mount", mountinfoStackedRoot, "/sysroot"},
		{"no root entry is unknown", "", ""},
		{"table without a root entry is unknown", "26 25 8:3 / /data rw - ext4 /dev/sda3 rw\n", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveOSMountPoint(mustParseMountInfo(t, tt.mountinfo))
			if got != tt.want {
				t.Fatalf("resolveOSMountPoint() = %q, want %q", got, tt.want)
			}
		})
	}
}

func mustParseMountInfo(t *testing.T, mountinfo string) []mountInfoEntry {
	t.Helper()
	entries, err := parseMountInfo(strings.NewReader(mountinfo))
	if err != nil {
		t.Fatalf("parseMountInfo: %v", err)
	}
	return entries
}

func TestParseMountInfo(t *testing.T) {
	entries := mustParseMountInfo(t, mountinfoSilverblueComposefs)
	if len(entries) != 11 {
		t.Fatalf("parsed %d entries, want 11", len(entries))
	}
	root := entries[0]
	if root.MountPoint != "/" || root.FSType != "overlay" || root.Source != "composefs" {
		t.Fatalf("root entry = %+v", root)
	}
	if !strings.Contains(root.SuperOptions, "datadir+=/sysroot/ostree/repo/objects") {
		t.Fatalf("root super options = %q", root.SuperOptions)
	}
	if got := entries[5]; got.MountPoint != "/sysroot" || got.FSType != "btrfs" || got.Source != "/dev/nvme0n1p3" {
		t.Fatalf("sysroot entry = %+v", got)
	}

	escaped := mustParseMountInfo(t, mountinfoEscapedMountpoint)
	if len(escaped) != 2 || escaped[1].MountPoint != "/mnt/My Disk" {
		t.Fatalf("escaped mount point = %+v", escaped)
	}

	// Malformed lines (no " - " separator, too few fields) are skipped
	// rather than aborting the parse.
	mixed := "garbage line\n25 1 8:2 / / rw - ext4 /dev/sda2 rw\n1 2 3 - x\n"
	parsed := mustParseMountInfo(t, mixed)
	if len(parsed) != 1 || parsed[0].MountPoint != "/" {
		t.Fatalf("mixed parse = %+v", parsed)
	}

	// A line past the scanner limit is a read error, not a short table.
	huge := "25 1 8:2 / / rw - ext4 /dev/sda2 rw\n26 25 0:40 / /x rw - overlay overlay rw,lowerdir=" +
		strings.Repeat("a", 2*1024*1024) + "\n"
	if _, err := parseMountInfo(strings.NewReader(huge)); err == nil {
		t.Fatal("parseMountInfo accepted a line over the scanner limit")
	}
}

func TestUnescapeMountInfo(t *testing.T) {
	tests := []struct{ in, want string }{
		{`/plain`, `/plain`},
		{`/My\040Disk`, `/My Disk`},
		{`/tab\011x`, "/tab\tx"},
		{`/nl\012x`, "/nl\nx"},
		{`/back\134slash`, `/back\slash`},
		{`/trunc\04`, `/trunc\04`},
		{`/notoctal\09x`, `/notoctal\09x`},
		{`/big\777`, `/big\777`},
		{`/utf8\303\251`, "/utf8é"},
		{`/end\`, `/end\`},
	}
	for _, tt := range tests {
		if got := unescapeMountInfo(tt.in); got != tt.want {
			t.Errorf("unescapeMountInfo(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestIsImageRoot(t *testing.T) {
	top := map[string]mountInfoEntry{
		"/run/lower": {MountPoint: "/run/lower", FSType: "erofs", Source: "/dev/loop0"},
		"/media":     {MountPoint: "/media", FSType: "ext4", Source: "/dev/sda2"},
	}
	tests := []struct {
		name string
		root mountInfoEntry
		want bool
	}{
		{"composefs source even with a transient upper", mountInfoEntry{FSType: "overlay", Source: "composefs", SuperOptions: "rw,lowerdir+=/a,upperdir=/run/x/upper,workdir=/run/x/work"}, true},
		{"data-only lower via datadir+", mountInfoEntry{FSType: "overlay", Source: "overlay", SuperOptions: "ro,lowerdir+=/hidden,datadir+=/sysroot/ostree/repo/objects"}, true},
		{"data-only lower via ::", mountInfoEntry{FSType: "overlay", Source: "overlay", SuperOptions: "ro,lowerdir=/hidden::/sysroot/ostree/repo/objects"}, true},
		{"upper-less overlay over an erofs mount", mountInfoEntry{FSType: "overlay", Source: "overlay", SuperOptions: "ro,lowerdir=/run/lower/root:/b"}, true},
		{"upper-less overlay via lowerdir+ over an erofs mount", mountInfoEntry{FSType: "overlay", Source: "overlay", SuperOptions: "ro,lowerdir+=/run/lower,lowerdir+=/b"}, true},
		{"upper-less overlay over an ext4 directory", mountInfoEntry{FSType: "overlay", Source: "overlay", SuperOptions: "ro,lowerdir=/media/rootfs"}, false},
		{"upper-less overlay over an unknown path", mountInfoEntry{FSType: "overlay", Source: "overlay", SuperOptions: "ro,lowerdir=/elsewhere"}, false},
		{"overlay with an upper layer", mountInfoEntry{FSType: "overlay", Source: "overlay", SuperOptions: "rw,lowerdir=/run/lower,upperdir=/u,workdir=/w"}, false},
		{"erofs root", mountInfoEntry{FSType: "erofs", Source: "/dev/loop0"}, true},
		{"ext4 root", mountInfoEntry{FSType: "ext4", Source: "/dev/sda2"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tt.root.MountPoint = "/"
			if got := isImageRoot(tt.root, top); got != tt.want {
				t.Fatalf("isImageRoot(%+v) = %v, want %v", tt.root, got, tt.want)
			}
		})
	}
}

func TestUsageWithRootFallback(t *testing.T) {
	original := diskUsageFn
	t.Cleanup(func() { diskUsageFn = original })
	var asked []string
	diskUsageFn = func(path string) (*disk.UsageStat, error) {
		asked = append(asked, path)
		if path == "/sysroot" {
			return nil, errors.New("permission denied")
		}
		return &disk.UsageStat{Path: path, UsedPercent: 42}, nil
	}

	usage, err := usageWithRootFallback("/sysroot")
	if err != nil || usage.Path != "/" || strings.Join(asked, ",") != "/sysroot,/" {
		t.Fatalf("fallback: usage=%+v err=%v asked=%v", usage, err, asked)
	}

	asked = nil
	diskUsageFn = func(path string) (*disk.UsageStat, error) {
		asked = append(asked, path)
		return nil, errors.New("statfs failed")
	}
	if _, err := usageWithRootFallback("/"); err == nil || len(asked) != 1 {
		t.Fatalf("root failure must be returned without a retry: err=%v asked=%v", err, asked)
	}
}

func TestIsImageFilesystem(t *testing.T) {
	tests := []struct {
		name  string
		entry mountInfoEntry
		want  bool
	}{
		{"erofs", mountInfoEntry{FSType: "erofs", Source: "/dev/loop0"}, true},
		{"squashfs", mountInfoEntry{FSType: "squashfs", Source: "/dev/loop0"}, true},
		{"cramfs", mountInfoEntry{FSType: "cramfs", Source: "/dev/mtdblock0"}, true},
		{"composefs fstype", mountInfoEntry{FSType: "composefs", Source: "composefs"}, true},
		{"overlay from composefs", mountInfoEntry{FSType: "overlay", Source: "composefs", SuperOptions: "ro,lowerdir+=/a"}, true},
		{"plain overlay is decided by isImageRoot", mountInfoEntry{FSType: "overlay", Source: "overlay", SuperOptions: "ro,lowerdir=/a:/b"}, false},
		{"ext4", mountInfoEntry{FSType: "ext4", Source: "/dev/sda2"}, false},
		{"btrfs", mountInfoEntry{FSType: "btrfs", Source: "/dev/sda3"}, false},
		{"xfs mounted read-only is still real storage", mountInfoEntry{FSType: "xfs", Source: "/dev/vda4", MountOptions: "ro,relatime"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isImageFilesystem(tt.entry); got != tt.want {
				t.Fatalf("isImageFilesystem(%+v) = %v, want %v", tt.entry, got, tt.want)
			}
		})
	}
}

func TestIsImagePartition(t *testing.T) {
	tests := []struct {
		fstype, device string
		want           bool
	}{
		{"erofs", "/dev/loop0", true},
		{"squashfs", "/dev/loop1", true},
		{"cramfs", "/dev/mtdblock0", true},
		{"overlay", "composefs", true},
		{"ext4", "/dev/sda2", false},
		{"btrfs", "/dev/nvme0n1p3", false},
		{"NTFS", "C:", false},
		{"apfs", "/dev/disk3s1", false},
	}
	for _, tt := range tests {
		if got := isImagePartition(tt.fstype, tt.device); got != tt.want {
			t.Errorf("isImagePartition(%q, %q) = %v, want %v", tt.fstype, tt.device, got, tt.want)
		}
	}
}

func TestLinuxOSMountPointReadsMountTable(t *testing.T) {
	original := mountInfoPath
	t.Cleanup(func() { mountInfoPath = original })

	path := t.TempDir() + "/mountinfo"
	if err := os.WriteFile(path, []byte(mountinfoSilverblueComposefs), 0o600); err != nil {
		t.Fatal(err)
	}
	mountInfoPath = path
	if got := linuxOSMountPoint(); got != "/sysroot" {
		t.Fatalf("linuxOSMountPoint() = %q, want /sysroot", got)
	}

	// An unreadable mount table leaves the identity unknown rather than
	// claiming / is the OS volume.
	mountInfoPath = path + ".missing"
	if got := linuxOSMountPoint(); got != "" {
		t.Fatalf("linuxOSMountPoint() with no mount table = %q, want empty", got)
	}

	// A table cut short by a read error is not trusted either: the entries
	// that decide the answer may be the ones that were lost.
	truncated := mountinfoSilverblueComposefs + "99 22 0:40 / /x rw - overlay overlay rw,lowerdir=" +
		strings.Repeat("a", 2*1024*1024) + "\n"
	if err := os.WriteFile(path, []byte(truncated), 0o600); err != nil {
		t.Fatal(err)
	}
	mountInfoPath = path
	if got := linuxOSMountPoint(); got != "" {
		t.Fatalf("linuxOSMountPoint() with a truncated table = %q, want empty", got)
	}
}

func TestOSVolumeFlag(t *testing.T) {
	boolPtr := func(b bool) *bool { return &b }
	tests := []struct {
		name                       string
		goos, systemDrive, osMount string
		mountPoint                 string
		want                       *bool
	}{
		{"windows system drive", "windows", "C:", "", "C:", boolPtr(true)},
		{"windows other drive", "windows", "C:", "", "D:", boolPtr(false)},
		{"windows without system drive is unknown", "windows", "", "", "C:", nil},
		{"linux os mount", "linux", "", "/sysroot", "/sysroot", boolPtr(true)},
		{"linux other mount", "linux", "", "/sysroot", "/boot", boolPtr(false)},
		{"linux root on a normal install", "linux", "", "/", "/", boolPtr(true)},
		{"linux unresolved is unknown", "linux", "", "", "/", nil},
		{"darwin stays unknown", "darwin", "", "", "/", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := osVolumeFlag(tt.goos, tt.systemDrive, tt.osMount, tt.mountPoint)
			switch {
			case tt.want == nil && got != nil:
				t.Fatalf("got %v, want nil", *got)
			case tt.want != nil && got == nil:
				t.Fatalf("got nil, want %v", *tt.want)
			case tt.want != nil && *got != *tt.want:
				t.Fatalf("got %v, want %v", *got, *tt.want)
			}
		})
	}
}
