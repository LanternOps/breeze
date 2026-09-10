//go:build linux || darwin

package securefs

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// maxTrustedLinkDepth caps how many trusted system symlinks the absolute
// prefix walk will resolve before failing closed.
const maxTrustedLinkDepth = 16

// splitComponents splits an absolute, cleaned path into its non-empty
// components.
func splitComponents(path string) []string {
	var out []string
	for _, component := range strings.Split(filepath.Clean(path), string(filepath.Separator)) {
		if component == "" || component == "." {
			continue
		}
		out = append(out, component)
	}
	return out
}

// openAbsoluteDir pins an absolute directory with a descriptor walk that never
// follows an attacker-plantable symlink.
//
// Platform delta: Linux and darwin share openat/O_DIRECTORY/O_NOFOLLOW, but
// darwin's own root filesystem contains privileged symlinks that a real
// installation path must traverse (/var -> private/var, /tmp -> private/tmp,
// /etc -> private/etc). A strict "no symlink anywhere" walk would make every
// macOS path under those prefixes unusable. An INTERMEDIATE component may
// therefore be followed only when it is a symlink owned by root or by our own
// effective uid, sitting in a directory that is likewise root/self-owned and
// not group/other-writable (or sticky, where a foreign identity cannot replace
// entries it does not own). The FINAL component is the pinned boundary itself
// and is never followed on any platform, so a planted base symlink is still
// rejected. On Linux, where these prefixes are real directories, the walk
// behaves exactly as before.
//
// Linux-only openat2(RESOLVE_NO_SYMLINKS|RESOLVE_BENEATH) is deliberately not
// used: darwin has no equivalent, and the portable descriptor sequence gives
// the same pinning on both.
func openAbsoluteDir(path string, create bool, mode uint32) (int, error) {
	if !filepath.IsAbs(path) {
		return -1, fmt.Errorf("directory must be absolute: %q", path)
	}
	fd, err := unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, err
	}
	return walkComponents(fd, splitComponents(path), create, mode, 0)
}

// walkComponents consumes components starting at fd and takes ownership of fd:
// it is closed on every path out.
func walkComponents(fd int, components []string, create bool, mode uint32, depth int) (int, error) {
	for i := 0; i < len(components); i++ {
		component := components[i]
		if create {
			if err := unix.Mkdirat(fd, component, mode); err != nil && err != unix.EEXIST {
				unix.Close(fd)
				return -1, err
			}
		}
		next, openErr := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if openErr == nil {
			unix.Close(fd)
			fd = next
			continue
		}
		// The final component is the pinned boundary: never resolved through a
		// link, so a planted base symlink fails closed here.
		if i == len(components)-1 {
			unix.Close(fd)
			return -1, openErr
		}
		target, trustErr := trustedLinkTarget(fd, component, depth)
		if trustErr != nil {
			unix.Close(fd)
			return -1, fmt.Errorf("open path component %q: %w", component, trustErr)
		}
		remaining := append(splitComponents(target), components[i+1:]...)
		var nextFD int
		var err error
		if filepath.IsAbs(target) {
			nextFD, err = unix.Open("/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		} else {
			nextFD, err = unix.Dup(fd)
		}
		unix.Close(fd)
		if err != nil {
			return -1, err
		}
		return walkComponents(nextFD, remaining, create, mode, depth+1)
	}
	return fd, nil
}

// trustedLinkTarget returns the destination of component when component is a
// symlink that a less-privileged local identity could not have planted or
// replaced. Anything else is an error, so the caller fails closed.
func trustedLinkTarget(dirFD int, component string, depth int) (string, error) {
	if depth >= maxTrustedLinkDepth {
		return "", errors.New("too many symbolic links in path")
	}
	var linkStat unix.Stat_t
	if err := unix.Fstatat(dirFD, component, &linkStat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return "", err
	}
	if linkStat.Mode&unix.S_IFMT != unix.S_IFLNK {
		return "", errors.New("path component is not a directory")
	}
	euid := uint32(os.Geteuid())
	if linkStat.Uid != 0 && linkStat.Uid != euid {
		return "", fmt.Errorf("path component link is owned by uid %d", linkStat.Uid)
	}
	var parentStat unix.Stat_t
	if err := unix.Fstat(dirFD, &parentStat); err != nil {
		return "", err
	}
	if parentStat.Uid != 0 && parentStat.Uid != euid {
		return "", fmt.Errorf("linked path component sits in a directory owned by uid %d", parentStat.Uid)
	}
	if parentStat.Mode&0o022 != 0 {
		// A group/other-writable parent only counts as trusted when it is
		// sticky (a foreign identity cannot then replace an entry it does not
		// own) AND the link itself belongs to root.
		if parentStat.Mode&unix.S_ISVTX == 0 || linkStat.Uid != 0 {
			return "", errors.New("linked path component sits in a writable directory")
		}
	}
	buf := make([]byte, unix.PathMax)
	n, err := unix.Readlinkat(dirFD, component, buf)
	if err != nil {
		return "", err
	}
	if n <= 0 || n >= len(buf) {
		return "", errors.New("unreadable path component link")
	}
	return string(buf[:n]), nil
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
