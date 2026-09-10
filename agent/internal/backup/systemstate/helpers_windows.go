//go:build windows

package systemstate

import "os"

// lchownBestEffort is a no-op on Windows: POSIX uid/gid ownership has no
// direct equivalent there (ACLs are a different model entirely, and out of
// scope for this best-effort staging copy — Windows system state is
// collected via reg.exe/other tools that don't go through copyFile/copyTree
// for anything ownership-sensitive).
func lchownBestEffort(_ string, _ os.FileInfo) {}
