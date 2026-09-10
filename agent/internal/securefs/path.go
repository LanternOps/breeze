package securefs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CleanRelative rejects paths that could escape a directory pinned by the
// platform-specific implementation.
func CleanRelative(name string) (string, error) {
	if name == "" || filepath.IsAbs(name) {
		return "", errors.New("path must be non-empty and relative")
	}
	clean := filepath.Clean(name)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes the target directory")
	}
	return clean, nil
}

// EnsurePrivateDir creates an absolute directory without accepting symbolic
// links in its path and restricts the final directory to its owner.
func EnsurePrivateDir(path string) error {
	return ensureDir(path, 0o700, true)
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
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	return installFile(base, clean, source, mode, modTime, owner)
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
// a symbolic link in the destination path.
func StatFile(base, relative string) (os.FileInfo, error) {
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	return statFile(base, clean)
}
