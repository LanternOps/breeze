//go:build !windows

package backup

// exposePlaceholdersForWalk: placeholder compatibility modes exist only on
// Windows (#7326).
func exposePlaceholdersForWalk() (release func()) { return func() {} }
