//go:build !windows

package backup

import (
	"errors"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// fileSecurity/applySecurity are no-ops off Windows: NTFS security
// descriptors don't exist there. A manifest carrying SecurityDescriptors
// restored on Linux/macOS therefore always leaves SDIndex unconsumed — see
// Task 5's R37. The privilege helpers return a no-op release so callers can
// unconditionally `defer release()`.
func fileSecurity(_ string) ([]byte, error)       { return nil, nil }
func applySecurity(_ string, _ []byte) error      { return nil }
func enableCaptureSDPrivileges() (release func()) { return func() {} }
func enableRestoreSDPrivileges() (release func()) { return func() {} }

// securityApplier has nothing to apply off Windows.
func securityApplier(_ []byte) (*securefs.SecurityApplier, error) { return nil, nil }

// The descriptor decision's platform hooks have nothing to read or build off
// Windows (restoreAppliesSecurityDescriptors is false there, so the restore
// never reaches them).
func descriptorPrincipals(_ []byte) (sdPrincipals, error) {
	return sdPrincipals{}, errors.New("security descriptors are not read on this platform")
}
func localKnownDomains() (knownDomains, []string)                            { return knownDomains{}, nil }
func securityApplierWithoutSACL(_ []byte) (*securefs.SecurityApplier, error) { return nil, nil }
func quarantineApplier() (*securefs.SecurityApplier, error)                  { return nil, nil }
