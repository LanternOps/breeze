package security

import (
	"errors"
	"strings"
	"testing"
)

// lsblk -J -o NAME,TYPE,FSTYPE,MOUNTPOINT,MOUNTPOINTS fixtures (util-linux >= 2.37).

const lsblkPlainCryptRoot = `{"blockdevices":[
 {"name":"nvme0n1","type":"disk","fstype":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"nvme0n1p1","type":"part","fstype":"vfat","mountpoint":"/boot/efi","mountpoints":["/boot/efi"]},
  {"name":"nvme0n1p2","type":"part","fstype":"crypto_LUKS","mountpoint":null,"mountpoints":[null],"children":[
   {"name":"luks-root","type":"crypt","fstype":"ext4","mountpoint":"/","mountpoints":["/"]}
  ]}
 ]}
]}`

// Default Ubuntu/Debian encrypted install: ext4 on an LV inside a LUKS container.
const lsblkLvmOnLuksRoot = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"sda1","type":"part","fstype":"vfat","mountpoint":"/boot/efi","mountpoints":["/boot/efi"]},
  {"name":"sda2","type":"part","fstype":"ext4","mountpoint":"/boot","mountpoints":["/boot"]},
  {"name":"sda3","type":"part","fstype":"crypto_LUKS","mountpoint":null,"mountpoints":[null],"children":[
   {"name":"sda3_crypt","type":"crypt","fstype":"LVM2_member","mountpoint":null,"mountpoints":[null],"children":[
    {"name":"vgubuntu-root","type":"lvm","fstype":"ext4","mountpoint":"/","mountpoints":["/"]},
    {"name":"vgubuntu-swap_1","type":"lvm","fstype":"swap","mountpoint":"[SWAP]","mountpoints":["[SWAP]"]}
   ]}
  ]}
 ]}
]}`

const lsblkUnencryptedLvmRoot = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"sda1","type":"part","fstype":"ext4","mountpoint":"/boot","mountpoints":["/boot"]},
  {"name":"sda2","type":"part","fstype":"LVM2_member","mountpoint":null,"mountpoints":[null],"children":[
   {"name":"rhel-root","type":"lvm","fstype":"xfs","mountpoint":"/","mountpoints":["/"]},
   {"name":"rhel-home","type":"lvm","fstype":"xfs","mountpoint":"/home","mountpoints":["/home"]}
  ]}
 ]}
]}`

// Fedora-style btrfs on LUKS with subvolumes: lsblk's single MOUNTPOINT column
// names only one of the mounts; "/" is only visible in MOUNTPOINTS.
const lsblkBtrfsOnCryptRoot = `{"blockdevices":[
 {"name":"nvme0n1","type":"disk","fstype":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"nvme0n1p1","type":"part","fstype":"vfat","mountpoint":"/boot/efi","mountpoints":["/boot/efi"]},
  {"name":"nvme0n1p3","type":"part","fstype":"crypto_LUKS","mountpoint":null,"mountpoints":[null],"children":[
   {"name":"luks-7c1e","type":"crypt","fstype":"btrfs","mountpoint":"/home","mountpoints":["/home","/"]}
  ]}
 ]}
]}`

// Pre-2.37 lsblk: no MOUNTPOINTS column, null mountpoint on unmounted nodes.
const lsblkLegacyLvmOnLuksRoot = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":null,"mountpoint":null,"children":[
  {"name":"sda5","type":"part","fstype":"crypto_LUKS","mountpoint":null,"children":[
   {"name":"sda5_crypt","type":"crypt","fstype":"LVM2_member","mountpoint":null,"children":[
    {"name":"vg-root","type":"lvm","fstype":"ext4","mountpoint":"/"}
   ]}
  ]}
 ]}
]}`

// Plain partition root, with an unrelated encrypted data volume.
const lsblkPlainRootEncryptedData = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"sda1","type":"part","fstype":"ext4","mountpoint":"/","mountpoints":["/"]}
 ]},
 {"name":"sdb","type":"disk","fstype":"crypto_LUKS","mountpoint":null,"mountpoints":[null],"children":[
  {"name":"data","type":"crypt","fstype":"ext4","mountpoint":"/srv/data","mountpoints":["/srv/data"]}
 ]}
]}`

