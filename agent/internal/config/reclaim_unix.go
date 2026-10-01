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
// configuration and identity, with the mode a fresh copy gets.
var reclaimConfigFileModes = map[string]os.FileMode{
	"agent.yaml":        0o644,
	"secrets.yaml":      0o600,
	"helper_token.yaml": 0o600, // the agent restores root:breeze 0640 on start
}

// reclaimSkipEntries are left alone: sessions/<key> is owned by the session
// user by design (helper/manager.go), and its parent is root-owned.
var reclaimSkipEntries = map[string]bool{"sessions": true, reclaimQuarantineDir: true}

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

// Only world write marks an entry as writable by another account: group
// write is part of the agent's own layout (the macOS installer makes the
// config dir 0770, the IPC socket is 0660).
const reclaimOtherWrite = 0o002

func reclaimUnixDir(root string, configDir, forEnroll bool) error {
	fi, err := os.Lstat(root)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		// An administrator may move the folder and leave a root-owned
		// symlink; another account's symlink is not followed.
		if uid := reclaimOwnerUIDFn(root, fi); uid != 0 {
			return fmt.Errorf("%w: %s is a symbolic link owned by uid %d, not root", ErrConfigDirUntrusted, root, uid)
		}
		target, err := filepath.EvalSymlinks(root)
		if err != nil {
			return fmt.Errorf("%w: resolve %s: %v", ErrConfigDirUntrusted, root, err)
		}
		root = target
		if fi, err = os.Lstat(root); err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
	}
	if !fi.IsDir() {
		return fmt.Errorf("%w: %s is not a directory", ErrConfigDirUntrusted, root)
	}
	if reclaimGeteuidFn() != 0 {
		return nil
	}

	// The folder itself. Its parent (/etc, /var/lib, /Library/Application
	// Support) is root's, so the path cannot be swapped underneath.
	if uid := reclaimOwnerUIDFn(root, fi); uid != 0 {
		log.Warn("The agent folder was created by another account; taking it back", "dir", root, "uid", uid)
		if err := reclaimLchownFn(root); err != nil {
			return fmt.Errorf("%w: take back %s: %v", ErrConfigDirUntrusted, root, err)
		}
	}
	if perm := fi.Mode().Perm(); perm&reclaimOtherWrite != 0 {
		if err := os.Chmod(root, perm&^reclaimOtherWrite); err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("%w: list %s: %v", ErrConfigDirUntrusted, root, err)
	}
	q := quarantine{root: root}
	type configFile struct {
		path, name string
		mode       os.FileMode
	}
	var configFiles []configFile
	for _, e := range entries {
		if reclaimSkipEntries[e.Name()] {
			continue
		}
		p := filepath.Join(root, e.Name())
		efi, err := os.Lstat(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		uid := reclaimOwnerUIDFn(p, efi)
		if efi.Mode()&os.ModeSymlink != 0 {
			if uid != 0 {
				if err := os.Remove(p); err != nil {
					return fmt.Errorf("%w: remove the link %s: %v", ErrConfigDirUntrusted, p, err)
				}
				log.Warn("Removed a link another account planted in the agent folder; its target was left untouched", "path", p)
			}
			continue
		}
		worldWritable := efi.Mode().Perm()&reclaimOtherWrite != 0
		if uid == 0 && !worldWritable {
			continue
		}
		if mode, ok := reclaimConfigFileModes[e.Name()]; ok && configDir && efi.Mode().IsRegular() {
			if forEnroll && uid != 0 {
				if err := q.move(p, e.Name()); err != nil {
					return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
				}
				log.Warn("Set aside a config file another account wrote; enrollment writes a new one", "path", p, "uid", uid)
				continue
			}
			configFiles = append(configFiles, configFile{p, e.Name(), mode})
			continue
		}
		if uid == 0 {
			// Root's own entry, only world-writable: the path is root's
			// and its parent is too, so it cannot be swapped.
			if err := os.Chmod(p, efi.Mode().Perm()&^reclaimOtherWrite); err != nil {
				return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
			}
			continue
		}
		// Another account's entry: set aside, not walked into or chowned.
		if err := q.move(p, e.Name()); err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		log.Warn("Set aside an entry another account controlled in the agent folder", "path", p, "uid", uid)
	}

	for _, f := range configFiles {
		data, err := os.ReadFile(f.path)
		if err != nil {
			return fmt.Errorf("%w: read %s: %v", ErrConfigDirUntrusted, f.path, err)
		}
		// The original is set aside (a handle another account holds then
		// reaches that copy), and a new root-owned file with an explicit
		// mode (no setuid survives) is written in its place.
		if err := q.move(f.path, f.name); err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		if err := atomicWriteFile(f.path, data, f.mode); err != nil {
			return fmt.Errorf("%w: rewrite %s: %v", ErrConfigDirUntrusted, f.path, err)
		}
		log.Warn("Replaced a config file another account could write with a fresh copy; check its contents", "path", f.path)
	}
	return nil
}
