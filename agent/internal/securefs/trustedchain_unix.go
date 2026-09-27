//go:build darwin || linux

package securefs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// EnsureTrustedDirChain secures every path component of dir below root as a
// uid:gid-owned, mode-permissioned directory, using InstallDir's pinned,
// never-follow-symlink component walk to create or take ownership of each
// one. root itself (e.g. "/Library") is assumed already trustworthy and is
// only checked for existing as a real directory — its ownership is left
// alone, since the caller does not own it.
//
// A pre-existing component that is already safely owned (uid-owned, not
// group/other-writable) is left in place, with mode re-asserted. One that is
// NOT safely owned is only reused — and then repaired — when it is
// completely empty; a non-empty, unsafely-owned component is refused
// outright and left untouched, rather than silently taken over. This is
// what stops a directory someone else pre-planted (with content inside it)
// from being quietly adopted as root's own.
func EnsureTrustedDirChain(root, dir string, uid, gid int, mode os.FileMode) error {
	root = filepath.Clean(root)
	dir = filepath.Clean(dir)
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("%s is not below trusted root %s", dir, root)
	}
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return fmt.Errorf("stat trusted root %s: %w", root, err)
	}
	if rootInfo.Mode()&os.ModeSymlink != 0 || !rootInfo.IsDir() {
		return fmt.Errorf("trusted root %s must be a real directory, not a symlink", root)
	}

	current := root
	for _, seg := range strings.Split(rel, string(filepath.Separator)) {
		if err := ensureTrustedDirComponent(current, seg, uid, gid, mode); err != nil {
			return fmt.Errorf("%s: %w", filepath.Join(current, seg), err)
		}
		current = filepath.Join(current, seg)
	}
	return nil
}

// ensureTrustedDirComponent secures a single path component (base/name)
// without ever resolving a symlink at that component: an existing entry is
// inspected with StatFile (an O_NOFOLLOW open under the hood), and the
// eventual creation/ownership pass goes through InstallDir's own pinned,
// never-follow walk rather than any pathname-based mkdir/chown/chmod.
func ensureTrustedDirComponent(base, name string, uid, gid int, mode os.FileMode) error {
	dir := filepath.Join(base, name)
	info, statErr := StatFile(base, name)
	switch {
	case statErr == nil:
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("is a symlink; refusing to use it as a trusted directory")
		}
		if !info.IsDir() {
			return errors.New("exists and is not a directory; refusing to use it")
		}
		sys, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return errors.New("unable to read ownership")
		}
		safe := int(sys.Uid) == uid && info.Mode().Perm()&0o022 == 0
		if !safe {
			entries, rerr := os.ReadDir(dir)
			if rerr != nil {
				return fmt.Errorf("exists with unsafe ownership (uid=%d mode=%o) and could not be inspected for safe repair: %w",
					sys.Uid, info.Mode().Perm(), rerr)
			}
			if len(entries) != 0 {
				return fmt.Errorf("exists with unsafe ownership (uid=%d mode=%o) and is not empty; refusing to reuse it",
					sys.Uid, info.Mode().Perm())
			}
			// Empty and unsafely owned: safe to repair. The repair itself
			// still goes through InstallDir's pinned walk below, never a
			// pathname chown/chmod here.
		}
	case isRefusedSymlinkComponent(statErr):
		return errors.New("is a symlink; refusing to use it as a trusted directory")
	case os.IsNotExist(statErr):
		// Nothing there yet; InstallDir below creates it.
	default:
		return fmt.Errorf("stat: %w", statErr)
	}
	return InstallDir(base, name, mode, true, &Owner{UID: uid, GID: gid}, time.Time{})
}

// isRefusedSymlinkComponent reports whether err is the shape StatFile's
// underlying O_NOFOLLOW open returns for a symlink: ELOOP on Linux, ENOTDIR
// on darwin (darwin's answer for both a symlink and a plain file used as a
// directory under O_NOFOLLOW). Either way the component is refused, so a
// coarser classification here still fails closed.
func isRefusedSymlinkComponent(err error) bool {
	return errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR)
}
