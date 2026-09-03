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
// binary that will be executed inside a user's graphical session through an
// inheritable variable is the first hijack worth closing.
//
// /usr/local/bin is deliberately ABSENT, and its absence is the second. Debian
// Policy makes /usr/local/bin root:staff mode 02775 — group-writable by
// "staff", a documented local-admin-but-not-root group — so including it would
// let a staff member plant a "zenity" that the daemon then runs under ANOTHER
// signed-in user's uid, and whose exit code decides whether that user's reboot
// was postponed. Neither zenity nor notify-send is ever installed there by a
// package manager, so the directory buys nothing to offset that.
var systemBinaryDirs = []string{"/usr/bin", "/bin"}

// ResolveSystemBinary finds an executable by bare name in systemBinaryDirs.
func ResolveSystemBinary(name string) (string, error) {
	return resolveSystemBinary(name, os.Stat)
}

// binaryOwnershipOK reports whether a resolved binary is owned by root and not
// writable by anyone else. Replaced on Linux (binary_linux.go); a permissive
// stub elsewhere, where this package's exec surface is unreachable anyway.
//
// A variable so the check is injectable: the "world-writable binary" branch has
// to be covered somewhere, and CI cannot be asked to create one.
var binaryOwnershipOK = func(fs.FileInfo) bool { return true }

// resolveSystemBinary is ResolveSystemBinary with the filesystem injected, so
// the "present", "absent", "not executable", "setuid" and "not root-owned"
// branches are covered without needing zenity installed in CI.
//
// What this does and does not establish. The fixed directory list removes $PATH
// as an input, which is the one thing a local user can influence; the mode and
// ownership checks reject a binary that is itself a privilege-escalation
// vehicle (setuid/setgid) or that a non-root user could have replaced. What
// remains is a TOCTOU window between this stat and the exec, and the assumption
// that /usr/bin and its siblings are root-owned. Closing either would need
// fexecve or a signed-binary policy; both are far outside this wave, and an
// attacker who can write into /usr/bin already owns the machine. Note that this
// is strictly stronger than the rest of the repo, which invokes loginctl and
// shutdown by bare name through $PATH.
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
		// A setuid or setgid helper would regain privilege the moment it ran,
		// making the credential drop that spawns it decorative.
		if info.Mode()&(fs.ModeSetuid|fs.ModeSetgid) != 0 {
			continue
		}
		if !binaryOwnershipOK(info) {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("%s: %w", name, ErrBinaryNotFound)
}
