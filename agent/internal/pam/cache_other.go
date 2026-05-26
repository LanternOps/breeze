//go:build !windows

package pam

// applyCacheACL is a no-op on non-Windows platforms. The 0600 perm bits passed
// to atomicWriteFile already restrict to the file owner (root, since the agent
// runs as root via systemd/launchd). Mirrors the pattern at
// agent/internal/config/permissions_unix.go:1.
func applyCacheACL(path string) error {
	return nil
}
