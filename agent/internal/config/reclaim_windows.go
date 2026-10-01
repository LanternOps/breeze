//go:build windows

package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// reclaimOwnerSDDL makes applyWindowsDACL also set the owner to SYSTEM (with
// its SeRestorePrivilege retry and Administrators fallback).
const reclaimOwnerSDDL = `O:SYG:SY`

// reclaimConfigFiles are the files whose contents the agent loads as its
// configuration and identity, with the descriptor each is re-secured to.
var reclaimConfigFiles = []struct{ name, sddl string }{
	{"agent.yaml", reclaimOwnerSDDL + windowsConfigFileSDDL},
	{"secrets.yaml", reclaimOwnerSDDL + windowsSecretFileSDDL},
}

// The data dir is inside the config dir on Windows (and is also checked by
// EnforceProgramDataTreePermissions at start).
func reclaimSeparateDataDir() error { return nil }

func reclaimConfigDir(root string, forEnroll bool) error {
	if _, err := os.Lstat(root); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	isLink, err := programDataPathIsLinkFn(root)
	if err != nil {
		return fmt.Errorf("%w: check whether %s is a link: %v", ErrConfigDirUntrusted, root, err)
	}
	if isLink {
		return fmt.Errorf("%w: %s is a link to another location; remove it and install the agent again", ErrConfigDirUntrusted, root)
	}

	// The folder itself: another account that owns it could change its
	// permissions at will. Take it back first, so nothing below can be
	// changed while the sweep runs.
	drifted, err := ownerUntrusted(root)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	if drifted {
		log.Warn("The agent config folder was created or changed by another account; taking it back", "dir", root)
		if err := applyWindowsDACL(root, windowsConfigDirSDDL); err != nil {
			return fmt.Errorf("%w: take back %s: %v", ErrConfigDirUntrusted, root, err)
		}
	}

	// The config files: their contents are what the agent acts on.
	skip := map[string]bool{}
	for _, f := range reclaimConfigFiles {
		skip[strings.ToLower(f.name)] = true
		p := filepath.Join(root, f.name)
		sec, err := readProgramDataPathSecurity(p)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		if !sec.Exists {
			continue
		}
		if sec.NameSurrogate || sec.Reparse {
			if err := removeProgramDataLinkFn(p); err != nil {
				return fmt.Errorf("%w: %s is a link and could not be removed: %v", ErrConfigDirUntrusted, p, err)
			}
			log.Warn("Removed a link planted in place of an agent config file; its target was left untouched", "path", p)
			continue
		}
		if checkProgramDataObject(p, sec) == nil {
			continue
		}
		if forEnroll {
			if err := os.Remove(p); err != nil {
				return fmt.Errorf("%w: remove %s, which another account could write: %v", ErrConfigDirUntrusted, p, err)
			}
			log.Warn("Removed a config file another account could have written; enrollment writes a new one", "path", p, "owner", sec.OwnerSID)
			continue
		}
		log.Warn("Re-securing a config file another account could have written; check its contents", "path", p, "owner", sec.OwnerSID)
		if err := applyWindowsDACL(p, f.sddl); err != nil {
			return fmt.Errorf("%w: re-secure %s: %v", ErrConfigDirUntrusted, p, err)
		}
	}

	// Everything else: links removed, entries another account controlled
	// reset to SYSTEM with the folder's inherited permissions, and their
	// contents too. After a take-back every subtree is swept.
	stuck, err := resetProgramDataTreeContentsSkipping(root, drifted, skip)
	if len(stuck) > 0 {
		return fmt.Errorf("%w: links inside %s could not be removed: %s", ErrConfigDirUntrusted, root, strings.Join(stuck, ", "))
	}
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	return nil
}
