//go:build darwin

package securefs

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// ExecutableMigrationFS is the small set of filesystem operations
// MigrateExecutableToTrustedDir needs, extracted as an interface so its
// decision logic can be unit tested without real root or a real filesystem.
type ExecutableMigrationFS interface {
	MkdirAll(path string, perm os.FileMode) error
	Chown(path string, uid, gid int) error
	Chmod(path string, perm os.FileMode) error
	// Copy copies the file at srcPath to dstPath, creating dstPath (or
	// replacing it) with the copied bytes. Implementations should write via
	// a temp file + rename so a half-copied binary is never observable at
	// dstPath.
	Copy(dstPath, srcPath string) error
}

// osExecutableMigrationFS implements ExecutableMigrationFS against the real
// filesystem; it's what production uses. Tests inject a fake instead.
type osExecutableMigrationFS struct{}

// MkdirAll secures path as a root-owned (uid/gid 0), non-group/other-
// writable directory, all the way down from TrustedExecutableDirRoot: every
// component is Lstat'd and refused if it's a symlink, and a pre-existing,
// unsafely-owned component is only reused (and repaired) when it is
// completely empty. See EnsureTrustedDirChain for the full contract. perm
// is applied to every component created or repaired this way, not just the
// leaf.
func (osExecutableMigrationFS) MkdirAll(path string, perm os.FileMode) error {
	return EnsureTrustedDirChain(TrustedExecutableDirRoot, path, 0, 0, perm)
}

// Chown refuses to follow a symlink at path before chowning it: MkdirAll
// above already leaves path root-owned, so this is a second, independent
// guard against the narrow window between that call returning and this one
// running, not the primary defense.
func (osExecutableMigrationFS) Chown(path string, uid, gid int) error {
	if err := refuseSymlink(path); err != nil {
		return err
	}
	return os.Chown(path, uid, gid)
}

// Chmod is Chown's symlink guard applied to os.Chmod, for the same reason.
func (osExecutableMigrationFS) Chmod(path string, perm os.FileMode) error {
	if err := refuseSymlink(path); err != nil {
		return err
	}
	return os.Chmod(path, perm)
}

// refuseSymlink Lstat's path and returns an error if it is a symlink (or
// doesn't exist — nothing to chown/chmod). It never follows the entry.
func refuseSymlink(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("stat %s: %w", path, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symlink; refusing to operate on it", path)
	}
	return nil
}

// Copy publishes srcPath's bytes at dstPath without ever following a
// symlink: it refuses if dstPath's containing directory isn't a real
// directory, writes into a private O_CREATE|O_EXCL|O_NOFOLLOW temp file (so
// a pre-planted symlink at the temp name is refused rather than written
// through), applies mode to the open descriptor — never by pathname — then
// renames the temp file into place. Rename replaces whatever directory
// entry currently sits at dstPath (including a pre-existing symlink there)
// without ever traversing it. Ownership is left to the caller's subsequent
// Chown call (MigrateExecutableToTrustedDir always makes one): this method
// only ever runs as whoever is doing the copy, so a real chown to root
// belongs to the step that already requires and checks for that
// privilege, not duplicated here.
func (osExecutableMigrationFS) Copy(dstPath, srcPath string) error {
	dir := filepath.Dir(dstPath)
	dirInfo, err := os.Lstat(dir)
	if err != nil {
		return fmt.Errorf("stat destination directory %s: %w", dir, err)
	}
	if dirInfo.Mode()&os.ModeSymlink != 0 || !dirInfo.IsDir() {
		return fmt.Errorf("destination directory %s is not a real directory; refusing to write through it", dir)
	}

	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer src.Close()

	tmp := filepath.Join(dir, fmt.Sprintf(".%s.migrating-%d", filepath.Base(dstPath), os.Getpid()))
	dst, err := os.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			os.Remove(tmp)
		}
	}()

	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		return err
	}
	// Mode goes on the open descriptor (fchmod via *os.File, not a pathname
	// chmod applied by name after the fact), so it always lands on the file
	// this call itself created, regardless of what the name resolves to
	// afterward.
	if err := dst.Chmod(0o755); err != nil {
		dst.Close()
		return err
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		return err
	}
	if err := dst.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, dstPath); err != nil {
		return err
	}
	committed = true

	// Verify what actually landed: the rename must have produced a plain
	// regular file at dstPath, not something a race slipped in instead.
	final, err := os.Lstat(dstPath)
	if err != nil {
		return fmt.Errorf("verify published %s: %w", dstPath, err)
	}
	if final.Mode()&os.ModeSymlink != 0 || !final.Mode().IsRegular() {
		return fmt.Errorf("published %s is not a regular file", dstPath)
	}
	return nil
}

// DefaultExecutableMigrationFS is the production ExecutableMigrationFS.
var DefaultExecutableMigrationFS ExecutableMigrationFS = osExecutableMigrationFS{}

// MigrateExecutableToTrustedDir copies the binary at legacyPath into
// trustedDir — creating trustedDir root:wheel 0755 first if needed — then
// chowns the copy to root:wheel (uid/gid 0) and mode 0755. It returns the
// new path. legacyPath is left untouched: the caller decides when it's safe
// to remove (e.g. only after the daemon that execs it has been repointed at
// the new path and reloaded).
//
// fs may be nil, in which case DefaultExecutableMigrationFS is used; tests
// inject a fake to exercise this without root or a real filesystem.
func MigrateExecutableToTrustedDir(fs ExecutableMigrationFS, legacyPath, trustedDir string) (string, error) {
	if fs == nil {
		fs = DefaultExecutableMigrationFS
	}
	if err := fs.MkdirAll(trustedDir, 0o755); err != nil {
		return "", fmt.Errorf("create trusted directory %s: %w", trustedDir, err)
	}
	if err := fs.Chown(trustedDir, 0, 0); err != nil {
		return "", fmt.Errorf("chown trusted directory %s: %w", trustedDir, err)
	}
	if err := fs.Chmod(trustedDir, 0o755); err != nil {
		return "", fmt.Errorf("chmod trusted directory %s: %w", trustedDir, err)
	}
	dst := filepath.Join(trustedDir, filepath.Base(legacyPath))
	if err := fs.Copy(dst, legacyPath); err != nil {
		return "", fmt.Errorf("copy %s to %s: %w", legacyPath, dst, err)
	}
	if err := fs.Chown(dst, 0, 0); err != nil {
		return "", fmt.Errorf("chown %s: %w", dst, err)
	}
	if err := fs.Chmod(dst, 0o755); err != nil {
		return "", fmt.Errorf("chmod %s: %w", dst, err)
	}
	return dst, nil
}
