//go:build !windows

package logging

import "os"

// makeLevelOverrideFileReadable lets helpers running as the logged-in user
// (macOS LaunchAgent, Linux user session) read the file the root agent wrote.
// The file holds only a level name and timestamps.
func makeLevelOverrideFileReadable(path string) error {
	return os.Chmod(path, 0o644)
}
