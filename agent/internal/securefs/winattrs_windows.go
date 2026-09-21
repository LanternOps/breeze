//go:build windows

package securefs

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

// PreservedWinAttrs is the set of Windows file attributes the backup captures
// and the restore reapplies (#5407): Hidden, System, ReadOnly, Temporary,
// NotContentIndexed and SparseFile. Before this existed a byte-exact restore
// still dropped every one of them — Hidden and System files came back as plain
// Archive, and a sparse file came back fully allocated.
//
// FILE_ATTRIBUTE_ARCHIVE is deliberately NOT in the set. Practically every
// ordinary file carries it, so including it would put a non-zero winAttrs on
// nearly every manifest entry (defeating the `omitempty` that keeps existing
// manifests byte-identical) while restoring nothing a fresh write does not
// already produce. Attributes the OS derives from the file itself — DIRECTORY,
// REPARSE_POINT, COMPRESSED, ENCRYPTED — are excluded for the opposite reason:
// the restore cannot set them, so recording them would only produce warnings.
const PreservedWinAttrs = uint32(
	windows.FILE_ATTRIBUTE_READONLY |
		windows.FILE_ATTRIBUTE_HIDDEN |
		windows.FILE_ATTRIBUTE_SYSTEM |
		windows.FILE_ATTRIBUTE_TEMPORARY |
		windows.FILE_ATTRIBUTE_SPARSE_FILE |
		windows.FILE_ATTRIBUTE_NOT_CONTENT_INDEXED)

// ApplyWinAttrs reapplies attrs to an already-published file BY PATHNAME. It
// exists for the restore paths that are pathname-based end to end (the BMR
// reinstall-then-recover download loop); the primary restore path instead
// hands the attributes to InstallFileWithAttrs, which lands them on the pinned
// temporary before publication and never touches the published pathname.
//
// Callers must run it AFTER any chmod/chtimes: FILE_ATTRIBUTE_READONLY makes
// those fail once set.
func ApplyWinAttrs(path string, attrs uint32) error {
	attrs &= PreservedWinAttrs
	if attrs == 0 {
		return nil
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	// The two halves are independent and BOTH are attempted (review finding):
	// a target that cannot carry sparse files at all — FAT32, exFAT, a network
	// redirector — must still get Hidden/System/ReadOnly. Short-circuiting on
	// the sparse ioctl silently forfeited every other attribute on exactly the
	// filesystems where the operator most needs the warning to be accurate
	// about what was actually lost.
	var sparseErr error
	if attrs&windows.FILE_ATTRIBUTE_SPARSE_FILE != 0 {
		if err := setSparseByPath(p); err != nil {
			sparseErr = fmt.Errorf("mark restored file sparse: %w", err)
		}
	}
	settable := attrs &^ uint32(windows.FILE_ATTRIBUTE_SPARSE_FILE)
	if settable == 0 {
		return sparseErr
	}
	current, err := windows.GetFileAttributes(p)
	if err != nil {
		return errors.Join(sparseErr, err)
	}
	// FILE_ATTRIBUTE_NORMAL is only valid standing alone, so it has to go the
	// moment any other attribute is added.
	merged := (current &^ uint32(windows.FILE_ATTRIBUTE_NORMAL)) | settable
	if merged == current {
		return sparseErr
	}
	return errors.Join(sparseErr, windows.SetFileAttributes(p, merged))
}

func setSparseByPath(p *uint16) error {
	handle, err := windows.CreateFile(p, windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return err
	}
	defer func() { _ = windows.CloseHandle(handle) }()
	return maybeSetSparse(handle, windows.FILE_ATTRIBUTE_SPARSE_FILE)
}