// ZFS-on-root: the pool member partition carries no mountpoint, datasets are
// not block devices, so "/" never appears in lsblk.
const lsblkZfsRoot = `{"blockdevices":[
 {"name":"nvme0n1","type":"disk","fstype":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"nvme0n1p1","type":"part","fstype":"vfat","mountpoint":"/boot/efi","mountpoints":["/boot/efi"]},
  {"name":"nvme0n1p3","type":"part","fstype":"zfs_member","mountpoint":null,"mountpoints":[null]}
 ]}
]}`

// md RAID1 root: lsblk repeats the md node under each member partition.
const lsblkMdRaidRoot = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"sda1","type":"part","fstype":"linux_raid_member","mountpoint":null,"mountpoints":[null],"children":[
   {"name":"md0","type":"raid1","fstype":"ext4","mountpoint":"/","mountpoints":["/"]}
  ]}
 ]},
 {"name":"sdb","type":"disk","fstype":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"sdb1","type":"part","fstype":"linux_raid_member","mountpoint":null,"mountpoints":[null],"children":[
   {"name":"md0","type":"raid1","fstype":"ext4","mountpoint":"/","mountpoints":["/"]}
  ]}
 ]}
]}`

// Synthetic: "/" reachable through one encrypted and one plain path. Root must
// not be reported protected unless every path to it is.
const lsblkMixedPathRoot = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":"linux_raid_member","mountpoint":null,"mountpoints":[null],"children":[
  {"name":"md0","type":"raid1","fstype":"ext4","mountpoint":"/","mountpoints":["/"]}
 ]},
 {"name":"sdb","type":"disk","fstype":"crypto_LUKS","mountpoint":null,"mountpoints":[null],"children":[
  {"name":"md0","type":"raid1","fstype":"ext4","mountpoint":"/","mountpoints":["/"]}
 ]}
]}`

// Same as lsblkMixedPathRoot with the encrypted path listed first, so the
// first "/" row seen is protected even though root is not.
const lsblkMixedPathRootEncryptedFirst = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":"crypto_LUKS","mountpoint":null,"mountpoints":[null],"children":[
  {"name":"md0","type":"raid1","fstype":"ext4","mountpoint":"/","mountpoints":["/"]}
 ]},
 {"name":"sdb","type":"disk","fstype":"linux_raid_member","mountpoint":null,"mountpoints":[null],"children":[
  {"name":"md0","type":"raid1","fstype":"ext4","mountpoint":"/","mountpoints":["/"]}
 ]}
]}`

// Pre-2.37 lsblk, btrfs on LUKS: the single MOUNTPOINT column names "/home",
// so "/" is only resolvable through the /proc/self/mounts source device.
const lsblkLegacyBtrfsOnCrypt = `{"blockdevices":[
 {"name":"nvme0n1","type":"disk","fstype":null,"mountpoint":null,"children":[
  {"name":"nvme0n1p3","type":"part","fstype":"crypto_LUKS","mountpoint":null,"children":[
   {"name":"luks-7c1e","type":"crypt","fstype":"btrfs","mountpoint":"/home"}
  ]}
 ]}
]}`

const lsblkLegacyBtrfsPlain = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":null,"mountpoint":null,"children":[
  {"name":"sda2","type":"part","fstype":"btrfs","mountpoint":"/home"}
 ]}
]}`

const procMountsBtrfsCrypt = `/dev/mapper/luks-7c1e /home btrfs rw,relatime,subvol=/home 0 0
/dev/mapper/luks-7c1e / btrfs rw,relatime,subvol=/root 0 0`

const procMountsBtrfsPlain = `/dev/sda2 /home btrfs rw,relatime,subvol=/@home 0 0
/dev/sda2 / btrfs rw,relatime,subvol=/@ 0 0`

const procMountsUnknownDevice = `/dev/root / ext4 rw,relatime 0 0`

