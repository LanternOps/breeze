package hyperv

// Platform-neutral half of the volume-root protection a restore applies to
// the new VM disk it formats (volume_protect_windows.go): the checks that
// decide whether a freshly formatted, mounted volume may receive restored
// files. Kept untagged so the rules are tested on every OS.

import (
	"errors"
	"fmt"
	"strings"
)

// protectedVolumeRootSDDL is the DACL the restore puts on the new volume's
// root for as long as it writes there: full control for SYSTEM and the local
// Administrators group, inherited by everything created beneath it, and
// protected so nothing else is inherited. A freshly formatted NTFS root lets
// every local user create entries in it; this takes that away before the
// first restored byte is written. The volume's own default DACL is put back
// (and propagated) once the restore has finished writing, so the restored
// system's permissions are what they were before this protection existed.
const protectedVolumeRootSDDL = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

// systemVolumeInformation is the one entry NTFS itself keeps at a volume
// root. It is the only entry a newly formatted root may hold.
const systemVolumeInformation = "System Volume Information"

// volumeRootTrustees are the principals an allow ACE on the protected root,
// or the owner of an entry already at the root, may name: SYSTEM and the
// local Administrators group, as SDDL aliases or SIDs.
var volumeRootTrustees = map[string]bool{
	"SY": true, "S-1-5-18": true,
	"BA": true, "S-1-5-32-544": true,
}

// checkDriveLetter accepts exactly one ASCII letter.
func checkDriveLetter(letter string) error {
	if len(letter) != 1 {
		return fmt.Errorf("invalid drive letter %q", letter)
	}
	if c := letter[0] | 0x20; c < 'a' || c > 'z' {
		return fmt.Errorf("invalid drive letter %q", letter)
	}
	return nil
}

// checkProtectedRootDACL checks the SDDL of a volume root's DACL (as read
// back after protecting it): the DACL must be present and protected, and
// every allow ACE must name SYSTEM or Administrators. Deny ACEs only remove
// access and are accepted. Anything the parser does not recognise — an
// object, callback or conditional ACE, a resource attribute — is refused.
func checkProtectedRootDACL(sddl string) error {
	i := strings.Index(sddl, "D:")
	if i < 0 {
		return errors.New("the volume root has no DACL")
	}
	d := sddl[i+2:]
	flags, aces := d, ""
	if j := strings.IndexByte(d, '('); j >= 0 {
		flags, aces = d[:j], d[j:]
	}
	if strings.Contains(flags, "NO_ACCESS_CONTROL") {
		return errors.New("the volume root has a NULL DACL")
	}
	if !strings.Contains(flags, "P") {
		return errors.New("the volume root's DACL is not protected against inheritance")
	}
	for aces != "" {
		if aces[0] != '(' {
			return fmt.Errorf("the volume root's DACL has unexpected content %q", aces)
		}
		end := strings.IndexByte(aces, ')')
		if end < 0 {
			return fmt.Errorf("the volume root's DACL has an unterminated entry %q", aces)
		}
		ace := aces[1:end]
		aces = aces[end+1:]
		fields := strings.Split(ace, ";")
		if len(fields) != 6 {
			return fmt.Errorf("the volume root's DACL has an entry this check does not accept: (%s)", ace)
		}
		switch fields[0] {
		case "D":
			continue
		case "A":
			if !volumeRootTrustees[strings.ToUpper(fields[5])] {
				return fmt.Errorf("the volume root grants access to %s", fields[5])
			}
		default:
			return fmt.Errorf("the volume root's DACL has an entry this check does not accept: (%s)", ace)
		}
	}
	return nil
}

// volumeRootEntry describes one entry found at the root of the new volume.
type volumeRootEntry struct {
	Name     string
	Dir      bool
	Reparse  bool
	OwnerSID string // "" when the owner could not be read
}

// checkVolumeRootEntries refuses a new volume whose root holds anything the
// restore did not create — something another local identity placed there
// before the root was protected. Only System Volume Information is allowed,
// and only as a real directory owned by SYSTEM or Administrators.
func checkVolumeRootEntries(entries []volumeRootEntry) error {
	for _, e := range entries {
		if strings.EqualFold(e.Name, systemVolumeInformation) && e.Dir && !e.Reparse && volumeRootTrustees[strings.ToUpper(e.OwnerSID)] {
			continue
		}
		return fmt.Errorf("the new volume's root already holds %q, which the restore did not create", e.Name)
	}
	return nil
}
