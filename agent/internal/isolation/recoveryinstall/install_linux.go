//go:build linux

package recoveryinstall

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

// LinuxInstallDir is the Installer.InstallDir on Linux: recovery binaries live
// in versioned directories under it, outside the agent binary's own directory,
// so nothing that replaces the agent can touch them. install-linux.sh uses the
// same path.
const LinuxInstallDir = "/usr/local/lib/breeze"

// publishExclusive links the verified inode into place. Unlike rename, link
// cannot replace an existing executable. The caller unlinks the temporary name.
func publishExclusive(source, target string) error { return os.Link(source, target) }

// VerifyInstalled is the Linux trust check on an installed recovery binary. An
// injected Fetch has already verified the updater's signed manifest before any
// bytes were written; there is no per-file signature to check here, so what is
// left to prove is that nobody but root could have changed the file since.
func VerifyInstalled(path string) error {
	return verifyInstalled(path, func(p string) (os.FileMode, uint32, error) {
		info, err := os.Lstat(p)
		if err != nil {
			return 0, 0, err
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return 0, 0, errors.New("no owner information for the recovery binary")
		}
		return info.Mode(), st.Uid, nil
	})
}

func verifyInstalled(path string, stat func(string) (os.FileMode, uint32, error)) error {
	mode, uid, err := stat(path)
	if err != nil {
		return err
	}
	switch {
	case !mode.IsRegular():
		return fmt.Errorf("recovery binary %s is not a regular file", path)
	case uid != 0:
		return fmt.Errorf("recovery binary %s is owned by uid %d, not root", path, uid)
	case mode.Perm()&0o022 != 0:
		return fmt.Errorf("recovery binary %s is writable by group or others (%o)", path, mode.Perm())
	case mode.Perm()&0o100 == 0:
		return fmt.Errorf("recovery binary %s is not executable", path)
	}
	return nil
}
