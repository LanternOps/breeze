// Package atomicrename replaces a file by renaming another file over it.
//
// On Windows 10 1607+ / Server 2016+ it uses SetFileInformationByHandle with
// FileRenameInfoEx and POSIX semantics, so the rename replaces a destination
// that another process holds open — the way Unix rename(2) works. os.Rename
// uses MoveFileEx(REPLACE_EXISTING), which fails with ERROR_ACCESS_DENIED while
// a reader keeps the old target delete-pending; the watchdog reads agent.state
// continuously, and os.Rename failed ~78% of the time under that load
// (measured on Server 2022).
//
// Windows 10 2015 LTSB (build 10240) does not implement FileRenameInfoEx:
// SetFileInformationByHandle returns ERROR_INVALID_PARAMETER and retrying the
// same call cannot succeed. Those builds use MoveFileEx (#8858, #8860) and log
// that once per process. A 1607+ kernel that still refuses the class falls
// back to MoveFileEx for that call; the first such fallback in a process logs
// a warning with the path.
//
// On every other OS, Replace is os.Rename.
package atomicrename
