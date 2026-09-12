//go:build windows

package systemstate

import "os"

// lchownBestEffort is a no-op on Windows: POSIX uid/gid ownership has no
// direct equivalent there (ACLs are a different model entirely, and out of
// scope for this best-effort staging copy — Windows system state is
// collected via reg.exe/other tools that don't go through copyFile/copyTree
// for anything ownership-sensitive).
func lchownBestEffort(_ string, _ os.FileInfo) {}

// uidGidFromInfo always reports "not applicable" on Windows — no POSIX
// uid/gid concept (see lchownBestEffort's doc comment above). Callers treat
// a negative return as "leave Artifact.UID/GID unset", which then omits
// from the manifest JSON.
func uidGidFromInfo(_ os.FileInfo) (uid, gid int) {
	return -1, -1
}
