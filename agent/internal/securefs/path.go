package securefs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CleanRelative rejects paths that could escape a directory pinned by the
// platform-specific implementation. On Windows it also refuses any component
// that cannot be stored under its literal name (ErrInvalidWindowsName).
func CleanRelative(name string) (string, error) {
	if name == "" || filepath.IsAbs(name) {
		return "", errors.New("path must be non-empty and relative")
	}
	clean := filepath.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes the target directory")
	}
	if err := checkPlatformComponents(clean); err != nil {
		return "", err
	}
	return clean, nil
}

// EnsurePrivateDir creates an absolute directory without accepting symbolic
// links in its path and restricts the final directory to its owner.
func EnsurePrivateDir(path string) error {
	return ensureDir(path, 0o700, true)
}

// CheckPrivateDir verifies an existing directory's owner-only access without
// changing its permissions. New private directories use EnsurePrivateDir.
func CheckPrivateDir(path string) error {
	_, err := PrivateDirInfo(path)
	return err
}

// PrivateDirInfo returns identity metadata from the same pinned directory
// handle whose owner and privacy policy were verified.
func PrivateDirInfo(path string) (os.FileInfo, error) {
	return privateDirInfo(path)
}

// EnsurePrivateDirInRoot creates or restricts a relative directory through the
// supplied root handle, without resolving the root's pathname again.
func EnsurePrivateDirInRoot(root *os.Root, relative string) error {
	if root == nil {
		return errors.New("directory root is required")
	}
	clean, err := CleanRelative(relative)
	if err != nil {
		return err
	}
	return ensurePrivateDirInRoot(root, clean)
}

// Owner is the uid/gid a restored entry should end up with. nil means "leave
// whatever the creating process produced".
type Owner struct {
	UID int
	GID int
}

// InstallFile publishes source beneath base without following a symbolic link
// in the destination path. The source is removed after a successful install.
//
// mode carries Go's os.FileMode bit layout, so setuid/setgid/sticky survive;
// it and owner are applied to the PINNED temporary before publication, never
// by a pathname operation on the published file.
func InstallFile(base, relative, source string, mode os.FileMode, modTime time.Time, owner *Owner) ([]error, error) {
	return InstallFileWithAttrs(base, relative, source, mode, modTime, owner, 0)
}

// CopyFile publishes source beneath base using the same pinned destination
// operations as InstallFile, while preserving source for retries and reuse.
func CopyFile(base, relative, source string, mode os.FileMode, modTime time.Time, owner *Owner) ([]error, error) {
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	return installFile(base, clean, source, mode, modTime, owner, 0, nil, false, nil)
}

// CopyFileFromRoot copies a regular source file read through sourceRoot's
// directory handle and preserves it for reuse. Both sides remain rooted.
func CopyFileFromRoot(base, relative, sourceRoot, sourceRelative string, mode os.FileMode, modTime time.Time, owner *Owner) ([]error, error) {
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	sourceName, err := CleanRelative(sourceRelative)
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(sourceRoot)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	source, err := root.Open(sourceName)
	if err != nil {
		return nil, err
	}
	defer func() { _ = source.Close() }()
	info, err := source.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("copy source is not a regular file")
	}
	return installFile(base, clean, "", mode, modTime, owner, 0, nil, false, source)
}

func openInstallSource(path string, input *os.File) (*os.File, error) {
	if input != nil {
		return input, nil
	}
	return os.Open(path)
}

// InstallFileWithAttrs is InstallFile plus winAttrs — the Windows file
// attributes (Hidden/System/ReadOnly/Temporary/NotContentIndexed/SparseFile)
// the backup manifest captured for this file (#5407). They are applied to the
// PINNED temporary before publication, exactly like mode/mtime/owner, so the
// published file never needs a pathname attribute call. 0 means "unknown" and
// reproduces InstallFile's previous behavior exactly. Ignored off Windows.
func InstallFileWithAttrs(base, relative, source string, mode os.FileMode, modTime time.Time, owner *Owner, winAttrs uint32) ([]error, error) {
	return InstallFileWithSecurity(base, relative, source, mode, modTime, owner, winAttrs, nil)
}

