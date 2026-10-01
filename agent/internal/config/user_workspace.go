package config

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// A user workspace is a directory private to the account running this
// process, used instead of the machine-wide config dir by a client that is
// not an installed agent: the Quick Support client, which an end user runs
// without elevation and which keeps its agent.yaml, secrets.yaml and log in
// %TEMP%\breeze-support-<pid> (#7620).
//
// The machine-wide policy cannot apply there. On Windows it names SYSTEM (or,
// failing that, BUILTIN\Administrators) as owner, and a standard user's token
// may assign neither: it may only name itself, or a group it holds with
// SE_GROUP_OWNER. It also grants BUILTIN\Users read so the Breeze Helper can
// read agent.yaml, which a per-user workspace must not do, and denies the
// user write access to its own files. Instead, every directory and file inside
// a registered workspace is secured as:
//
//   - Windows: owner = the caller's own user SID, PROTECTED DACL granting that
//     user, SYSTEM and Administrators full control and nobody else. The
//     workspace directory itself is created atomically with that descriptor,
//     opened without following reparse points, re-secured through the handle
//     and checked to still be the same directory afterwards, so a planted
//     junction or symlink is refused rather than followed.
//   - Unix: the directory is 0700 and must be a real directory (not a
//     symlink) owned by this process's effective uid; files are 0600.
//
// Paths outside the workspace are untouched: the installed agent's
// ProgramData / /etc config dir keeps exactly the policy it had (including
// the #7394 elevated-administrator owner fallback), so a standard user still
// cannot claim the machine-wide config dir.
//
// One workspace per process: a process runs a single command, and only the
// support command registers one.
var userWorkspace struct {
	mu   sync.RWMutex
	root string
}

// SecureUserWorkspace creates dir (or re-secures it if it already exists) as
// private to the user running this process, then registers it so that every
// later config-dir, agent.yaml and secrets.yaml permission write inside it
// uses the user-private policy described above. It fails, and registers
// nothing, when dir is a reparse point / symlink, is not a directory, or
// cannot be secured (for example a directory another user owns).
func SecureUserWorkspace(dir string) error {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return fmt.Errorf("resolve workspace path %s: %w", dir, err)
	}
	if err := secureUserWorkspaceDir(abs); err != nil {
		return err
	}
	userWorkspace.mu.Lock()
	userWorkspace.root = abs
	userWorkspace.mu.Unlock()
	return nil
}

// resetUserWorkspaceForTest clears the registration.
func resetUserWorkspaceForTest() {
	userWorkspace.mu.Lock()
	userWorkspace.root = ""
	userWorkspace.mu.Unlock()
}

// inUserWorkspace reports whether path is the registered workspace or lies
// inside it.
func inUserWorkspace(path string) bool {
	userWorkspace.mu.RLock()
	root := userWorkspace.root
	userWorkspace.mu.RUnlock()
	if root == "" {
		return false
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	return pathWithin(root, abs, runtime.GOOS == "windows")
}

// pathWithin reports whether path equals root or is a descendant of it. Both
// must be absolute and clean (filepath.Abs output). foldCase compares the way
// NTFS resolves names. A sibling that merely shares the prefix
// (breeze-support-12 vs breeze-support-123) is not within.
func pathWithin(root, path string, foldCase bool) bool {
	if foldCase {
		root, path = strings.ToLower(root), strings.ToLower(path)
	}
	if path == root {
		return true
	}
	prefix := root
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(path, prefix)
}
