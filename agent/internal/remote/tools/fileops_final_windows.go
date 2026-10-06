//go:build windows

package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// On Windows a path string is a poor witness of where an operation lands:
// junctions and volume mount points (which filepath.EvalSymlinks has not
// followed since Go 1.23), 8.3 short names, trailing dots and spaces, stream
// suffixes and the built-in compatibility junctions all reach one directory
// under many names. So the deny-list is applied to the path Windows reports
// for an OPEN HANDLE (GetFinalPathNameByHandle), and the operation is then
// performed through that same handle, so nothing can be swapped in between
// the check and the use.

// handleCheckMandatory: on Windows a handle whose final path cannot be read
// is refused rather than waved through.
const handleCheckMandatory = true

const shareAll = windows.FILE_SHARE_READ | windows.FILE_SHARE_WRITE | windows.FILE_SHARE_DELETE

// openFollowing opens p for attribute access, following every reparse point
// including one at the leaf. FILE_FLAG_BACKUP_SEMANTICS lets it open
// directories.
func openFollowing(p string, access uint32) (windows.Handle, error) {
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return windows.InvalidHandle, err
	}
	return windows.CreateFile(name, access, shareAll, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
}

// resolveForContainment returns where cleanPath really lands. The nearest
// ancestor that can be opened is opened (following junctions, symlinks and
// mount points, and accepting short names, trailing dots and stream syntax as
// Windows does) and its final path is asked of the handle; the components
// below it, which do not exist yet, are re-attached. There is no depth cap:
// every step shortens the path and the loop ends at the volume root.
//
// This is the pre-check that runs before anything is created (WriteFile and
// RenameFile create missing parent directories). The authoritative check is
// the one made on the handle the operation itself uses.
func resolveForContainment(cleanPath string) (string, bool) {
	current := cleanPath
	remainder := ""
	for {
		if h, err := openFollowing(current, windows.FILE_READ_ATTRIBUTES); err == nil {
			resolved, ferr := finalPathOfHandle(h)
			_ = windows.CloseHandle(h)
			if ferr == nil {
				if remainder != "" {
					resolved = filepath.Join(resolved, remainder)
				}
				return resolved, true
			}
		}
		parent, base := filepath.Split(current)
		if base == "" {
			return "", false
		}
		remainder = filepath.Join(base, remainder)
		parent = filepath.Clean(parent)
		if parent == current {
			return "", false
		}
		current = parent
	}
}

// pinnedEntry is a handle on the directory entry a rename or delete acts on.
// The leaf is opened WITHOUT following a reparse point, so renaming or
// deleting a junction or symlink acts on the link (as os.Rename and os.Remove
// do), while every reparse point above it is followed. With check set, the
// entry's final path has been cleared against the deny-list before pinEntry
// returns; check is off only for the agent's own trash content.
type pinnedEntry struct {
	h    windows.Handle
	path string
}

func pinEntry(verb, cleanPath string, check bool) (*pinnedEntry, error) {
	name, err := windows.UTF16PtrFromString(cleanPath)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(name,
		windows.DELETE|windows.FILE_READ_ATTRIBUTES|windows.FILE_WRITE_ATTRIBUTES|windows.SYNCHRONIZE,
		shareAll, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: cleanPath, Err: err}
	}
	if !check {
		return &pinnedEntry{h: h, path: cleanPath}, nil
	}
	final, err := finalPathOfHandle(h)
	if err != nil {
		_ = windows.CloseHandle(h)
		return nil, containmentDeniedf("%s denied: cannot determine where %s resolves: %v", verb, cleanPath, err)
	}
	if isSensitiveReadPath(final) {
		_ = windows.CloseHandle(h)
		return nil, containmentDeniedf("%s denied on sensitive path (resolved): %s", verb, cleanPath)
	}
	return &pinnedEntry{h: h, path: cleanPath}, nil
}

func (e *pinnedEntry) close() {
	if e != nil && e.h != windows.InvalidHandle {
		_ = windows.CloseHandle(e.h)
		e.h = windows.InvalidHandle
	}
}

// renameTo moves the pinned entry to newPath. The destination directory is
// opened (and, with checkDest, its final path cleared like the source), and
// the rename is issued on the pinned handle relative to that directory
// handle, so neither end is re-resolved from a string after its check.
// checkDest is off only when the destination is the agent's own trash.
func (e *pinnedEntry) renameTo(newPath string, replace, checkDest bool) error {
	parentPath := filepath.Dir(newPath)
	name := filepath.Base(newPath)
	parent, err := openFollowing(parentPath, windows.FILE_TRAVERSE|windows.FILE_LIST_DIRECTORY|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE)
	if err != nil {
		return &os.PathError{Op: "open", Path: parentPath, Err: err}
	}
	defer func() { _ = windows.CloseHandle(parent) }()
	if checkDest {
		final, err := finalPathOfHandle(parent)
		if err != nil {
			return containmentDeniedf("write denied: cannot determine where %s resolves: %v", parentPath, err)
		}
		if isSensitiveReadPath(filepath.Join(final, name)) {
			return containmentDeniedf("write denied on sensitive path (resolved): %s", newPath)
		}
	}
	if err := setRenameRelative(e.h, parent, name, replace); err != nil {
		return &os.LinkError{Op: "rename", Old: e.path, New: newPath, Err: err}
	}
	return nil
}

// fileRenameInformation mirrors FILE_RENAME_INFORMATION; see the identical
// layout note in internal/securefs (path_windows.go). The native call is used
// because the Win32 wrapper ignores RootDirectory.
type fileRenameInformation struct {
	ReplaceIfExists uint32
	RootDirectory   windows.Handle
	FileNameLength  uint32
	FileName        [1]uint16
}

