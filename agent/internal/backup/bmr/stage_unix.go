//go:build !windows

package bmr

import (
	"fmt"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// newFileModeWithoutRecord is the mode a new target gets when its manifest
// entry records none (a pre-fidelity manifest): the default a file created
// under the usual 022 umask has.
const newFileModeWithoutRecord os.FileMode = 0o644

// createStagingFile creates path exclusively (never through a link) with
// mode 0600, and sets 0600 again explicitly so the umask cannot matter.
func createStagingFile(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return nil, err
	}
	return f, nil
}

// applyStagedMetadata gives the staged file, through its handle, the
// ownership, permissions and times the restored file should have:
//
//   - owner: an existing regular target's uid/gid; otherwise the manifest
//     entry's recorded owner, when it has one;
//   - mode: the manifest entry's recorded mode when it has one (as the
//     unattested path reapplies it); otherwise an existing target's mode;
//     otherwise newFileModeWithoutRecord;
//   - mtime/atime: the manifest entry's ModTime, when recorded.
//
// Each step is best effort: a failure is returned as a fidelity message and
// the staged file keeps its private 0600 mode or current owner.
func applyStagedMetadata(f *os.File, targetPath string, file manifestFile) []string {
	var fidelity []string
	uid, gid := -1, -1
	mode := newFileModeWithoutRecord
	if fi, err := os.Lstat(targetPath); err == nil && fi.Mode().IsRegular() {
		if st, ok := fi.Sys().(*syscall.Stat_t); ok {
			uid, gid = int(st.Uid), int(st.Gid)
		}
		mode = fi.Mode() & (os.ModePerm | os.ModeSetuid | os.ModeSetgid | os.ModeSticky)
	} else if file.Owner != nil {
		uid, gid = file.Owner.UID, file.Owner.GID
	}
	if file.Mode != 0 {
		mode = os.FileMode(file.Mode).Perm()
	}

	if uid >= 0 {
		if err := chownStagedIfDifferent(f, uid, gid); err != nil {
			fidelity = append(fidelity, fmt.Sprintf("could not apply owner %d:%d: %s", uid, gid, err.Error()))
		}
	}
	// After the chown, which clears setuid/setgid.
	if err := f.Chmod(mode); err != nil {
		fidelity = append(fidelity, fmt.Sprintf("could not apply mode %o: %s", mode, err.Error()))
	}
	if !file.ModTime.IsZero() {
		tv := unix.NsecToTimeval(file.ModTime.UnixNano())
		if err := unix.Futimes(int(f.Fd()), []unix.Timeval{tv, tv}); err != nil {
			fidelity = append(fidelity, fmt.Sprintf("could not apply mtime: %s", err.Error()))
		}
	}
	return fidelity
}

func chownStagedIfDifferent(f *os.File, uid, gid int) error {
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) == uid && int(st.Gid) == gid {
		return nil
	}
	return f.Chown(uid, gid)
}

// stagingLeftoverOwned reports whether a leftover staging file belongs to
// this process's account, so a sweep never removes another account's file.
func stagingLeftoverOwned(_ string, info os.FileInfo) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(st.Uid) == os.Geteuid()
}

// applyPublishedAttributes runs the steps that can only follow the rename.
// Off Windows there are none beyond the (no-op) Windows attributes.
func applyPublishedAttributes(targetPath string, file manifestFile) []string {
	if err := applyWinAttrsFile(targetPath, file.WinAttrs); err != nil {
		return []string{fmt.Sprintf("could not reapply windows attributes: %s", err.Error())}
	}
	return nil
}
