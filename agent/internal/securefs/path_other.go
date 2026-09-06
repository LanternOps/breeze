//go:build !linux

package securefs

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// Non-Linux platforms lack the handle-relative implementation used on Linux.
// This rejects observed symlinks/reparse points and uses an exclusive sibling
// temporary file, but callers must retain runtime validation as a residual.
func ensureDir(path string, mode os.FileMode, private bool) error {
	if !filepath.IsAbs(path) {
		return fmt.Errorf("directory must be absolute: %q", path)
	}
	canonical, err := canonicalizeForCreate(path)
	if err != nil {
		return err
	}
	path = canonical
	current := filepath.VolumeName(path) + string(filepath.Separator)
	for _, component := range splitPath(path) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			if err := os.Mkdir(current, mode); err != nil && !os.IsExist(err) {
				return err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("directory path contains link or non-directory: %q", current)
		}
	}
	if private {
		return os.Chmod(path, mode)
	}
	return nil
}

func canonicalizeForCreate(path string) (string, error) {
	current := filepath.Clean(path)
	var missing []string
	for {
		_, err := os.Lstat(current)
		if err == nil {
			resolved, err := filepath.EvalSymlinks(current)
			if err != nil {
				return "", err
			}
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			return resolved, nil
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent, leaf := filepath.Split(current)
		if leaf == "" || parent == current {
			return "", err
		}
		missing = append(missing, leaf)
		current = filepath.Clean(parent)
	}
}

func splitPath(path string) []string {
	volume := filepath.VolumeName(path)
	rest := path[len(volume):]
	var parts []string
	for rest != "" && rest != string(filepath.Separator) {
		dir, leaf := filepath.Split(filepath.Clean(rest))
		if leaf != "" {
			parts = append([]string{leaf}, parts...)
		}
		rest = filepath.Clean(dir)
		if rest == "." {
			break
		}
	}
	return parts
}

func rejectLinkedPath(base, relative string, create bool) error {
	if err := ensureDir(base, 0o755, false); err != nil {
		return err
	}
	canonicalBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return err
	}
	base = canonicalBase
	current := base
	for _, component := range splitPath(relative) {
		current = filepath.Join(current, component)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) && create {
			if err := os.Mkdir(current, 0o755); err != nil && !os.IsExist(err) {
				return err
			}
			info, err = os.Lstat(current)
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("target path contains link or non-directory: %q", current)
		}
	}
	return nil
}

func installFile(base, relative, source string, mode os.FileMode, modTime time.Time) ([]error, error) {
	if err := rejectLinkedPath(base, filepath.Dir(relative), true); err != nil {
		return nil, err
	}
	destination := filepath.Join(base, relative)
	if info, err := os.Lstat(destination); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("target is a link: %q", destination)
	} else if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	tempPath := filepath.Join(filepath.Dir(destination), ".breeze-restore-"+hex.EncodeToString(random[:]))
	dst, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
	if err != nil {
		return nil, err
	}
	committed := false
	defer func() {
		_ = dst.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()
	src, err := os.Open(source)
	if err != nil {
		return nil, err
	}
	_, copyErr := io.Copy(dst, src)
	closeSrcErr := src.Close()
	if copyErr != nil {
		return nil, copyErr
	}
	if closeSrcErr != nil {
		return nil, closeSrcErr
	}
	var warnings []error
	if mode != 0 {
		if err := dst.Chmod(mode.Perm()); err != nil {
			warnings = append(warnings, fmt.Errorf("apply file mode: %w", err))
		}
	}
	if err := dst.Sync(); err != nil {
		return nil, err
	}
	if err := dst.Close(); err != nil {
		return nil, err
	}
	if !modTime.IsZero() {
		if err := os.Chtimes(tempPath, modTime, modTime); err != nil {
			warnings = append(warnings, fmt.Errorf("apply modification time: %w", err))
		}
	}
	if runtime.GOOS == "windows" {
		if err := os.Remove(destination); err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	if err := os.Rename(tempPath, destination); err != nil {
		return nil, err
	}
	committed = true
	if err := os.Remove(source); err != nil && !os.IsNotExist(err) {
		warnings = append(warnings, fmt.Errorf("remove staging file: %w", err))
	}
	return warnings, nil
}

func statFile(base, relative string) (os.FileInfo, error) {
	if err := rejectLinkedPath(base, filepath.Dir(relative), false); err != nil {
		return nil, err
	}
	path := filepath.Join(base, relative)
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("target is a link: %q", path)
	}
	return info, nil
}