func setRenameRelative(h, parent windows.Handle, name string, replace bool) error {
	nameUTF16, err := windows.UTF16FromString(name)
	if err != nil {
		return err
	}
	nameLen := len(nameUTF16)*2 - 2
	if nameLen <= 0 {
		return errors.New("rename target name is empty")
	}
	var layout fileRenameInformation
	size := int(unsafe.Offsetof(layout.FileName)) + nameLen
	if minimum := int(unsafe.Sizeof(layout)); size < minimum {
		size = minimum
	}
	buf := make([]byte, size)
	info := (*fileRenameInformation)(unsafe.Pointer(&buf[0]))
	if replace {
		info.ReplaceIfExists = 1
	}
	info.RootDirectory = parent
	info.FileNameLength = uint32(nameLen)
	copy(unsafe.Slice(&info.FileName[0], nameLen/2), nameUTF16[:nameLen/2])
	var iosb windows.IO_STATUS_BLOCK
	return windows.NtSetInformationFile(h, &iosb, &buf[0], uint32(len(buf)), windows.FileRenameInformation)
}

// remove deletes the pinned file, link or empty directory through its handle.
// IGNORE_READONLY keeps parity with os.Remove, which clears the read-only
// attribute before deleting.
func (e *pinnedEntry) remove() error {
	flags := uint32(windows.FILE_DISPOSITION_DELETE | windows.FILE_DISPOSITION_POSIX_SEMANTICS |
		windows.FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE)
	err := windows.SetFileInformationByHandle(e.h, windows.FileDispositionInfoEx,
		(*byte)(unsafe.Pointer(&flags)), uint32(unsafe.Sizeof(flags)))
	if err == nil {
		return nil
	}
	if !errors.Is(err, windows.ERROR_INVALID_PARAMETER) && !errors.Is(err, windows.ERROR_NOT_SUPPORTED) &&
		!errors.Is(err, windows.ERROR_INVALID_FUNCTION) {
		return &os.PathError{Op: "remove", Path: e.path, Err: err}
	}
	// Filesystems without the extended class (FAT, some network
	// redirectors): clear read-only by handle, then the classic disposition.
	var info windows.ByHandleFileInformation
	if gerr := windows.GetFileInformationByHandle(e.h, &info); gerr == nil &&
		info.FileAttributes&windows.FILE_ATTRIBUTE_READONLY != 0 {
		basic := struct {
			CreationTime, LastAccessTime, LastWriteTime, ChangeTime int64
			FileAttributes                                          uint32
			_                                                       uint32
		}{FileAttributes: info.FileAttributes &^ windows.FILE_ATTRIBUTE_READONLY}
		if basic.FileAttributes == 0 {
			basic.FileAttributes = windows.FILE_ATTRIBUTE_NORMAL
		}
		_ = windows.SetFileInformationByHandle(e.h, windows.FileBasicInfo,
			(*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic)))
	}
	disposition := uint32(1)
	if err := windows.SetFileInformationByHandle(e.h, windows.FileDispositionInfo,
		(*byte)(unsafe.Pointer(&disposition)), uint32(unsafe.Sizeof(disposition))); err != nil {
		return &os.PathError{Op: "remove", Path: e.path, Err: err}
	}
	return nil
}

func sameObject(a, b *windows.ByHandleFileInformation) bool {
	return a.VolumeSerialNumber == b.VolumeSerialNumber &&
		a.FileIndexHigh == b.FileIndexHigh && a.FileIndexLow == b.FileIndexLow
}

// removeAll deletes the pinned entry and, when it is a real directory,
// everything beneath it.
//
// os.Root does not share delete access, so it cannot be opened while the
// pinned handle (which holds DELETE) is open. The pinned handle is therefore
// released and every later handle is tied back to the cleared directory by
// identity (volume serial and file ID), which a re-pointed junction or a
// swapped directory cannot fake:
//
//  1. the children are removed through an os.Root whose own directory is
//     verified to be the pinned object, so the traversal is confined to the
//     cleared directory and never follows a link out of it;
//  2. the directory itself is re-opened without following a reparse point,
//     verified again, and deleted through that handle.
func (e *pinnedEntry) removeAll() error {
	var pinned windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(e.h, &pinned); err != nil {
		return &os.PathError{Op: "remove", Path: e.path, Err: err}
	}
	if pinned.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 ||
		pinned.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return e.remove()
	}
	e.close()
	changed := fmt.Errorf("remove %s: the directory changed during the operation", e.path)

	if err := func() error {
		root, err := os.OpenRoot(e.path)
		if err != nil {
			return err
		}
		defer func() { _ = root.Close() }()
		dir, err := root.Open(".")
		if err != nil {
			return err
		}
		var opened windows.ByHandleFileInformation
		err = windows.GetFileInformationByHandle(windows.Handle(dir.Fd()), &opened)
		if err != nil {
			_ = dir.Close()
			return &os.PathError{Op: "remove", Path: e.path, Err: err}
		}
		if !sameObject(&opened, &pinned) {
			_ = dir.Close()
			return changed
		}
		entries, err := dir.ReadDir(-1)
		_ = dir.Close()
		if err != nil {
			return &os.PathError{Op: "readdir", Path: e.path, Err: err}
		}
		for _, entry := range entries {
			if err := root.RemoveAll(entry.Name()); err != nil {
				return err
			}
		}
		return nil
	}(); err != nil {
		return err
	}

	again, err := pinEntry("delete", e.path, false)
	if err != nil {
		return err
	}
	defer again.close()
	var reopened windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(again.h, &reopened); err != nil {
		return &os.PathError{Op: "remove", Path: e.path, Err: err}
	}
	if !sameObject(&reopened, &pinned) {
		return changed
	}
	return again.remove()
}
