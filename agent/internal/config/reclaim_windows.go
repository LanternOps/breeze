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
// configuration and identity, with the descriptor a fresh copy gets.
var reclaimConfigFiles = map[string]string{
	"agent.yaml":   reclaimOwnerSDDL + windowsConfigFileSDDL,
	"secrets.yaml": reclaimOwnerSDDL + windowsSecretFileSDDL,
}

// reclaimOwnDirs have their own checks, which repair rather than replace
// them: run (the instance guard, at start) and logs/data
// (EnforceProgramDataTreePermissions). They are only set aside here when
// another account owns them, i.e. created them.
var reclaimOwnDirs = map[string]bool{"run": true, "logs": true, "data": true}

// secureConfigRootFn is secureMainAgentConfigDir; a seam for tests.
var secureConfigRootFn = secureMainAgentConfigDir

// The data dir is inside the config dir on Windows.
func reclaimSeparateDataDir() error { return nil }

func reclaimConfigDir(root string, forEnroll bool) error {
	if _, err := os.Lstat(root); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}

	// Take the folder by handle first: refused if it is a link, otherwise
	// owner and PROTECTED DACL set and verified through the handle. From then
	// on no other account can add, rename or replace its entries, so the
	// checks and renames below cannot be redirected.
	drifted, _ := ownerUntrusted(root)
	if err := secureConfigRootFn(root); err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	if drifted {
		log.Warn("The agent config folder was created by another account; took it back", "dir", root)
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("%w: list %s: %v", ErrConfigDirUntrusted, root, err)
	}
	q := quarantine{root: root}
	type configFile struct{ path, name, sddl string }
	var configFiles []configFile
	for _, e := range entries {
		name := strings.ToLower(e.Name())
		if name == reclaimQuarantineDir {
			continue
		}
		p := filepath.Join(root, e.Name())
		sec, err := readProgramDataPathSecurity(p)
		if err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		if !sec.Exists {
			continue
		}
		if sec.NameSurrogate {
			// A link: removed (the link only, never its target).
			if err := removeProgramDataLinkFn(p); err != nil {
				return fmt.Errorf("%w: remove the link %s: %v", ErrConfigDirUntrusted, p, err)
			}
			log.Warn("Removed a link from the agent config folder; its target was left untouched", "path", p)
			continue
		}
		if checkProgramDataObject(p, sec) == nil {
			continue
		}
		ownerTrusted := trustedProgramDataPrincipal(sec.OwnerSID)
		if sddl, ok := reclaimConfigFiles[name]; ok && !e.IsDir() {
			if forEnroll && !ownerTrusted {
				// Not adopted: enrollment writes a new one, and the
				// contents (a server, pinned keys, tool dirs) must not
				// carry into the new identity.
				if err := q.move(p, e.Name()); err != nil {
					return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
				}
				log.Warn("Set aside a config file another account wrote; enrollment writes a new one", "path", p, "owner", sec.OwnerSID)
				continue
			}
			configFiles = append(configFiles, configFile{p, e.Name(), sddl})
			continue
		}
		if reclaimOwnDirs[name] && ownerTrusted {
			continue
		}
		// Anything else another account controls is set aside, not walked:
		// its owner can still change what is inside, so nothing below it is
		// trusted or touched.
		if err := q.move(p, e.Name()); err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		log.Warn("Set aside an entry another account controlled in the agent config folder", "path", p, "owner", sec.OwnerSID)
	}

	// Config files another account could write are replaced by a fresh copy
	// the agent writes itself: a new file, so a handle that account already
	// holds no longer reaches it, with the agent's owner and DACL.
	for _, f := range configFiles {
		if err := rewriteConfigFileFresh(&q, f.path, f.name, f.sddl); err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		log.Warn("Replaced a config file another account could write with a fresh copy; check its contents", "path", f.path)
	}
	return nil
}

// rewriteConfigFileFresh sets the original aside into quarantine (a handle
// another process holds then reaches that copy, not the config) and writes
// the same contents to a new file at path.
func rewriteConfigFileFresh(q *quarantine, path, name, sddl string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	// Fails, and the agent does not start, while another process holds
	// the file open without delete sharing: re-securing it in place instead
	// would leave that handle able to write the agent's config.
	if err := q.move(path, name); err != nil {
		return fmt.Errorf("%w (another process may hold it open)", err)
	}
	if err := atomicWriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("write a fresh %s: %w", path, err)
	}
	if err := applyWindowsDACL(path, sddl); err != nil {
		return fmt.Errorf("secure %s: %w", path, err)
	}
	return nil
}
