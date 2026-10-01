//go:build windows

package config

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
)

// reclaimConfigFiles are the files whose contents the agent loads as its
// configuration and identity, with the descriptor each gets.
var reclaimConfigFiles = map[string]string{
	"agent.yaml":   windowsConfigFileSDDL,
	"secrets.yaml": windowsSecretFileSDDL,
}

// Seams for tests.
var (
	secureConfigRootFn    = secureMainAgentConfigDir
	createConfigRootDirFn = createMainAgentDirectory
)

// The data dir is inside the config dir on Windows.
func reclaimSeparateDataDir() error { return nil }

// reclaimConfigDir: see ReclaimConfigDir. On Windows, taking a folder back in
// place is not enough: access is checked when a handle is opened, so a
// process that opened the folder for writing while another account owned it
// keeps that access after the owner and DACL change, and could add, rename or
// replace entries behind any check. When another account owned the folder or
// anything directly in it, the agent therefore replaces the folder: it builds
// a new one with its own descriptor, carries over only the config files it can
// trust, and renames the old one aside to <folder>.untrusted-<time>. Handles
// into the old folder then reach the set-aside copy, never the agent's.
func reclaimConfigDir(root string, forEnroll bool) error {
	if _, err := os.Lstat(root); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	rootSec, err := readProgramDataPathSecurity(root)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	if rootSec.Reparse {
		return fmt.Errorf("%w: %s is a link or reparse point; remove it and install the agent again", ErrConfigDirUntrusted, root)
	}

	controlled, err := controlledByAnotherAccount(root, rootSec)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	if controlled != "" {
		log.Warn("The agent config folder was created or changed by another account; replacing it", "dir", root, "evidence", controlled)
		if err := replaceConfigRoot(root, forEnroll); err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		return nil
	}

	// The agent's own folder: harden it through its handle (as the
	// instance guard does on every start) and re-secure, in place, a config
	// file the agent owns whose DACL lets others write.
	if err := secureConfigRootFn(root); err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	for name, sddl := range reclaimConfigFiles {
		p := filepath.Join(root, name)
		sec, err := readProgramDataPathSecurity(p)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		if !sec.Exists || sec.Reparse || checkProgramDataObject(p, sec) == nil {
			continue
		}
		log.Warn("Re-securing an agent config file whose permissions let other accounts write it", "path", p)
		if err := applyWindowsDACL(p, sddl); err != nil {
			return fmt.Errorf("%w: re-secure %s: %v", ErrConfigDirUntrusted, p, err)
		}
	}
	return nil
}

// controlledByAnotherAccount returns why root counts as controlled by an
// account other than SYSTEM, Administrators or TrustedInstaller ("" if it
// does not): root itself, or any entry directly in it, has such an owner.
// Only an account that could write the folder can have created an entry, so
// an owner like that is evidence even after the folder's own owner and DACL
// were repaired (by the MSI, or an earlier run).
func controlledByAnotherAccount(root string, rootSec programDataPathSecurity) (string, error) {
	if !trustedProgramDataPrincipal(rootSec.OwnerSID) {
		return "folder owner " + rootSec.OwnerSID, nil
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return "", fmt.Errorf("list %s: %w", root, err)
	}
	for _, e := range entries {
		p := filepath.Join(root, e.Name())
		sec, err := readProgramDataPathSecurity(p)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return "", err
		}
		if !sec.Exists {
			continue
		}
		// The agent never puts a link in its config folder (and replaces a
		// linked logs/data dir), so any link there is treated as planted.
		if sec.NameSurrogate {
			return e.Name() + " is a link", nil
		}
		if !trustedProgramDataPrincipal(sec.OwnerSID) {
			return e.Name() + " owner " + sec.OwnerSID, nil
		}
	}
	return "", nil
}

// replaceConfigRoot builds a new folder next to root, carries over the
// config files the agent can trust, renames root aside and the new folder
// into its place. Any failure leaves root where it is and returns an error,
// so the agent does not start on it.
func replaceConfigRoot(root string, forEnroll bool) error {
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	staging := root + ".new-" + stamp
	aside := root + ".untrusted-" + stamp

	if err := createConfigRootDirFn(staging, windowsConfigDirCreateSDDL); err != nil {
		return fmt.Errorf("create %s: %w", staging, err)
	}
	cleanup := func() { _ = os.RemoveAll(staging) }

	for name, sddl := range reclaimConfigFiles {
		carried, why, err := carryConfigFile(filepath.Join(root, name), filepath.Join(staging, name), sddl)
		if err != nil {
			cleanup()
			return err
		}
		if !carried && why != "" {
			if forEnroll {
				log.Warn("Not carrying over a config file another account could have written; enrollment writes a new one", "file", name, "reason", why, "keptIn", aside)
			} else {
				log.Warn("Not adopting a config file another account could have written; the agent starts unenrolled", "file", name, "reason", why, "keptIn", aside)
			}
		}
	}

	// Fails while a process holds the old folder, or anything in it, open
	// without delete sharing: the agent then does not start, rather than
	// run in a folder that process can still change.
	if err := os.Rename(root, aside); err != nil {
		cleanup()
		return fmt.Errorf("set %s aside (another process may hold it or a file in it open): %w", root, err)
	}
	if err := os.Rename(staging, root); err != nil {
		_ = os.Rename(aside, root)
		cleanup()
		return fmt.Errorf("move the new folder into place at %s: %w", root, err)
	}
	if err := secureConfigRootFn(root); err != nil {
		return err
	}
	log.Warn("Replaced the agent config folder; the old one is kept for review", "dir", root, "keptIn", aside)
	return nil
}

// carryConfigFile copies src to dst with sddl when src is a config file the
// agent can trust: owned by SYSTEM, Administrators or TrustedInstaller, not a
// reparse point and not hard-linked elsewhere (a hard link could make the
// agent copy some other file's contents into a readable config). It reports
// whether it copied, and if not, why ("" when src does not exist).
func carryConfigFile(src, dst, sddl string) (bool, string, error) {
	sec, err := readProgramDataPathSecurity(src)
	if err != nil {
		return false, "", err
	}
	if !sec.Exists {
		return false, "", nil
	}
	if sec.Reparse {
		return false, "it is a link or reparse point", nil
	}
	if !trustedProgramDataPrincipal(sec.OwnerSID) {
		return false, "owned by " + sec.OwnerSID, nil
	}

	p16, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return false, "", err
	}
	h, err := windows.CreateFile(p16, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return false, "", fmt.Errorf("open %s: %w", src, err)
	}
	f := os.NewFile(uintptr(h), src)
	defer func() { _ = f.Close() }()
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return false, "", fmt.Errorf("inspect %s: %w", src, err)
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return false, "it is not a regular file", nil
	}
	if info.NumberOfLinks != 1 {
		return false, "it has other hard links", nil
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return false, "", fmt.Errorf("read %s: %w", src, err)
	}
	if err := atomicWriteFile(dst, data, 0o600); err != nil {
		return false, "", fmt.Errorf("write %s: %w", dst, err)
	}
	if err := applyWindowsDACL(dst, sddl); err != nil {
		return false, "", fmt.Errorf("secure %s: %w", dst, err)
	}
	return true, "", nil
}
