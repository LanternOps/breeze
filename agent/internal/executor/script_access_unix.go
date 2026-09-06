//go:build !windows

package executor

import (
	"fmt"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func prepareScriptForRunAs(scriptPath, runAs string) error {
	target := strings.TrimSpace(runAs)
	if target == "" || strings.EqualFold(target, "system") || strings.EqualFold(target, "root") || strings.EqualFold(target, "elevated") {
		return nil
	}
	account, err := user.Lookup(target)
	if err != nil {
		return fmt.Errorf("resolve runAs user: %w", err)
	}
	uid, err := strconv.Atoi(account.Uid)
	if err != nil {
		return fmt.Errorf("parse runAs uid: %w", err)
	}
	gid, err := strconv.Atoi(account.Gid)
	if err != nil {
		return fmt.Errorf("parse runAs gid: %w", err)
	}
	scriptDir := filepath.Dir(scriptPath)
	dirFD, err := unix.Open(scriptDir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open private script directory without following links: %w", err)
	}
	defer unix.Close(dirFD)
	fileFD, err := unix.Openat(dirFD, filepath.Base(scriptPath), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return fmt.Errorf("open private script file without following links: %w", err)
	}
	defer unix.Close(fileFD)
	var stat unix.Stat_t
	if err := unix.Fstat(fileFD, &stat); err != nil {
		return fmt.Errorf("inspect private script file: %w", err)
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG {
		return fmt.Errorf("private script path is not a regular file")
	}

	// Transfer the pinned file first while the target still cannot traverse
	// the root-owned 0700 directory. Transfer the pinned directory last. No
	// privileged path-following operation occurs after the target gains access.
	if err := unix.Fchown(fileFD, uid, gid); err != nil {
		return fmt.Errorf("transfer private script file: %w", err)
	}
	if err := unix.Fchown(dirFD, uid, gid); err != nil {
		return fmt.Errorf("transfer private script directory: %w", err)
	}
	return nil
}
