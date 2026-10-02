package config

import (
	"errors"
	"fmt"
	"os"
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

// registeredUserWorkspace returns the registered workspace root, or "".
func registeredUserWorkspace() string {
	userWorkspace.mu.RLock()
	defer userWorkspace.mu.RUnlock()
	return userWorkspace.root
}

// inUserWorkspace reports whether path is the registered workspace or lies
// inside it.
func inUserWorkspace(path string) bool {
	root := registeredUserWorkspace()
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

// ErrConfigOutsideUserWorkspace is returned by every config load and persist
// that would bind, read or write an agent config outside the registered user
// workspace.
var ErrConfigOutsideUserWorkspace = errors.New("refusing to use an agent config outside this process's user workspace")

// checkConfigTarget enforces the workspace's second rule: a process that
// registered a user workspace loads and persists agent config only inside it
// (#7629). path is the agent.yaml or secrets.yaml about to be bound, read or
// written; "" means no config file is bound, which every persist path would
// otherwise resolve to the machine-wide default in ConfigDir.
//
// That fallback is the failure this guards. The Quick Support client enrolls
// into its workspace and then binds the workspace agent.yaml (BindConfigFile).
// If any mid-session persist (token rotation, mTLS renewal, manifest-key
// pinning, a SetAndPersist) ever ran unbound, it would land in the installed
// agent's ProgramData config: refused for a standard user, so the rotation
// breaks the session, and for an elevated administrator an overwrite of the
// installed agent's identity and credentials. Failing closed here turns
// both into an error the caller already handles.
//
// With no workspace registered (the installed agent, and every other command)
// it allows everything, so their behaviour is unchanged.
func checkConfigTarget(path string) error {
	root := registeredUserWorkspace()
	if root == "" {
		return nil
	}
	if path == "" {
		return fmt.Errorf("%w: no config file is bound, so this would use the machine-wide config in %s (workspace %s)",
			ErrConfigOutsideUserWorkspace, configDir(), root)
	}
	if !inUserWorkspace(path) {
		return fmt.Errorf("%w: %s is not inside %s", ErrConfigOutsideUserWorkspace, path, root)
	}
	return nil
}

// BindConfigFile makes cfgFile this process's active config file: what
// ActiveConfigFile returns, and the file every later persist reads and writes
// (SaveTo(cfg, ActiveConfigFile()), SetAndPersist, SetAllAndPersist, the
// credential stage/promote/clear writes to its sibling secrets.yaml,
// manifest-key pinning, Reload). The file is read in, so viper's state matches
// what is on disk before the first SetAndPersist re-serializes it.
//
// cfgFile must already exist, and inside a registered user workspace it must
// lie within it. A path outside the workspace, or a missing file, is refused
// before anything is bound. A file that exists but fails to read or validate
// may be left bound (viper binds before it reads); the caller must treat any
// error as fatal, as runSupportSession does.
//
// Load binds as a side effect; this exists for a caller that has just written
// its config somewhere other than the default path and must make sure the
// rest of the process follows it there. The Quick Support client calls it
// right after enrolling into its workspace (#7629).
func BindConfigFile(cfgFile string) error {
	abs, err := filepath.Abs(cfgFile)
	if err != nil {
		return fmt.Errorf("resolve config path %s: %w", cfgFile, err)
	}
	persistMu.Lock()
	defer persistMu.Unlock()
	if err := checkConfigTarget(abs); err != nil {
		return err
	}
	if _, err := os.Stat(abs); err != nil {
		return fmt.Errorf("bind config file: %w", err)
	}
	if _, err := loadLocked(abs); err != nil {
		return fmt.Errorf("bind config file %s: %w", abs, err)
	}
	return nil
}

// UserWorkspaceActive reports whether this process has registered a user
// workspace, i.e. is a support session keeping all its files in its private
// folder. ConfigDir, GetDataDir and LogDir already resolve there; code that
// would otherwise pick a location of its own (such as the per-user ~/.breeze
// dir) checks this instead.
func UserWorkspaceActive() bool { return registeredUserWorkspace() != "" }
