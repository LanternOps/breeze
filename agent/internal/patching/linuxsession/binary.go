package linuxsession

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

var (
	// ErrUnsupportedPlatform is returned by the exec surface on every OS but
	// Linux, so callers can compile against it everywhere.
	ErrUnsupportedPlatform = errors.New("graphical session dialogs are supported on Linux only")
	// ErrRefusedRootSession guards the one thing this package exists to
	// prevent: a dialog rendered with the daemon's privileges.
	ErrRefusedRootSession = errors.New("refusing to run a session dialog as uid 0")
	// ErrCannotDropPrivileges means the agent is neither root nor the session
	// user, so there is no way to reach the session without escalating.
	ErrCannotDropPrivileges = errors.New("cannot drop privileges to the session user")
	// ErrBinaryNotFound means the requested helper binary is not installed in
	// any of the root-owned directories this package will run from.
	ErrBinaryNotFound = errors.New("binary not found in the system path")
)

// systemBinaryDirs is the fixed search path for a binary the daemon will spawn.
//
// Deliberately not os/exec.LookPath: LookPath reads $PATH, and the daemon's
// $PATH comes from its unit file or from whatever launched it. Resolving a
// binary that will be executed against a user's display through an inheritable
// variable is the one hijack this path is worth closing, and every directory
// here is root-writable only on a sane system.
var systemBinaryDirs = []string{"/usr/local/bin", "/usr/bin", "/bin"}

// ResolveSystemBinary finds an executable by bare name in systemBinaryDirs.
func ResolveSystemBinary(name string) (string, error) {
	return resolveSystemBinary(name, os.Stat)
}

// resolveSystemBinary is ResolveSystemBinary with the filesystem injected, so
// the "present", "absent" and "present but not executable" branches are covered
// without needing zenity installed in CI.
func resolveSystemBinary(name string, stat func(string) (fs.FileInfo, error)) (string, error) {
	// A bare name only. A caller passing a path would bypass the fixed search
	// directories entirely, which is the whole protection.
	if name == "" || strings.ContainsRune(name, filepath.Separator) {
		return "", fmt.Errorf("%q is not a bare binary name: %w", name, ErrBinaryNotFound)
	}
	for _, dir := range systemBinaryDirs {
		candidate := filepath.Join(dir, name)
		info, err := stat(candidate)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("%s: %w", name, ErrBinaryNotFound)
}
