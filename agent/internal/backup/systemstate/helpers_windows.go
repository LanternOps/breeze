//go:build windows

package systemstate

import (
	"io/fs"
	"os"

	"golang.org/x/sys/windows"
)

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

// openHiveSource opens a registry hive file inside a VSS shadow copy for
// reading with backup semantics: FILE_FLAG_BACKUP_SEMANTICS lets an enabled
// SeBackupPrivilege (see CollectOptions.AcquireBackupPrivilege) override the
// file's DACL, and FILE_FLAG_OPEN_REPARSE_POINT opens a reparse point itself
// rather than following it, so copyHiveSourceFile's regular-file check
// rejects anything that is not a plain hive file. Nothing in a shadow copy is
// open by anyone else, but the share mode stays permissive regardless.
func openHiveSource(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: path, Err: err}
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_SEQUENTIAL_SCAN, 0)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}