// md0 reachable via a plain path, then an encrypted one, with no mountpoint
// in lsblk (root resolved via /proc/self/mounts): the source-device fallback
// must also require every path to be protected.
const lsblkMixedPathNoMount = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":"linux_raid_member","mountpoint":null,"children":[
  {"name":"md0","type":"raid1","fstype":"ext4","mountpoint":null}
 ]},
 {"name":"sdb","type":"disk","fstype":"crypto_LUKS","mountpoint":null,"children":[
  {"name":"md0","type":"raid1","fstype":"ext4","mountpoint":null}
 ]}
]}`

const procMountsMd0 = `/dev/md0 / ext4 rw,relatime 0 0`

// ZFS pool "rpool" whose vdevs sit on LUKS (dataset encryption off).
const lsblkZfsOnLuks = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":null,"label":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"sda3","type":"part","fstype":"crypto_LUKS","label":null,"mountpoint":null,"mountpoints":[null],"children":[
   {"name":"luks-a","type":"crypt","fstype":"zfs_member","label":"rpool","mountpoint":null,"mountpoints":[null]}
  ]}
 ]},
 {"name":"sdb","type":"disk","fstype":null,"label":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"sdb3","type":"part","fstype":"crypto_LUKS","label":null,"mountpoint":null,"mountpoints":[null],"children":[
   {"name":"luks-b","type":"crypt","fstype":"zfs_member","label":"rpool","mountpoint":null,"mountpoints":[null]}
  ]}
 ]}
]}`

// ZFS pool "rpool" mirrored across one LUKS vdev and one plain vdev.
const lsblkZfsHalfOnLuks = `{"blockdevices":[
 {"name":"sda","type":"disk","fstype":null,"label":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"sda3","type":"part","fstype":"crypto_LUKS","label":null,"mountpoint":null,"mountpoints":[null],"children":[
   {"name":"luks-a","type":"crypt","fstype":"zfs_member","label":"rpool","mountpoint":null,"mountpoints":[null]}
  ]}
 ]},
 {"name":"sdb","type":"disk","fstype":null,"label":null,"mountpoint":null,"mountpoints":[null],"children":[
  {"name":"sdb3","type":"part","fstype":"zfs_member","label":"rpool","mountpoint":null,"mountpoints":[null]}
 ]}
]}`

const procMountsExt4 = `sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
/dev/mapper/vgubuntu-root / ext4 rw,relatime,errors=remount-ro 0 0
/dev/sda2 /boot ext4 rw,relatime 0 0`

const procMountsZfs = `sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
rpool/ROOT/ubuntu_abc123 / zfs rw,relatime,xattr,posixacl 0 0
bpool/BOOT/ubuntu_abc123 /boot zfs rw,relatime 0 0`

// An overlay remount of "/" later in the table is the effective root mount.
const procMountsZfsShadowedByOverlay = procMountsZfs + `
overlay / overlay rw,relatime 0 0`

func zfsPropsFixture(out string) func(string) (string, error) {
	return func(dataset string) (string, error) {
		if dataset != "rpool/ROOT/ubuntu_abc123" {
			return "", errors.New("unexpected dataset " + dataset)
		}
		return out, nil
	}
}

func noZfs(string) (string, error) {
	return "", errors.New("zfs must not be queried for a non-zfs root")
}

