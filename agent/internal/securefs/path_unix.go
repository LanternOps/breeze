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
				_ = unix.Close(fd)
				return -1, err
			}
		}
		next, openErr := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if openErr == nil {
			_ = unix.Close(fd)
			fd = next
			continue
		}
		// The final component is the pinned boundary: never resolved through a
		// link, so a planted base symlink fails closed here.
		if i == len(components)-1 {
			described := describeComponentError(fd, component, openErr)
			_ = unix.Close(fd)
			return -1, described
		}
		// Only a failure that actually indicates "this is not a directory I can
		// open without following a link" is a candidate for the trusted-link
		// branch: ELOOP is what Linux reports for a symlink under O_NOFOLLOW,
		// ENOTDIR is what darwin reports for the same, and for a non-directory
		// on both. Anything else — EACCES, ENOENT, EMFILE — is the caller's
		// real error and must be returned verbatim rather than relabelled as a
		// symlink.
		if !errors.Is(openErr, unix.ELOOP) && !errors.Is(openErr, unix.ENOTDIR) {
			_ = unix.Close(fd)
			return -1, openErr
		}
		target, trustErr := trustedLinkTarget(fd, component, depth)
		if trustErr != nil {
			_ = unix.Close(fd)
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
		_ = unix.Close(fd)
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
	// Establish what the component actually IS before saying anything about
	// it: ENOTDIR reaches here for a regular file as well as for a symlink on
	// darwin, and calling a regular file a symlink misdirects whoever reads
	// the error.
	var linkStat unix.Stat_t
	if err := unix.Fstatat(dirFD, component, &linkStat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return "", err
	}
	if linkStat.Mode&unix.S_IFMT != unix.S_IFLNK {
		return "", errors.New("path component is not a directory")
	}
	if !trustedIntermediateLinksAllowed {
		return "", errors.New("path component is a symbolic link")
	}
	if depth >= maxTrustedLinkDepth {
		return "", errors.New("too many symbolic links in path")
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
	target := string(buf[:n])
	// A trusted link may not climb: ".." in the target would let the walk move
	// above the position it had reached, which is outside what the trust check
	// covers.
	for _, component := range splitComponents(target) {
		if component == ".." {
			return "", errors.New("path component link escapes upwards")
		}
	}
	return target, nil
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
				_ = unix.Close(fd)
				return -1, err
			}
		}
		next, err := unix.Openat(fd, component, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if err != nil {
			described := describeComponentError(fd, component, err)
			_ = unix.Close(fd)
			return -1, described
		}
		_ = unix.Close(fd)
		fd = next
	}
	return fd, nil
}

// describeComponentError names a symlink explicitly instead of leaving the
// caller with a bare ELOOP (Linux) or ENOTDIR (darwin's answer for the same
// thing, and both platforms' answer for a regular file used as a directory).
// It therefore ASKS the filesystem what the component is rather than guessing
// from the errno. Every other errno, and a component that turns out not to be
// a link, is returned untouched — relabelling a real EACCES/ENOENT, or a plain
// file, as a link problem misdirects whoever reads it. The original error is
// always wrapped, so errors.Is keeps working.
func describeComponentError(dirFD int, component string, err error) error {
	if !errors.Is(err, unix.ELOOP) && !errors.Is(err, unix.ENOTDIR) {
		return err
	}
	var st unix.Stat_t
	if statErr := unix.Fstatat(dirFD, component, &st, unix.AT_SYMLINK_NOFOLLOW); statErr != nil {
		return err
	}
	if st.Mode&unix.S_IFMT != unix.S_IFLNK {
		return err
	}
	return fmt.Errorf("refusing to write through path component %q: it is a symlink: %w", component, err)
}

