//go:build linux

package securefs

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func openAbsoluteDir(path string, create bool, mode uint32) (int, error) {
	if !filepath.IsAbs(path) {
		return -1, fmt.Errorf("directory must be absolute: %q", path)
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	for _, component := range strings.Split(filepath.Clean(path), string(filepath.Separator)) {
		if component == "" {
			continue
		}
		if create {
			if err := unix.Mkdirat(fd, component, mode); err != nil && err != unix.EEXIST {
				unix.Close(fd)
				return -1, err
			}
		}
		next, err := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

func openRelativeDir(baseFD int, relative string, create bool, mode uint32) (int, error) {
	fd, err := unix.Dup(baseFD)
	if err != nil {
		return -1, err
	}
	if relative == "." || relative == "" {
		return fd, nil
	}
	for _, component := range strings.Split(relative, string(filepath.Separator)) {
		if create {
			if err := unix.Mkdirat(fd, component, mode); err != nil && err != unix.EEXIST {
				unix.Close(fd)
				return -1, err
			}
		}
		next, err := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

func ensureDir(path string, mode os.FileMode, private bool) error {
	fd, err := openAbsoluteDir(path, true, uint32(mode.Perm()))
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if private {
		var stat unix.Stat_t
		if err := unix.Fstat(fd, &stat); err != nil {
			return fmt.Errorf("inspect private directory owner: %w", err)
		}
		if stat.Uid != uint32(os.Geteuid()) {
			return fmt.Errorf("private directory is owned by uid %d, expected uid %d", stat.Uid, os.Geteuid())
		}
		return unix.Fchmod(fd, uint32(mode.Perm()))
	}
	return nil
}

func installFile(base, relative, source string, mode os.FileMode, modTime time.Time) ([]error, error) {
	baseFD, err := openAbsoluteDir(base, true, 0o755)
	if err != nil {
		return nil, fmt.Errorf("open target base: %w", err)
	}
	defer unix.Close(baseFD)

	parentFD, err := openRelativeDir(baseFD, filepath.Dir(relative), true, 0o755)
	if err != nil {
		return nil, fmt.Errorf("open target parent: %w", err)
	}
	defer unix.Close(parentFD)

	src, err := os.Open(source)
	if err != nil {
		return nil, fmt.Errorf("open staging file: %w", err)
	}
	defer src.Close()

	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, fmt.Errorf("generate temporary name: %w", err)
	}
	tempName := ".breeze-restore-" + hex.EncodeToString(random[:])
	tempFD, err := unix.Openat(parentFD, tempName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o666)
	if err != nil {
		return nil, fmt.Errorf("create target temporary file: %w", err)
	}
	temp := os.NewFile(uintptr(tempFD), tempName)
	committed := false
	defer func() {
		_ = temp.Close()
		if !committed {
			_ = unix.Unlinkat(parentFD, tempName, 0)
		}
	}()

	if _, err := io.Copy(temp, src); err != nil {
		return nil, fmt.Errorf("copy staging file: %w", err)
	}
	var warnings []error
	if mode != 0 {
		if err := unix.Fchmod(tempFD, uint32(mode.Perm())); err != nil {
			warnings = append(warnings, fmt.Errorf("apply file mode: %w", err))
		}
	}
	if !modTime.IsZero() {
		times := []unix.Timeval{unix.NsecToTimeval(modTime.UnixNano()), unix.NsecToTimeval(modTime.UnixNano())}
		if err := unix.Futimes(tempFD, times); err != nil {
			warnings = append(warnings, fmt.Errorf("apply modification time: %w", err))
		}
	}
	if err := temp.Sync(); err != nil {
		return nil, fmt.Errorf("sync target temporary file: %w", err)
	}
	if err := temp.Close(); err != nil {
		return nil, fmt.Errorf("close target temporary file: %w", err)
	}
	if err := unix.Renameat(parentFD, tempName, parentFD, filepath.Base(relative)); err != nil {
		return nil, fmt.Errorf("publish target file: %w", err)
	}
	committed = true
	if err := os.Remove(source); err != nil && !os.IsNotExist(err) {
		warnings = append(warnings, fmt.Errorf("remove staging file: %w", err))
	}
	return warnings, nil
}

func statFile(base, relative string) (os.FileInfo, error) {
	baseFD, err := openAbsoluteDir(base, false, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(baseFD)
	parentFD, err := openRelativeDir(baseFD, filepath.Dir(relative), false, 0)
	if err != nil {
		return nil, err
	}
	defer unix.Close(parentFD)
	fd, err := unix.Openat(parentFD, filepath.Base(relative), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), filepath.Base(relative))
	defer f.Close()
	return f.Stat()
}
