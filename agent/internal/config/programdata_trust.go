package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Read-only verification of an agent ProgramData path.
//
// The service repairs the ProgramData tree at startup
// (EnforceProgramDataTreePermissions), but other agent processes — the
// desktop-session helpers in particular — never run that pass and may not
// have the rights to repair anything. A process that is about to load code
// from, or write sensitive state into, ProgramData must therefore check the
// path itself: VerifyProgramDataPath walks from the ProgramData root down to
// the path and requires every component to be a real file or directory (not
// a junction, symbolic link or other reparse point), owned by SYSTEM,
// Administrators or TrustedInstaller, with no DACL entry that lets any other
// principal write, delete or change permissions on it. It never changes
// anything.
//
// The ACL evaluation is platform-neutral so it can be exercised with fakes;
// only reading a path's security (readProgramDataPathSecurity) is Windows
// specific.

const (
	sidLocalSystem      = "S-1-5-18"
	sidAdministrators   = "S-1-5-32-544"
	sidTrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"

	aceTypeAccessAllowed              = 0x00
	aceTypeAccessDenied               = 0x01
	aceTypeAccessDeniedObject         = 0x06
	aceTypeAccessDeniedCallback       = 0x0A
	aceTypeAccessDeniedCallbackObject = 0x0C
	aceFlagInheritOnly                = 0x08

	// programDataWriteMask is every right that lets a principal change a file
	// or directory, its contents, or its security: write/append data (add
	// file/subdirectory), write extended attributes, delete child, write
	// attributes, DELETE, WRITE_DAC, WRITE_OWNER, MAXIMUM_ALLOWED,
	// GENERIC_ALL and GENERIC_WRITE.
	programDataWriteMask uint32 = 0x00000002 | 0x00000004 | 0x00000010 | 0x00000040 |
		0x00000100 | 0x00010000 | 0x00040000 | 0x00080000 | 0x02000000 |
		0x10000000 | 0x40000000
)

// programDataACE is one DACL entry. SID is empty for entry types whose
// layout does not carry the SID at the standard offset.
type programDataACE struct {
	Type  uint8
	Flags uint8
	Mask  uint32
	SID   string
}

// programDataPathSecurity is the state of one path, read without following a
// link at that path.
type programDataPathSecurity struct {
	Exists bool
	// Reparse is set for any reparse point; NameSurrogate additionally for
	// the kinds that redirect to another location (junctions, symbolic
	// links). Owner/DACL are not read for a name surrogate: the link
	// object's own security says nothing about where it points.
	Reparse       bool
	NameSurrogate bool
	OwnerSID      string
	DACLPresent   bool
	// Unreadable: the entry exists but this process may not read its owner
	// and DACL (its DACL denies it). The agent's own entries never deny
	// SYSTEM or Administrators, so such an entry is another account's.
	Unreadable bool
	ACEs       []programDataACE
}

var readProgramDataPathSecurityFn = readProgramDataPathSecurity

// workspaceOwnerSIDFn returns the SID of the user this process runs as; a
// seam so tests can name it.
var workspaceOwnerSIDFn = workspaceOwnerSID

// VerifyProgramDataPath reports, read-only, whether path and every directory
// between the agent's ProgramData root and it are real objects owned by
// SYSTEM, Administrators or TrustedInstaller that no other principal can
// write. A missing component returns an error matching os.ErrNotExist.
//
// In a support session the root is the session's private folder (ConfigDir
// returns it), and the user the session runs as is also an accepted owner and
// writer: the folder is private to that user, SYSTEM and Administrators, and
// that user is the one loading the file. No other principal is accepted, so
// a component another user owns or can write is still refused (#7629).
func VerifyProgramDataPath(path string) error {
	if registeredUserWorkspace() != "" {
		return verifyProgramDataChainTrusting(ConfigDir(), path, workspaceOwnerSIDFn())
	}
	return verifyProgramDataChain(ConfigDir(), path)
}