// SecurityApplier applies caller-owned security metadata (an NTFS security
// descriptor, W06a) through a handle this package has already pinned, so the
// caller never has to reopen a restored entry by pathname — a pathname
// reopen after publication is exactly the race this package exists to
// remove.
//
// Access is the extra access mask the pinned handle must carry for Apply to
// succeed (WRITE_DAC, WRITE_OWNER, ACCESS_SYSTEM_SECURITY on Windows; ignored
// elsewhere). Apply receives the raw pinned handle: a windows.Handle on
// Windows, a file descriptor on Linux/macOS. It must not close it.
//
// Required turns an Apply failure — or, on Windows, a refusal of the extra
// Access on the exclusive create — from a fidelity warning into a failed
// install: the temporary is discarded and nothing is published. It is for
// descriptors that restrict access, where publishing the file with its
// parent's inherited ACL instead would widen access rather than lose
// fidelity.
type SecurityApplier struct {
	Access   uint32
	Apply    func(handle uintptr) error
	Required bool
}

// InstallFileWithSecurity is InstallFileWithAttrs plus sec, which runs on the
// PINNED temporary after its content, mode, owner, mtime and attributes are
// set and BEFORE the atomic publish. An Apply error is a fidelity warning,
// never a failed install, unless sec.Required. nil sec is exactly
// InstallFileWithAttrs.
func InstallFileWithSecurity(base, relative, source string, mode os.FileMode, modTime time.Time, owner *Owner, winAttrs uint32, sec *SecurityApplier) ([]error, error) {
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	return installFile(base, clean, source, mode, modTime, owner, winAttrs, sec, true, nil)
}

// ApplyDirSecurity opens the EXISTING directory base/relative with the same
// component-by-component, never-follow walk InstallDir uses (every component
// pinned for the duration) and runs sec.Apply on the directory's own handle.
// It never creates anything.
func ApplyDirSecurity(base, relative string, sec SecurityApplier) error {
	clean, err := CleanRelative(relative)
	if err != nil {
		return err
	}
	if sec.Apply == nil {
		return errors.New("security applier has no Apply function")
	}
	return applyDirSecurity(base, clean, sec)
}

// InstallSymlink recreates a symbolic link beneath base, relative to the pinned
// parent directory — never by pathname, so no ancestor the restore itself
// created earlier can be traversed as a link.
//
// Resume semantics match the rest of the restore path: a link that already
// points at linkTarget is left alone, a link pointing elsewhere is replaced,
// and anything that is NOT a symlink (a regular file, a real directory, a
// junction or any other reparse point) is refused rather than silently
// destroyed.
//
// The returned warnings describe fidelity the platform could not deliver — a
// link created with the wrong file/directory shape on Windows, say — for a link
// that WAS created successfully.
func InstallSymlink(base, relative, linkTarget string, owner *Owner) ([]error, error) {
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	if linkTarget == "" {
		return nil, errors.New("symlink target is empty")
	}
	return installSymlink(base, clean, linkTarget, owner)
}

// InstallDir recreates a directory entry beneath base with the pinned-parent
// walk, then applies mode (Go's os.FileMode layout, so setgid/sticky survive),
// owner and mtime to the directory's own descriptor. applyMode is false for a
// manifest that recorded no mode.
func InstallDir(base, relative string, mode os.FileMode, applyMode bool, owner *Owner, modTime time.Time) error {
	clean, err := CleanRelative(relative)
	if err != nil {
		return err
	}
	return installDir(base, clean, mode, applyMode, owner, modTime)
}

// StatFile returns metadata for a regular file beneath base without following
// a symbolic link in the destination path. An error for a missing file or
// directory satisfies errors.Is(err, fs.ErrNotExist) on every platform, as
// for OpenFile.
func StatFile(base, relative string) (os.FileInfo, error) {
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	return statFile(base, clean)
}
