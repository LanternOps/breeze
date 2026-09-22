//go:build !linux

package syscleanup

// syncMount is a no-op outside Linux: the lazy-reclaim behaviour this guards
// against (issue #6484) is a btrfs trait, and this catalogue's other
// platforms (Windows NTFS, macOS APFS) update free-space accounting
// synchronously with the delete.
func syncMount(mount string) {}
