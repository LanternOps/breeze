package collectors

import (
	"bufio"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
)

// Immutable Linux systems (Fedora Silverblue/Kinoite, Bazzite, CoreOS, bootc
// images, other ostree/composefs systems) mount / as a read-only image: an
// overlay whose lower layer is an erofs metadata image. statfs("/") then
// reports that image, which is always 100% full, so a disk metric taken at /
// alerts forever while the real storage has plenty of room. The storage
// that actually holds the OS and fills up is mounted elsewhere — /sysroot on
// ostree systems, with /var and /etc bind-mounted from it.
//
// The decision is made from mount information (filesystem type and overlay
// layers), not from distribution names, so any image-rooted system with one
// of the writable mounts below is handled.

// osMountCandidates are tried in order when / is a read-only image. /sysroot
// is the physical root filesystem on ostree systems; /var and /etc are the
// writable mounts that remain when /sysroot is not visible (for example a
// bootc host with a separate /var partition).
var osMountCandidates = []string{"/sysroot", "/var", "/etc"}

// imageFSTypes are filesystems that only ever hold a packed, read-only image.
// Their usage is the image size, not free space anyone can consume.
var imageFSTypes = map[string]bool{
	"erofs":     true,
	"squashfs":  true,
	"cramfs":    true,
	"composefs": true,
}

// mountInfoEntry is one line of /proc/<pid>/mountinfo.
type mountInfoEntry struct {
	Root         string // field 4: path inside the source filesystem
	MountPoint   string // field 5
	MountOptions string // field 6: per-mount options (ro/rw, relatime, ...)
	FSType       string
	Source       string
	SuperOptions string // per-superblock options; overlay layers live here
}

// parseMountInfo parses the kernel's mountinfo format:
//
//	36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue
//
// Malformed lines are skipped so one odd entry cannot hide the rest.
func parseMountInfo(r io.Reader) []mountInfoEntry {
	var entries []mountInfoEntry
	scanner := bufio.NewScanner(r)
	// Overlay super options list every layer and can exceed the default
	// 64 KiB token limit on hosts with deep container image stacks.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		pre, post, ok := strings.Cut(line, " - ")
		if !ok {
			continue
		}
		head := strings.Fields(pre)
		tail := strings.Fields(post)
		if len(head) < 6 || len(tail) < 2 {
			continue
		}
		entry := mountInfoEntry{
			Root:         unescapeMountInfo(head[3]),
			MountPoint:   unescapeMountInfo(head[4]),
			MountOptions: head[5],
			FSType:       tail[0],
			Source:       unescapeMountInfo(tail[1]),
		}
		if len(tail) >= 3 {
			entry.SuperOptions = tail[2]
		}
		entries = append(entries, entry)
	}
	return entries
}

// unescapeMountInfo decodes the octal escapes (\040 space, \011 tab, \012
// newline, \134 backslash) the kernel uses in mountinfo paths.
func unescapeMountInfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+4 <= len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// isImageFilesystem reports whether a mount is a read-only image whose
// statfs numbers describe the image rather than usable storage.
func isImageFilesystem(e mountInfoEntry) bool {
	if imageFSTypes[e.FSType] || e.Source == "composefs" {
		return true
	}
	if e.FSType == "overlay" {
		// An overlay without an upper layer cannot be written, and statfs
		// reports its top lower layer — on composefs, the erofs image.
		return !hasMountOption(e.SuperOptions, "upperdir")
	}
	return false
}

func hasMountOption(options, key string) bool {
	for _, opt := range strings.Split(options, ",") {
		name, _, _ := strings.Cut(opt, "=")
		if name == key {
			return true
		}
	}
	return false
}

// resolveOSMountPoint picks the mount point whose usage represents the OS
// volume. It is / unless / is a read-only image, in which case the first
// candidate that is mounted on real storage is used. With no such candidate
// it stays at /, which is no worse than before.
func resolveOSMountPoint(entries []mountInfoEntry) string {
	// The last entry for a mount point is the topmost mount, the one this
	// process actually sees.
	top := make(map[string]mountInfoEntry, len(entries))
	for _, e := range entries {
		top[e.MountPoint] = e
	}
	root, ok := top["/"]
	if !ok || !isImageFilesystem(root) {
		return "/"
	}
	for _, candidate := range osMountCandidates {
		if e, ok := top[candidate]; ok && !isImageFilesystem(e) {
			return candidate
		}
	}
	return "/"
}

// mountInfoPath is a variable so tests can point it at a fixture.
var mountInfoPath = "/proc/self/mountinfo"

// linuxOSMountPoint resolves the OS volume from this process's mount table.
// It returns "" when the table cannot be read, so callers can keep the
// volume identity unknown instead of guessing.
func linuxOSMountPoint() string {
	f, err := os.Open(mountInfoPath)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	return resolveOSMountPoint(parseMountInfo(f))
}

// osUsagePath is the path whose disk usage is reported as the device's OS
// disk usage (the DiskPercent metric and hardware disk total). Only Linux
// changes from the historical "/".
func osUsagePath() string {
	if runtime.GOOS != "linux" {
		return "/"
	}
	if mp := linuxOSMountPoint(); mp != "" {
		return mp
	}
	return "/"
}

// isImagePartition is the inventory-side check on a gopsutil partition.
// gopsutil exposes per-mount options only, so the overlay upper-layer test
// is not available here; gopsutil already drops overlay mounts (nodev
// filesystems) unless asked for all of them.
func isImagePartition(fstype, device string) bool {
	return imageFSTypes[fstype] || device == "composefs"
}

// osVolumeFlag reports whether an inventory mount point is the OS volume.
// nil means the agent could not tell, which the API stores as unknown.
func osVolumeFlag(goos, systemDrive, linuxOSMount, mountPoint string) *bool {
	switch goos {
	case "windows":
		return windowsOSVolume(systemDrive, mountPoint)
	case "linux":
		if linuxOSMount == "" {
			return nil
		}
		matches := mountPoint == linuxOSMount
		return &matches
	default:
		return nil
	}
}
