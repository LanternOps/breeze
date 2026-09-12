//go:build windows

package systemstate

import "testing"

// currentUIDGID has no meaning on Windows (no POSIX uid/gid) — see
// uidGidFromInfo's Windows doc comment. -1 tells the caller "don't assert".
func currentUIDGID(t *testing.T) (uid, gid int) {
	t.Helper()
	return -1, -1
}
