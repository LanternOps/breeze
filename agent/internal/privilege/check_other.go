//go:build !windows

package privilege

import "os"

// IsRunningAsRoot returns true if the agent is running with UID 0 (root).
func IsRunningAsRoot() bool {
	return os.Getuid() == 0
}
