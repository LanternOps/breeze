package collectors

import (
	"bufio"
	"io"
	"log/slog"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/shirou/gopsutil/v3/disk"
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
// of the mounts below on real storage is handled.

// osMountCandidates are tried in order when / is a read-only image. /sysroot
// is the physical root filesystem on ostree systems; /var and /etc are the
// writable mounts that remain when /sysroot is not visible (for example a
// bootc host with a separate /var partition, in which case /var is what is
// reported).
var osMountCandidates = []string{"/sysroot", "/var", "/etc"}

// imageFSTypes are filesystems that only ever hold a packed, read-only image.
// Their usage is the image size, not free space anyone can consume.
var imageFSTypes = map[string]bool{
	"erofs":     true,
	"squashfs":  true,
	"cramfs":    true,
	"composefs": true,
}

// nonStorageFSTypes are never accepted as the OS volume: their statfs numbers
// describe RAM (tmpfs, ramfs, devtmpfs) or another layered view (overlay), so
// picking one would trade a false 100% for a false near-0%.
var nonStorageFSTypes = map[string]bool{
	"tmpfs":    true,
	"ramfs":    true,
	"devtmpfs": true,
	"overlay":  true,
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
// Malformed lines are skipped so one odd entry cannot hide the rest. A read
// error (including a line longer than the scanner limit) is returned with the
// entries parsed so far; callers must not treat that table as complete.
func parseMountInfo(r io.Reader) ([]mountInfoEntry, error) {
	var entries []mountInfoEntry
	scanner := bufio.NewScanner(r)
	// Overlay super options list every layer and can exceed the default
	// 64 KiB token limit on hosts with deep container image stacks.
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		pre, post, ok := strings.Cut(scanner.Text(), " - ")
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
	return entries, scanner.Err()
}

// unescapeMountInfo decodes the octal escapes (\040 space, \011 tab, \012
// newline, \134 backslash) the kernel uses in mountinfo paths. Anything that
// is not a valid three-digit octal byte is kept literally.
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

// isImageFilesystem reports whether a mount is itself a packed read-only
// image (by filesystem type, or composefs as the mount source).
func isImageFilesystem(e mountInfoEntry) bool {
	return imageFSTypes[e.FSType] || e.Source == "composefs"
}

// isImageRoot reports whether the root mount is a read-only image whose
// statfs numbers describe the image rather than usable storage. Besides a
// plain image filesystem, that is an overlay with no upper layer whose top
// lower layer is an image: statfs on an upper-less overlay reports the top
// lower layer, which on composefs is the erofs metadata image. Composefs
// overlays are recognised by their data-only lower layers (datadir+= or the
// "::" separator) even when the erofs mount itself is not visible.
func isImageRoot(root mountInfoEntry, top map[string]mountInfoEntry) bool {
	if isImageFilesystem(root) {
		return true
	}
	if root.FSType != "overlay" {
		return false
	}
	opts := mountOptionValues(root.SuperOptions)
	if _, ok := opts["upperdir"]; ok {
		return false
	}
	if _, ok := opts["datadir+"]; ok {
		return true
	}
	lower := opts["lowerdir"]
	if strings.Contains(lower, "::") {
		return true
	}
	firstLower, _, _ := strings.Cut(lower, ":")
	if firstLower == "" {
		firstLower = opts["lowerdir+"]
	}
	if firstLower == "" {
		return false
	}
	backing, ok := containingMount(firstLower, top)
	return ok && isImageFilesystem(backing)
}

// mountOptionValues splits a comma-separated option string. For a repeated
// key (lowerdir+= appears once per layer) the first value is kept.
func mountOptionValues(options string) map[string]string {
	values := make(map[string]string)
	for _, opt := range strings.Split(options, ",") {
		name, value, _ := strings.Cut(opt, "=")
		if _, seen := values[name]; !seen {
			values[name] = value
		}
	}
	return values
}

// containingMount returns the mount, other than / itself, with the longest
// mount point that contains path.
func containingMount(path string, top map[string]mountInfoEntry) (mountInfoEntry, bool) {
	var best mountInfoEntry
	found := false
	for mp, e := range top {
		if mp == "/" || (path != mp && !strings.HasPrefix(path, mp+"/")) {
			continue
		}
		if !found || len(mp) > len(best.MountPoint) {
			best, found = e, true
		}
	}
	return best, found
}

// isStorageMount reports whether a candidate mount describes real storage.
func isStorageMount(e mountInfoEntry) bool {
	return !isImageFilesystem(e) && !nonStorageFSTypes[e.FSType]
}

// resolveOSMountPoint picks the mount point whose usage represents the OS
// volume. It is / unless / is a read-only image, in which case the first
// candidate mounted on real storage is used. It returns "" when the table has
// no / entry (nothing to decide from). With an image root and no usable
// candidate it stays at /, which is no worse than before.
func resolveOSMountPoint(entries []mountInfoEntry) string {
	// The last entry for a mount point is the topmost mount, the one this
	// process actually sees.
	top := make(map[string]mountInfoEntry, len(entries))
	for _, e := range entries {
		top[e.MountPoint] = e
	}
	root, ok := top["/"]
	if !ok {
		return ""
	}
	if !isImageRoot(root, top) {
		return "/"
	}
	for _, candidate := range osMountCandidates {
		if e, ok := top[candidate]; ok && isStorageMount(e) {
			return candidate
		}
	}
	return "/"
}

// mountInfoPath is a variable so tests can point it at a fixture.
var mountInfoPath = "/proc/self/mountinfo"

// mountInfoWarnOnce keeps a persistent read failure from logging every
// metrics cycle.
var mountInfoWarnOnce sync.Once

// linuxOSMountPoint resolves the OS volume from this process's mount table.
// It returns "" when the table cannot be read completely, so callers keep
// the volume identity unknown instead of guessing.
func linuxOSMountPoint() string {
	f, err := os.Open(mountInfoPath)
	if err != nil {
		warnMountInfo(err)
		return ""
	}
	defer func() { _ = f.Close() }()
	entries, err := parseMountInfo(f)
	if err != nil {
		warnMountInfo(err)
		return ""
	}
	return resolveOSMountPoint(entries)
}

func warnMountInfo(err error) {
	mountInfoWarnOnce.Do(func() {
		slog.Warn("could not read the mount table; reporting disk usage for /", "path", mountInfoPath, "error", err.Error())
	})
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

// diskUsageFn is disk.Usage, indirected for tests.
var diskUsageFn = disk.Usage

// osDiskUsage returns usage for the OS volume. If the resolved mount cannot
// be read it retries /, so a failure never turns into a silent 0%.
func osDiskUsage() (*disk.UsageStat, error) {
	return usageWithRootFallback(osUsagePath())
}

func usageWithRootFallback(path string) (*disk.UsageStat, error) {
	usage, err := diskUsageFn(path)
	if err != nil && path != "/" {
		return diskUsageFn("/")
	}
	return usage, err
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
