//go:build !windows

package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// reclaimConfigFileModes are the files whose contents the agent loads as its
// configuration and identity, with the mode a fresh copy gets.
var reclaimConfigFileModes = map[string]os.FileMode{
	"agent.yaml":        0o644,
	"secrets.yaml":      0o600,
	"helper_token.yaml": 0o600, // the agent restores root:breeze 0640 on start
}

// reclaimSkipDirs are left alone when they are real directories root owns:
// sessions/<key> is owned by the session user by design (helper/manager.go).
var reclaimSkipDirs = map[string]bool{"sessions": true}

// settleQuarantineDir leaves root/quarantine in place only as a real
// directory root owns. Another account's symlink there is removed; anything
// else of theirs by that name is renamed out of the way and then set aside
// into the (new) quarantine like any other entry.
func settleQuarantineDir(q *quarantine) error {
	qpath := filepath.Join(q.root, reclaimQuarantineDir)
	fi, err := os.Lstat(qpath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink == 0 && fi.IsDir() && reclaimOwnerUIDFn(qpath, fi) == 0 {
		return nil
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		log.Warn("Removed a planted link named quarantine from the agent folder", "path", qpath)
		return os.Remove(qpath)
	}
	moved := qpath + ".untrusted-" + time.Now().UTC().Format("20060102T150405.000000000Z")
	if err := os.Rename(qpath, moved); err != nil {
		return fmt.Errorf("move a planted %s out of the way: %w", qpath, err)
	}
	log.Warn("Set aside a planted entry named quarantine from the agent folder", "path", qpath)
	return q.move(moved, reclaimQuarantineDir)
}

// reclaimHelperLog is written into the folder by the Breeze Assist helper as
// the logged-in user on macOS (the folder is group-writable there); a log is
// left alone rather than set aside on every start.
const reclaimHelperLog = "helper.log"

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
	// root owner and group (0): the group was the other account's choice.
	reclaimLchownFn = func(path string) error { return os.Lchown(path, 0, 0) }
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

// Only world write marks a root-owned entry as writable by another account,
// not group write. Group write is part of the agent's own layout: the macOS
// installer makes the config dir 0770 so the user-context helpers can reach
// it, and the IPC socket is 0660. Treating group write as untrusted would set
// those aside on every start and break the helpers. The group of a folder
// root owns is chosen by the installer, not by another account, and the take
// back of a folder another account owned clears group write as well.
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
	// Support) is root's, so the path cannot be swapped underneath, and on
	// Unix a permission change applies to every later operation at once.
	if uid := reclaimOwnerUIDFn(root, fi); uid != 0 {
		log.Warn("The agent folder was created by another account; taking it back", "dir", root, "uid", uid)
		if err := reclaimLchownFn(root); err != nil {
			return fmt.Errorf("%w: take back %s: %v", ErrConfigDirUntrusted, root, err)
		}
		// The group was that account's choice too: no group write.
		if err := os.Chmod(root, fi.Mode().Perm()&^0o022); err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
	} else if perm := fi.Mode().Perm(); perm&reclaimOtherWrite != 0 {
		if err := os.Chmod(root, perm&^reclaimOtherWrite); err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
	}

	// The quarantine folder first, before anything is moved into it: unless
	// it is a real directory root owns, a planted one (a symlink especially)
	// would redirect every move below.
	q := quarantine{root: root}
	if err := settleQuarantineDir(&q); err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("%w: list %s: %v", ErrConfigDirUntrusted, root, err)
	}
	for _, e := range entries {
		if e.Name() == reclaimQuarantineDir {
			continue // settled above
		}
		p := filepath.Join(root, e.Name())
		efi, err := os.Lstat(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue // removed since the listing
			}
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		uid := reclaimOwnerUIDFn(p, efi)
		isLink := efi.Mode()&os.ModeSymlink != 0
		if reclaimSkipDirs[e.Name()] && efi.IsDir() && !isLink && uid == 0 {
			continue
		}
		if e.Name() == reclaimHelperLog && efi.Mode().IsRegular() {
			continue
		}
		if isLink {
			if uid != 0 {
				if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
					return fmt.Errorf("%w: remove the link %s: %v", ErrConfigDirUntrusted, p, err)
				}
				log.Warn("Removed a link another account planted in the agent folder; its target was left untouched", "path", p)
			}
			continue
		}
		mode, isConfig := reclaimConfigFileModes[e.Name()]
		isConfig = isConfig && configDir && efi.Mode().IsRegular()
		if uid == 0 {
			// Root's own entry, at most world-writable: fixed in place (it
			// and its parent are root's, so the path cannot be swapped).
			if efi.Mode().Perm()&reclaimOtherWrite != 0 {
				want := efi.Mode().Perm() &^ reclaimOtherWrite
				if isConfig {
					want = mode
				}
				if err := os.Chmod(p, want); err != nil {
					return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
				}
			}
			continue
		}
		// Another account's entry: set aside, unread, never walked into,
		// chowned or (for a config file) adopted.
		if err := q.move(p, e.Name()); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue // removed since the listing
			}
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		switch {
		case isConfig && forEnroll:
			log.Warn("Set aside a config file another account wrote; enrollment writes a new one", "path", p, "uid", uid)
		case isConfig:
			log.Warn("Set aside a config file another account wrote; the agent starts unenrolled", "path", p, "uid", uid)
		default:
			log.Warn("Set aside an entry another account controlled in the agent folder", "path", p, "uid", uid)
		}
	}
	return nil
}

// reclaimQuarantineDir is the folder entries are set aside in, inside the
// config folder (so it is as private as the folder).
const reclaimQuarantineDir = "quarantine"

type quarantine struct{ root, dir string }

// move renames path (an entry of q.root, which the caller has already taken
// back) into this run's quarantine folder. A rename moves the entry itself:
// a link is moved, not followed.
func (q *quarantine) move(path, name string) error {
	if q.dir == "" {
		q.dir = filepath.Join(q.root, reclaimQuarantineDir, time.Now().UTC().Format("20060102T150405.000000000Z"))
		if err := os.MkdirAll(q.dir, 0o700); err != nil {
			return fmt.Errorf("create %s: %w", q.dir, err)
		}
	}
	if err := os.Rename(path, filepath.Join(q.dir, name)); err != nil {
		return fmt.Errorf("set aside %s: %w", path, err) // %w keeps os.IsNotExist working
	}
	return nil
}
