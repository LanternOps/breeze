//go:build windows

package securefs

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// installJunction recreates a junction entirely relative to the pinned parent
// directory, like installSymlink: the parent chain is walked with handles that
// refuse a reparse point at every component, the junction is created as an
// empty directory relative to that parent, and FSCTL_SET_REPARSE_POINT is
// issued on the handle it was created with. No path string reaches the kernel
// after the walk. A junction needs no privilege beyond write access to its
// parent.
func installJunction(base, relative, target string, winAttrs uint32) ([]error, error) {
	buf, err := JunctionReparseBuffer(target)
	if err != nil {
		return nil, err
	}
	parent := base
	if dir := filepath.Dir(relative); dir != "." {
		parent = filepath.Join(base, dir)
	}
	chain, err := openVerifiedDir(parent, true, nil, 0)
	if err != nil {
		return nil, fmt.Errorf("open target parent: %w", err)
	}
	defer chain.close()
	parentHandle := chain.leaf()
	name := filepath.Base(relative)

	// Resume: a junction already pointing at target is left alone. Anything
	// else is refused, never replaced — including a junction to somewhere else
	// and a volume mount point, which shares the junction's reparse tag.
	switch existing, err := inspectRelative(parentHandle, name); {
	case err == nil && existing.kind == entryReparse && existing.tag == windows.IO_REPARSE_TAG_MOUNT_POINT:
		if strings.EqualFold(existing.linkTarget, target) {
			return nil, nil
		}
		return nil, fmt.Errorf("%s exists and is a junction or mount point to %q, not %q", relative, existing.linkTarget, target)
	case err == nil && existing.kind == entryReparse:
		return nil, fmt.Errorf("%s exists and is a reparse point of tag %#08x, not a junction", relative, existing.tag)
	case err == nil:
		return nil, fmt.Errorf("%s exists and is not a junction", relative)
	case !isNotFound(err):
		return nil, err
	}

	handle, err := openRelativeComponent(parentHandle, name,
		windows.GENERIC_WRITE|windows.FILE_WRITE_ATTRIBUTES|windows.DELETE,
		shareFile, windows.FILE_CREATE, ntDirOptions, nil)
	if err != nil {
		return nil, fmt.Errorf("create junction placeholder: %w", err)
	}
	defer func() { _ = windows.CloseHandle(handle) }()

	var returned uint32
	if err := windows.DeviceIoControl(handle, windows.FSCTL_SET_REPARSE_POINT,
		&buf[0], uint32(len(buf)), nil, 0, &returned, nil); err != nil {
		_ = deleteRelativeAny(parentHandle, name)
		return nil, fmt.Errorf("set junction target: %w", err)
	}

	// Hidden/System/ReadOnly on the junction itself, through the handle it
	// was created with. Applied after the reparse data: ReadOnly first would
	// make no difference to FSCTL_SET_REPARSE_POINT, but this order matches
	// the rest of the restore (attributes last). A failure is a fidelity
	// warning — the junction exists and resolves.
	var warnings []error
	if settable := winAttrs & installableWinAttrs; settable != 0 {
		basic := fileBasicInfo{FileAttributes: settable | windows.FILE_ATTRIBUTE_DIRECTORY}
		if err := setBasicInfo(handle, &basic); err != nil {
			warnings = append(warnings, fmt.Errorf("could not apply attributes %#x to junction: %w", settable, err))
		}
	}
	return warnings, nil
}

// ensureNoReparsePointsAlong walks base\relative from the volume root with
// no-follow handles and refuses a reparse point at any component that exists.
// It stops without error at the first component that does not exist (the
// rest cannot redirect anything yet) or that is not a directory.
func ensureNoReparsePointsAlong(base, relative string) error {
	full := filepath.Clean(filepath.Join(base, relative))
	volume := filepath.VolumeName(full)
	if volume == "" {
		return fmt.Errorf("path must name a volume: %q", full)
	}
	rootWide, err := windows.UTF16PtrFromString(volume + string(filepath.Separator))
	if err != nil {
		return err
	}
	root, err := windows.CreateFile(rootWide, windows.FILE_READ_ATTRIBUTES|windows.FILE_LIST_DIRECTORY,
		shareNoDelete|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return fmt.Errorf("open volume root %q: %w", volume, err)
	}
	opened := []windows.Handle{root}
	defer func() {
		for i := len(opened) - 1; i >= 0; i-- {
			_ = windows.CloseHandle(opened[i])
		}
	}()
	components, err := splitWindowsComponents(strings.Trim(full[len(volume):], `\/`))
	if err != nil {
		return err
	}
	current := root
	for _, component := range components {
		handle, err := openRelativeComponent(current, component, windows.FILE_READ_ATTRIBUTES,
			shareFile, windows.FILE_OPEN, windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT, nil)
		if err != nil {
			if isNotFound(err) {
				return nil
			}
			return fmt.Errorf("open path component %q: %w", component, err)
		}
		opened = append(opened, handle)
		var info windows.ByHandleFileInformation
		if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
			return err
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return fmt.Errorf("path component %q is a reparse point (a symlink, junction or mount point)", component)
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return nil
		}
		current = handle
	}
	return nil
}

func isNotFound(err error) bool {
	return errors.Is(err, windows.STATUS_OBJECT_NAME_NOT_FOUND) ||
		errors.Is(err, windows.STATUS_OBJECT_PATH_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_FILE_NOT_FOUND) ||
		errors.Is(err, windows.ERROR_PATH_NOT_FOUND)
}
