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

// InstallFile publishes source beneath base without following a symbolic link
// in the destination path. The source is removed after a successful install.
func InstallFile(base, relative, source string, mode os.FileMode, modTime time.Time) ([]error, error) {
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	return installFile(base, clean, source, mode, modTime)
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
