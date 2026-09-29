//go:build darwin || linux

package securefs

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// VerifyTrustedExecutableOwner checks that path — and the directory that
// contains it — are owned by root (uid 0) and not writable by their group or
// by anyone else. It exists for a root daemon (a launchd LaunchDaemon or a
// systemd unit) that execs a fixed path, such as /usr/local/bin/breeze-agent,
// which nothing else verifies the ownership of at install or start time.
//
// The directory check matters as much as the file check: even a root-owned,
// 0755 binary can be deleted and replaced by anyone who can write to its
// parent directory — file permission bits don't gate unlink/rename, the
// containing directory's do. This is exactly what a package manager (e.g.
// Homebrew on Intel, which chowns /usr/local/{bin,lib} to
// <admin user>:admin) can leave behind on a shared path.
//
// path must not be a symlink: a root-owned, root-only-writable symlink can
// still point at an untrusted target, so symlinks are refused outright.
func VerifyTrustedExecutableOwner(path string) error {
	if err := verifyTrustedRootOwnedPath(path, false); err != nil {
		return fmt.Errorf("executable %s: %w", path, err)
	}
	dir := filepath.Dir(path)
	if err := verifyTrustedRootOwnedPath(dir, true); err != nil {
		return fmt.Errorf("executable directory %s: %w", dir, err)
	}
	return nil
}

// LstatFunc is os.Lstat's shape, injectable so the ownership decision can be
// tested against root-owned fixtures without running as root.
type LstatFunc func(path string) (os.FileInfo, error)

// VerifyTrustedExecutablePathChain is VerifyTrustedExecutableOwner extended
// to every ancestor directory up to "/": each must be a real directory (not
// a symlink), owned by root, and not writable by group or other. A writable
// ancestor is as good as a writable parent — whoever can write it can
// rename the whole subtree away and put their own in its place.
//
// It is the single predicate the macOS relocation decision uses (#7211): a
// privileged daemon running from a location that passes stays where it is,
// because moving a bare binary invalidates its path-keyed TCC grants (Full
// Disk Access in particular). Only a location that fails is worth that cost.
func VerifyTrustedExecutablePathChain(path string) error {
	return VerifyTrustedExecutablePathChainFS(path, os.Lstat)
}

// VerifyTrustedExecutablePathChainFS is VerifyTrustedExecutablePathChain
// with an injectable Lstat. Any component that cannot be stat'd (missing,
// permission denied) fails the check: an unverifiable location is treated
// as unsafe.
func VerifyTrustedExecutablePathChainFS(path string, lstat LstatFunc) error {
	path = filepath.Clean(path)
	if !filepath.IsAbs(path) {
		return fmt.Errorf("executable %s: path must be absolute", path)
	}
	if err := verifyTrustedRootOwnedPathFS(path, false, lstat); err != nil {
		return fmt.Errorf("executable %s: %w", path, err)
	}
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		if err := verifyTrustedRootOwnedPathFS(dir, true, lstat); err != nil {
			return fmt.Errorf("directory %s: %w", dir, err)
		}
		if dir == "/" {
			return nil
		}
	}
}

func verifyTrustedRootOwnedPath(path string, mustBeDir bool) error {
	return verifyTrustedRootOwnedPathFS(path, mustBeDir, os.Lstat)
}

func verifyTrustedRootOwnedPathFS(path string, mustBeDir bool, lstat LstatFunc) error {
	info, err := lstat(path)
	if err != nil {
		return fmt.Errorf("stat: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("must not be a symlink")
	}
	if mustBeDir && !info.IsDir() {
		return errors.New("expected a directory")
	}
	sys, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("unable to read ownership")
	}
	if sys.Uid != 0 {
		return fmt.Errorf("not owned by root (uid %d)", sys.Uid)
	}
	// Deny any group or other write bit. This is intentionally stricter than
	// "no world write" alone: a root:admin, group-writable directory (the
	// Homebrew-on-Intel shape) is exactly the case this exists to catch.
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("group- or world-writable (mode %o)", info.Mode().Perm())
	}
	return nil
}
