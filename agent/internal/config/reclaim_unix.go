//go:build !windows

package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// reclaimConfigFileModes are the files whose contents the agent loads as its
// configuration and identity, with the mode each gets when it has to be taken
// back Another account that could write one of these could point the
// agent at a server, pin update-signing keys or name programs it runs.
var reclaimConfigFileModes = map[string]uint32{
	"agent.yaml":        0o644,
	"secrets.yaml":      0o600,
	"helper_token.yaml": 0o600, // the agent restores root:breeze 0640 on start
}

// Seams: the unit tests run unprivileged, so they cannot create root-owned
// files or chown.
var (
	reclaimGeteuidFn  = os.Geteuid
	reclaimOwnerUIDFn = func(_ string, fi os.FileInfo) uint32 {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			return st.Uid
		}
		return ^uint32(0) // unknown owner: treat as untrusted
	}
	reclaimLchownFn = func(path string) error { return os.Lchown(path, 0, -1) }
)

func reclaimConfigDir(root string, forEnroll bool) error {
	return reclaimUnixDir(root, true, forEnroll)
}

// reclaimSeparateDataDir takes back the data dir when it is not inside the
// config dir (Linux: /var/lib/breeze). It holds no config files.
func reclaimSeparateDataDir() error {
	data, root := GetDataDir(), ConfigDir()
	if data == root || strings.HasPrefix(data, root+string(filepath.Separator)) {
		return nil
	}
	return reclaimUnixDir(data, false, false)
}

func reclaimUnixDir(root string, configDir, forEnroll bool) error {
	fi, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: %s is a symbolic link to another location; remove it and install the agent again", ErrConfigDirUntrusted, root)
	}
	if !fi.IsDir() {
		return fmt.Errorf("%w: %s is not a directory", ErrConfigDirUntrusted, root)
	}
	if reclaimGeteuidFn() != 0 {
		return nil
	}
	untrusted, err := reclaimUnixEntry(root, fi, fi.Mode().Perm()&^0o022)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	if untrusted {
		log.Warn("The agent folder was created or changed by another account; taking it back", "dir", root)
	}
	if err := reclaimUnixContents(root, configDir, forEnroll, untrusted); err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	return nil
}

// reclaimUnixEntry makes path root-owned with mode want when another account
// owns it or it is group/world-writable, and reports whether it was.
func reclaimUnixEntry(path string, fi os.FileInfo, want os.FileMode) (bool, error) {
	uid := reclaimOwnerUIDFn(path, fi)
	perm := fi.Mode().Perm()
	if uid == 0 && perm&0o022 == 0 {
		return false, nil
	}
	if uid != 0 {
		if err := reclaimLchownFn(path); err != nil {
			return true, fmt.Errorf("take back %s from uid %d: %w", path, uid, err)
		}
	}
	if perm != want {
		if err := os.Chmod(path, want); err != nil {
			return true, fmt.Errorf("set mode of %s: %w", path, err)
		}
	}
	return true, nil
}

// reclaimUnixContents sweeps dir without following links. With all set every
// subtree is swept; otherwise dir's entries and the subtrees under entries
// another account controlled.
func reclaimUnixContents(dir string, configDir, forEnroll, all bool) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("list %s: %w", dir, err)
	}
	for _, e := range entries {
		p := filepath.Join(dir, e.Name())
		fi, err := os.Lstat(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		uid := reclaimOwnerUIDFn(p, fi)
		if fi.Mode()&os.ModeSymlink != 0 {
			if uid != 0 {
				if err := os.Remove(p); err != nil {
					return fmt.Errorf("remove link %s planted by uid %d: %w", p, uid, err)
				}
				log.Warn("Removed a link another account planted in the agent folder; its target was left untouched", "path", p)
			}
			continue
		}
		want := fi.Mode().Perm() &^ 0o022
		configMode, isConfig := reclaimConfigFileModes[e.Name()]
		// configDir is only set for the folder's own entries, not in recursion.
		isConfig = isConfig && configDir && !fi.IsDir()
		if isConfig {
			want = os.FileMode(configMode)
			if (uid != 0 || fi.Mode().Perm()&0o022 != 0) && forEnroll {
				if err := os.Remove(p); err != nil {
					return fmt.Errorf("remove %s, which another account could write: %w", p, err)
				}
				log.Warn("Removed a config file another account could have written; enrollment writes a new one", "path", p, "uid", uid)
				continue
			}
		}
		untrusted, err := reclaimUnixEntry(p, fi, want)
		if err != nil {
			return err
		}
		if untrusted && isConfig {
			log.Warn("Re-secured a config file another account could have written; check its contents", "path", p, "uid", uid)
		}
		if fi.IsDir() && (all || untrusted) {
			if err := reclaimUnixContents(p, false, forEnroll, true); err != nil {
				return err
			}
		}
	}
	return nil
}