func ensureDir(path string, mode os.FileMode, private bool) error {
	fd, err := openAbsoluteDir(path, true, uint32(mode.Perm()))
	if err != nil {
		return err
	}
	defer func() { _ = unix.Close(fd) }()
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

func installFile(base, relative, source string, mode os.FileMode, modTime time.Time, owner *Owner) ([]error, error) {
	baseFD, err := openAbsoluteDir(base, true, 0o755)
	if err != nil {
		return nil, fmt.Errorf("open target base: %w", err)
	}
	defer func() { _ = unix.Close(baseFD) }()

	parentFD, err := openRelativeDir(baseFD, filepath.Dir(relative), true, 0o755)
	if err != nil {
		return nil, fmt.Errorf("open target parent: %w", err)
	}
	defer func() { _ = unix.Close(parentFD) }()

	src, err := os.Open(source)
	if err != nil {
		return nil, fmt.Errorf("open staging file: %w", err)
	}
	defer func() { _ = src.Close() }()

	var random [12]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, fmt.Errorf("generate temporary name: %w", err)
	}
	tempName := ".breeze-restore-" + hex.EncodeToString(random[:])
	// Created 0600, never 0666-and-umask: the file is publishable content that
	// may be a secret, and the copy below would otherwise leave it readable by
	// everyone for its whole duration. The manifest's own mode is applied
	// afterwards, widening it if that is what the manifest says.
	tempFD, err := unix.Openat(parentFD, tempName, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
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
	// A pre-checksum manifest carries Mode == 0 ("no recorded mode"). Those
	// landed at 0644 before this file switched to a 0600 create; keep that
	// result explicitly, rather than silently tightening every legacy restore
	// to 0600.
	applied := mode
	if mode == 0 {
		applied = 0o644
	}
	if err := unix.Fchmod(tempFD, syscallMode(applied)); err != nil {
		warnings = append(warnings, fmt.Errorf("apply file mode: %w", err))
	}
	// Ownership goes on the pinned descriptor, before publication: a chown by
	// pathname after the file is visible under its final name is exactly the
	// race this package exists to remove.
	if owner != nil {
		if err := unix.Fchown(tempFD, owner.UID, owner.GID); err != nil {
			warnings = append(warnings, fmt.Errorf("apply file owner: %w", err))
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
	defer func() { _ = unix.Close(baseFD) }()
	parentFD, err := openRelativeDir(baseFD, filepath.Dir(relative), false, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = unix.Close(parentFD) }()
	fd, err := unix.Openat(parentFD, filepath.Base(relative), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), filepath.Base(relative))
	defer func() { _ = f.Close() }()
	return f.Stat()
}

// syscallMode converts Go's os.FileMode bit layout to the Unix mode bits
// fchmod/mkdirat expect, preserving setuid/setgid/sticky. os.FileMode keeps
// those in high bits (1<<23 and friends), NOT in the traditional octal
// positions, so a bare uint32(mode) would silently drop all three.
func syscallMode(mode os.FileMode) uint32 {
	out := uint32(mode.Perm())
	if mode&os.ModeSetuid != 0 {
		out |= unix.S_ISUID
	}
	if mode&os.ModeSetgid != 0 {
		out |= unix.S_ISGID
	}
	if mode&os.ModeSticky != 0 {
		out |= unix.S_ISVTX
	}
	return out
}

// applyOwnerAt chowns name relative to parentFD without following it, so a
// symlink entry gets its own ownership rather than its target's.
func applyOwnerAt(parentFD int, name string, owner *Owner) error {
	if owner == nil {
		return nil
	}
	return unix.Fchownat(parentFD, name, owner.UID, owner.GID, unix.AT_SYMLINK_NOFOLLOW)
}

func installSymlink(base, relative, linkTarget string, owner *Owner) error {
	baseFD, err := openAbsoluteDir(base, true, 0o755)
	if err != nil {
		return fmt.Errorf("open target base: %w", err)
	}
	defer func() { _ = unix.Close(baseFD) }()
	parentFD, err := openRelativeDir(baseFD, filepath.Dir(relative), true, 0o755)
	if err != nil {
		return fmt.Errorf("open target parent: %w", err)
	}
	defer func() { _ = unix.Close(parentFD) }()

	name := filepath.Base(relative)
	var existing unix.Stat_t
	if err := unix.Fstatat(parentFD, name, &existing, unix.AT_SYMLINK_NOFOLLOW); err == nil {
		if existing.Mode&unix.S_IFMT != unix.S_IFLNK {
			return fmt.Errorf("%s exists and is not a symlink", relative)
		}
		buf := make([]byte, unix.PathMax)
		if n, rerr := unix.Readlinkat(parentFD, name, buf); rerr == nil && n > 0 && string(buf[:n]) == linkTarget {
			return applyOwnerAt(parentFD, name, owner)
		}
		if err := unix.Unlinkat(parentFD, name, 0); err != nil {
			return err
		}
	}
	if err := unix.Symlinkat(linkTarget, parentFD, name); err != nil {
		return err
	}
	return applyOwnerAt(parentFD, name, owner)
}

func installDir(base, relative string, mode os.FileMode, applyMode bool, owner *Owner, modTime time.Time) error {
	baseFD, err := openAbsoluteDir(base, true, 0o755)
	if err != nil {
		return fmt.Errorf("open target base: %w", err)
	}
	defer func() { _ = unix.Close(baseFD) }()
	// openRelativeDir refuses a symlink at EVERY component, so a directory
	// entry can never be created through an ancestor an earlier pass linked
	// away — the descriptor-based form of the ancestor-symlink guard.
	dirFD, err := openRelativeDir(baseFD, relative, true, 0o755)
	if err != nil {
		return fmt.Errorf("open target directory: %w", err)
	}
	defer func() { _ = unix.Close(dirFD) }()

	if applyMode {
		if err := unix.Fchmod(dirFD, syscallMode(mode)); err != nil {
			return fmt.Errorf("apply directory mode: %w", err)
		}
	}
	if owner != nil {
		if err := unix.Fchown(dirFD, owner.UID, owner.GID); err != nil {
			return fmt.Errorf("apply directory owner: %w", err)
		}
	}
	if !modTime.IsZero() {
		times := []unix.Timeval{unix.NsecToTimeval(modTime.UnixNano()), unix.NsecToTimeval(modTime.UnixNano())}
		if err := unix.Futimes(dirFD, times); err != nil {
			return fmt.Errorf("apply directory modification time: %w", err)
		}
	}
	return nil
}