func TestEvaluateLinuxEncryptionRoot(t *testing.T) {
	tests := []struct {
		name          string
		lsblk         string
		mounts        string
		zfs           func(string) (string, error)
		wantProtected bool
		wantRootErr   string // substring; empty = no error
		wantRootVol   map[string]any
		wantNoKeys    []string // keys that must be absent from the root volume
	}{
		{
			name:          "plain crypt root",
			lsblk:         lsblkPlainCryptRoot,
			mounts:        procMountsExt4,
			zfs:           noZfs,
			wantProtected: true,
			wantRootVol:   map[string]any{"mount": "/", "device": "luks-root", "method": "luks", "protected": true},
		},
		{
			name:          "lvm on luks root",
			lsblk:         lsblkLvmOnLuksRoot,
			mounts:        procMountsExt4,
			zfs:           noZfs,
			wantProtected: true,
			wantRootVol:   map[string]any{"mount": "/", "device": "vgubuntu-root", "method": "luks", "protected": true},
		},
		{
			name:          "lvm on luks root, legacy lsblk without MOUNTPOINTS",
			lsblk:         lsblkLegacyLvmOnLuksRoot,
			mounts:        procMountsExt4,
			zfs:           noZfs,
			wantProtected: true,
			wantRootVol:   map[string]any{"mount": "/", "device": "vg-root", "method": "luks", "protected": true},
		},
		{
			name:          "unencrypted lvm root",
			lsblk:         lsblkUnencryptedLvmRoot,
			mounts:        procMountsExt4,
			zfs:           noZfs,
			wantProtected: false,
			wantRootVol:   map[string]any{"mount": "/", "device": "rhel-root", "method": "none", "protected": false},
		},
		{
			name:          "btrfs on crypt with subvolume mounts",
			lsblk:         lsblkBtrfsOnCryptRoot,
			mounts:        procMountsExt4,
			zfs:           noZfs,
			wantProtected: true,
			wantRootVol:   map[string]any{"mount": "/", "device": "luks-7c1e", "method": "luks", "protected": true},
		},
		{
			name:          "plain root with encrypted data disk is not encrypted",
			lsblk:         lsblkPlainRootEncryptedData,
			mounts:        procMountsExt4,
			zfs:           noZfs,
			wantProtected: false,
			wantRootVol:   map[string]any{"mount": "/", "device": "sda1", "method": "none", "protected": false},
		},
		{
			name:          "md raid root listed under both members",
			lsblk:         lsblkMdRaidRoot,
			mounts:        procMountsExt4,
			zfs:           noZfs,
			wantProtected: false,
			wantRootVol:   map[string]any{"mount": "/", "device": "md0", "method": "none", "protected": false},
		},
		{
			name:          "root reachable via encrypted and plain paths is not protected",
			lsblk:         lsblkMixedPathRoot,
			mounts:        procMountsExt4,
			zfs:           noZfs,
			wantProtected: false,
			wantRootVol:   map[string]any{"mount": "/", "device": "md0", "method": "none", "protected": false},
		},
		{
			name:          "mixed paths with encrypted path first keeps root unprotected",
			lsblk:         lsblkMixedPathRootEncryptedFirst,
			mounts:        procMountsExt4,
			zfs:           noZfs,
			wantProtected: false,
			wantRootVol:   map[string]any{"mount": "/", "device": "md0", "method": "none", "protected": false},
		},
		{
			name:          "legacy lsblk btrfs on crypt resolved via root source device",
			lsblk:         lsblkLegacyBtrfsOnCrypt,
			mounts:        procMountsBtrfsCrypt,
			zfs:           noZfs,
			wantProtected: true,
			wantRootVol:   map[string]any{"mount": "/", "device": "luks-7c1e", "method": "luks", "protected": true},
		},
		{
			name:          "legacy lsblk plain btrfs resolved via root source device",
			lsblk:         lsblkLegacyBtrfsPlain,
			mounts:        procMountsBtrfsPlain,
			zfs:           noZfs,
			wantProtected: false,
			wantRootVol:   map[string]any{"mount": "/", "device": "sda2", "method": "none", "protected": false},
		},
		{
			name:          "root source device reachable via plain and encrypted paths is not protected",
			lsblk:         lsblkMixedPathNoMount,
			mounts:        procMountsMd0,
			zfs:           noZfs,
			wantProtected: false,
			wantRootVol:   map[string]any{"mount": "/", "device": "md0", "method": "none", "protected": false},
		},
		{
			name:        "root source device absent from lsblk yields unknown",
			lsblk:       lsblkLegacyBtrfsPlain,
			mounts:      procMountsUnknownDevice,
			zfs:         noZfs,
			wantRootErr: "/dev/root",
		},
		{
			name:          "zfs root on luks vdevs with native encryption off",
			lsblk:         lsblkZfsOnLuks,
			mounts:        procMountsZfs,
			zfs:           zfsPropsFixture("encryption\toff\nkeystatus\t-\n"),
			wantProtected: true,
			wantRootVol:   map[string]any{"mount": "/", "device": "rpool/ROOT/ubuntu_abc123", "method": "luks", "protected": true, "encryption": "off"},
			wantNoKeys:    []string{"status"},
		},
		{
			name:          "zfs root with only some vdevs on luks is not protected",
			lsblk:         lsblkZfsHalfOnLuks,
			mounts:        procMountsZfs,
			zfs:           zfsPropsFixture("encryption\toff\nkeystatus\t-\n"),
			wantProtected: false,
			wantRootVol:   map[string]any{"mount": "/", "device": "rpool/ROOT/ubuntu_abc123", "method": "none", "protected": false},
		},
		{
			name:        "zfs without encryption support (pre-0.8) yields unknown",
			lsblk:       lsblkZfsRoot,
			mounts:      procMountsZfs,
			zfs:         zfsPropsFixture("encryption\t-\nkeystatus\t-\n"),
			wantRootErr: "encryption property",
		},
		{
			name:          "zfs root natively encrypted",
			lsblk:         lsblkZfsRoot,
			mounts:        procMountsZfs,
			zfs:           zfsPropsFixture("encryption\taes-256-gcm\nkeystatus\tavailable\n"),
			wantProtected: true,
			wantRootVol:   map[string]any{"mount": "/", "device": "rpool/ROOT/ubuntu_abc123", "method": "zfs", "protected": true, "status": "available", "encryption": "aes-256-gcm"},
		},
		{
			name:          "zfs root encrypted with key unavailable",
			lsblk:         lsblkZfsRoot,
			mounts:        procMountsZfs,
			zfs:           zfsPropsFixture("encryption\taes-256-gcm\nkeystatus\tunavailable\n"),
			wantProtected: true,
			wantRootVol:   map[string]any{"mount": "/", "device": "rpool/ROOT/ubuntu_abc123", "method": "zfs", "protected": true, "status": "unavailable", "encryption": "aes-256-gcm"},
		},
		{
			name:          "zfs root encryption off",
			lsblk:         lsblkZfsRoot,
			mounts:        procMountsZfs,
			zfs:           zfsPropsFixture("encryption\toff\nkeystatus\t-\n"),
			wantProtected: false,
			wantRootVol:   map[string]any{"mount": "/", "device": "rpool/ROOT/ubuntu_abc123", "method": "none", "protected": false, "encryption": "off"},
			wantNoKeys:    []string{"status"},
		},
		{
			name:        "zfs query fails yields unknown, not unencrypted",
			lsblk:       lsblkZfsRoot,
			mounts:      procMountsZfs,
			zfs:         func(string) (string, error) { return "", errors.New("zfs: command not found") },
			wantRootErr: "zfs",
		},
		{
			name:        "zfs output missing encryption property yields unknown",
			lsblk:       lsblkZfsRoot,
			mounts:      procMountsZfs,
			zfs:         zfsPropsFixture("keystatus\tavailable\n"),
			wantRootErr: "encryption property",
		},
		{
			name:        "root not in lsblk and not zfs yields unknown",
			lsblk:       lsblkZfsRoot,
			mounts:      procMountsZfsShadowedByOverlay,
			zfs:         noZfs,
			wantRootErr: "root filesystem",
		},
		{
			name:        "root not in lsblk and mounts unreadable yields unknown",
			lsblk:       lsblkZfsRoot,
			mounts:      "",
			zfs:         noZfs,
			wantRootErr: "root filesystem",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			report, err := evaluateLinuxEncryption(tt.lsblk, tt.mounts, tt.zfs)
			if err != nil {
				t.Fatalf("evaluateLinuxEncryption returned error: %v", err)
			}
			if tt.wantRootErr != "" {
				if report.RootErr == nil || !strings.Contains(report.RootErr.Error(), tt.wantRootErr) {
					t.Fatalf("RootErr = %v, want error containing %q", report.RootErr, tt.wantRootErr)
				}
				if encryptionString(report.RootProtected, report.RootErr) != "unknown" {
					t.Fatalf("headline must be unknown when root cannot be resolved")
				}
				return
			}
			if report.RootErr != nil {
				t.Fatalf("unexpected RootErr: %v", report.RootErr)
			}
			if report.RootProtected != tt.wantProtected {
				t.Fatalf("RootProtected = %v, want %v", report.RootProtected, tt.wantProtected)
			}

			// Headline and per-volume detail must agree: the "/" volume in the
			// details payload carries the same protection as the headline.
			var rootVols []map[string]any
			for _, v := range report.Volumes {
				if v["mount"] == "/" {
					rootVols = append(rootVols, v)
				}
			}
			if len(rootVols) != 1 {
				t.Fatalf("want exactly one \"/\" volume in details, got %d: %v", len(rootVols), report.Volumes)
			}
			got := rootVols[0]
			if got["protected"] != report.RootProtected {
				t.Fatalf("detail protected=%v disagrees with headline %v", got["protected"], report.RootProtected)
			}
			for k, want := range tt.wantRootVol {
				if got[k] != want {
					t.Fatalf("root volume %s = %v, want %v (full: %v)", k, got[k], want, got)
				}
			}
			for _, k := range tt.wantNoKeys {
				if _, has := got[k]; has {
					t.Fatalf("root volume must not carry %q: %v", k, got)
				}
			}
		})
	}
}