func verifyProgramDataChain(root, path string) error {
	return verifyProgramDataChainTrusting(root, path, "")
}

// verifyProgramDataChainTrusting is verifyProgramDataChain with one extra
// principal (a SID string, or "" for none) accepted as owner and writer.
func verifyProgramDataChainTrusting(root, path, extraTrusted string) error {
	components, err := programDataChain(root, path)
	if err != nil {
		return err
	}
	for _, p := range components {
		sec, err := readProgramDataPathSecurityFn(p)
		if err != nil {
			return fmt.Errorf("read security of %s: %w", p, err)
		}
		if !sec.Exists {
			return fmt.Errorf("%s does not exist: %w", p, os.ErrNotExist)
		}
		if err := checkProgramDataObjectTrusting(p, sec, extraTrusted); err != nil {
			return err
		}
	}
	return nil
}

// programDataChain returns root and every path from root down to path.
func programDataChain(root, path string) ([]string, error) {
	cleanRoot := filepath.Clean(root)
	cleanPath := filepath.Clean(path)
	if strings.EqualFold(cleanPath, cleanRoot) {
		return []string{cleanRoot}, nil
	}
	prefix := cleanRoot + string(filepath.Separator)
	if len(cleanPath) <= len(prefix) || !strings.EqualFold(cleanPath[:len(prefix)], prefix) {
		return nil, fmt.Errorf("%s is not under the agent ProgramData directory %s", path, root)
	}
	chain := []string{cleanRoot}
	cur := cleanRoot
	for _, part := range strings.Split(cleanPath[len(prefix):], string(filepath.Separator)) {
		if part == "" || part == "." || part == ".." {
			return nil, fmt.Errorf("%s is not under the agent ProgramData directory %s", path, root)
		}
		cur = filepath.Join(cur, part)
		chain = append(chain, cur)
	}
	return chain, nil
}

func trustedProgramDataPrincipal(sid string) bool {
	return sid == sidLocalSystem || sid == sidAdministrators || sid == sidTrustedInstaller
}

func isDenyACE(t uint8) bool {
	switch t {
	case aceTypeAccessDenied, aceTypeAccessDeniedObject, aceTypeAccessDeniedCallback, aceTypeAccessDeniedCallbackObject:
		return true
	}
	return false
}

// checkProgramDataObject applies the trust rules to one already-read path.
func checkProgramDataObject(p string, sec programDataPathSecurity) error {
	return checkProgramDataObjectTrusting(p, sec, "")
}

func checkProgramDataObjectTrusting(p string, sec programDataPathSecurity, extraTrusted string) error {
	trusted := func(sid string) bool {
		return trustedProgramDataPrincipal(sid) || (extraTrusted != "" && sid == extraTrusted)
	}
	if sec.NameSurrogate {
		return fmt.Errorf("%s is a link to another location", p)
	}
	if sec.Reparse {
		return fmt.Errorf("%s is a reparse point", p)
	}
	if !trusted(sec.OwnerSID) {
		if extraTrusted != "" {
			return fmt.Errorf("%s owner %s is not this user, SYSTEM, Administrators or TrustedInstaller", p, sec.OwnerSID)
		}
		return fmt.Errorf("%s owner %s is not SYSTEM, Administrators or TrustedInstaller", p, sec.OwnerSID)
	}
	if !sec.DACLPresent {
		return fmt.Errorf("%s has no DACL, which grants everyone full access", p)
	}
	for _, ace := range sec.ACEs {
		if ace.Flags&aceFlagInheritOnly != 0 || isDenyACE(ace.Type) {
			continue
		}
		if ace.Type != aceTypeAccessAllowed {
			return fmt.Errorf("%s has an allow entry of unrecognised entry type 0x%02x", p, ace.Type)
		}
		if trusted(ace.SID) {
			continue
		}
		if ace.Mask&programDataWriteMask != 0 {
			return fmt.Errorf("%s grants write access (0x%08x) to %s", p, ace.Mask&programDataWriteMask, ace.SID)
		}
	}
	return nil
}
