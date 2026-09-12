//go:build !windows

package systemstate

import (
	"os"
	"testing"
)

// currentUIDGID returns the current process's uid/gid for test assertions
// against Artifact.UID/GID — mirrors what uidGidFromInfo extracts from a
// freshly-written file's os.Lstat result (the file is owned by this process).
func currentUIDGID(t *testing.T) (uid, gid int) {
	t.Helper()
	return os.Getuid(), os.Getgid()
}