func TestEvaluateLinuxEncryptionVolumes(t *testing.T) {
	report, err := evaluateLinuxEncryption(lsblkLvmOnLuksRoot, procMountsExt4, noZfs)
	if err != nil {
		t.Fatal(err)
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/boot/efi": false, "/boot": false, "/": true, "[SWAP]": true})
}

func TestEvaluateLinuxEncryptionVolumesPerMount(t *testing.T) {
	// Protection is scoped to each device's own tree: an encrypted data disk
	// does not make the plain root protected.
	report, err := evaluateLinuxEncryption(lsblkPlainRootEncryptedData, procMountsExt4, noZfs)
	if err != nil {
		t.Fatal(err)
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/": false, "/srv/data": true})

	// btrfs: MOUNTPOINT and MOUNTPOINTS both name /home; it must appear once.
	report, err = evaluateLinuxEncryption(lsblkBtrfsOnCryptRoot, procMountsExt4, noZfs)
	if err != nil {
		t.Fatal(err)
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/boot/efi": false, "/home": true, "/": true})
}

func TestEvaluateLinuxEncryptionUnknownRootKeepsOtherVolumes(t *testing.T) {
	report, err := evaluateLinuxEncryption(lsblkZfsRoot, procMountsZfs, func(string) (string, error) {
		return "", errors.New("zfs: command not found")
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.RootErr == nil {
		t.Fatal("expected RootErr")
	}
	assertVolumes(t, report.Volumes, map[string]bool{"/boot/efi": false})
}

func TestEvaluateLinuxEncryptionEmptyDeviceList(t *testing.T) {
	report, err := evaluateLinuxEncryption(`{"blockdevices":[]}`, procMountsExt4, noZfs)
	if err != nil {
		t.Fatal(err)
	}
	// procMountsExt4's root device is not in the (empty) tree.
	if report.RootErr == nil || len(report.Volumes) != 0 {
		t.Fatalf("want RootErr and no volumes, got err=%v volumes=%v", report.RootErr, report.Volumes)
	}
}

func assertVolumes(t *testing.T, volumes []map[string]any, want map[string]bool) {
	t.Helper()
	if len(volumes) != len(want) {
		t.Fatalf("got %d volumes %v, want exactly mounts %v", len(volumes), volumes, want)
	}
	byMount := map[string]map[string]any{}
	for _, v := range volumes {
		byMount[v["mount"].(string)] = v
	}
	for mount, protected := range want {
		v, ok := byMount[mount]
		if !ok {
			t.Fatalf("missing volume %q in %v", mount, volumes)
		}
		if v["protected"] != protected {
			t.Fatalf("volume %q protected=%v, want %v", mount, v["protected"], protected)
		}
	}
}

func TestEvaluateLinuxEncryptionBadLsblk(t *testing.T) {
	if _, err := evaluateLinuxEncryption("not json", procMountsExt4, noZfs); err == nil {
		t.Fatal("expected error for unparseable lsblk output")
	}
}

func TestRootMountFromProcMounts(t *testing.T) {
	tests := []struct {
		name, mounts, wantSource, wantFstype string
		wantOK                               bool
	}{
		{"ext4", procMountsExt4, "/dev/mapper/vgubuntu-root", "ext4", true},
		{"zfs", procMountsZfs, "rpool/ROOT/ubuntu_abc123", "zfs", true},
		{"last mount of / wins", procMountsZfsShadowedByOverlay, "overlay", "overlay", true},
		{"empty", "", "", "", false},
		{"malformed lines ignored", "garbage\n\n", "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			source, fstype, ok := rootMountFromProcMounts(tt.mounts)
			if source != tt.wantSource || fstype != tt.wantFstype || ok != tt.wantOK {
				t.Fatalf("got (%q, %q, %v), want (%q, %q, %v)", source, fstype, ok, tt.wantSource, tt.wantFstype, tt.wantOK)
			}
		})
	}
}
