//go:build windows

package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// reparseTagNameSurrogate is the bit Windows sets on reparse tags that
// redirect to another named location (IO_REPARSE_TAG_MOUNT_POINT for
// junctions, IO_REPARSE_TAG_SYMLINK, ...). Other reparse points — e.g. WOF
// compressed or deduplicated files — hold their own data in place.
const reparseTagNameSurrogate = 0x20000000

// resetNestedProgramDataSDDL gives a nested entry a SYSTEM owner and an
// empty explicit DACL; applied with UNPROTECTED_DACL_SECURITY_INFORMATION
// the entry then carries only what it inherits from its (hardened) parent.
const resetNestedProgramDataSDDL = `O:SYD:`

var errProgramDataPathNotALink = errors.New("path is not a reparse point")

func fileAttributes(path string) (uint32, bool, error) {
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, false, err
	}
	attrs, err := windows.GetFileAttributes(p16)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return 0, false, nil
		}
		return 0, false, fmt.Errorf("get attributes of %s: %w", path, err)
	}
	return attrs, true, nil
}

// programDataPathIsLink reports whether path itself is a reparse point.
// GetFileAttributes does not follow a reparse point at the final component,
// so this describes the link, not its target. A missing path is not a link.
func programDataPathIsLink(path string) (bool, error) {
	attrs, exists, err := fileAttributes(path)
	if err != nil || !exists {
		return false, err
	}
	return attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0, nil
}

// removeProgramDataLink deletes the reparse point at path. For a directory
// link (junction or directory symbolic link) RemoveDirectory removes the
// link itself and never touches the target; for a file link DeleteFile does
// the same. Nothing here recurses, and a path that is not a reparse point is
// refused rather than deleted.
func removeProgramDataLink(path string) error {
	attrs, exists, err := fileAttributes(path)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		return fmt.Errorf("%s: %w", path, errProgramDataPathNotALink)
	}
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	if attrs&windows.FILE_ATTRIBUTE_DIRECTORY != 0 {
		if err := windows.RemoveDirectory(p16); err != nil {
			return fmt.Errorf("remove directory link %s: %w", path, err)
		}
		return nil
	}
	if err := windows.DeleteFile(p16); err != nil {
		return fmt.Errorf("remove file link %s: %w", path, err)
	}
	return nil
}

func reparseTag(path string) (uint32, error) {
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var fd windows.Win32finddata
	h, err := windows.FindFirstFile(p16, &fd)
	if err != nil {
		return 0, fmt.Errorf("read reparse tag of %s: %w", path, err)
	}
	_ = windows.FindClose(h)
	return fd.Reserved0, nil
}

// readProgramDataPathSecurity reads path's link state, owner and DACL
// without following a link at path.
func readProgramDataPathSecurity(path string) (programDataPathSecurity, error) {
	attrs, exists, err := fileAttributes(path)
	if err != nil {
		return programDataPathSecurity{}, err
	}
	if !exists {
		return programDataPathSecurity{}, nil
	}
	sec := programDataPathSecurity{Exists: true}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		sec.Reparse = true
		tag, terr := reparseTag(path)
		// An unreadable tag is treated as a link: fail closed.
		if terr != nil || tag&reparseTagNameSurrogate != 0 {
			sec.NameSurrogate = true
			return sec, nil
		}
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return programDataPathSecurity{}, fmt.Errorf("get security info on %s: %w", path, err)
	}
	if err := parseProgramDataSecurity(sd, path, &sec); err != nil {
		return programDataPathSecurity{}, err
	}
	return sec, nil
}

// parseProgramDataSecurity fills sec's owner and DACL from sd (read by path or
// from a handle).
func parseProgramDataSecurity(sd *windows.SECURITY_DESCRIPTOR, path string, sec *programDataPathSecurity) error {
	owner, _, err := sd.Owner()
	if err != nil {
		return fmt.Errorf("read owner on %s: %w", path, err)
	}
	if owner != nil {
		sec.OwnerSID = owner.String()
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		if errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
			return nil // no DACL present: DACLPresent stays false
		}
		return fmt.Errorf("read DACL on %s: %w", path, err)
	}
	if dacl == nil {
		return nil // NULL DACL
	}
	sec.DACLPresent = true
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			return fmt.Errorf("read DACL entry %d on %s: %w", i, path, err)
		}
		e := programDataACE{Type: ace.Header.AceType, Flags: ace.Header.AceFlags, Mask: uint32(ace.Mask)}
		if e.Type == aceTypeAccessAllowed || e.Type == aceTypeAccessDenied {
			e.SID = (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		}
		sec.ACEs = append(sec.ACEs, e)
	}
	return nil
}

// resetProgramDataTreeContents sweeps dir without following links. A link
// is removed (the link only, never its target); an entry that fails
// checkProgramDataObject gets a SYSTEM owner and inherited-only permissions
// from its hardened parent, and everything below it is swept too, since a
// principal that controlled the entry controlled its content. With full set
// every subtree is swept; otherwise only dir's direct entries and the
// subtrees under entries that failed. It returns the links it could not
// remove, and the first other error.
func resetProgramDataTreeContents(dir string, full bool) ([]string, error) {
	var stuck []string
	var firstErr error
	note := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	var walk func(d string, all bool)
	walk = func(d string, all bool) {
		entries, err := os.ReadDir(d)
		if err != nil {
			note(fmt.Errorf("list %s: %w", d, err))
			return
		}
		for _, e := range entries {
			p := filepath.Join(d, e.Name())
			sec, err := readProgramDataPathSecurity(p)
			if err != nil {
				note(err)
				continue
			}
			if !sec.Exists {
				continue
			}
			if sec.NameSurrogate {
				if err := removeProgramDataLink(p); err != nil {
					log.Warn("Failed to remove a link inside an agent ProgramData directory", "path", p, "error", err.Error())
					stuck = append(stuck, p)
					continue
				}
				log.Warn("Removed a link inside an agent ProgramData directory; its target was left untouched", "path", p)
				continue
			}
			untrusted := checkProgramDataObject(p, sec) != nil
			if untrusted {
				log.Warn("Resetting the owner and permissions of an entry inside an agent ProgramData directory that other principals could change", "path", p)
				note(resetNestedProgramDataEntry(p))
			}
			if !sec.Reparse && e.IsDir() && (all || untrusted) {
				walk(p, true)
			}
		}
	}
	walk(dir, full)
	return stuck, firstErr
}

func resetNestedProgramDataEntry(path string) error {
	sd, err := windows.SecurityDescriptorFromString(resetNestedProgramDataSDDL)
	if err != nil {
		return fmt.Errorf("parse reset descriptor: %w", err)
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return fmt.Errorf("extract reset owner: %w", err)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		// A nil DACL here would mean "everyone full access" — never apply it.
		return fmt.Errorf("reset descriptor has no empty DACL: %v", err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION,
		owner, nil, dacl, nil); err != nil {
		return fmt.Errorf("reset owner/permissions on %s: %w", path, err)
	}
	return nil
}
