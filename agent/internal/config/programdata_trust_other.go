//go:build !windows

package config

import "errors"

// ProgramData links, ownership and DACLs are a Windows-only concern (see
// permissions_drift.go and programdata_trust.go). On other platforms a
// managed directory is never treated as a link to replace — an administrator
// may legitimately symlink /var/lib/breeze elsewhere — and there is no
// Windows security descriptor to verify.

var errProgramDataVerifyUnsupported = errors.New("ProgramData owner/DACL verification is only available on Windows")

func programDataPathIsLink(string) (bool, error) { return false, nil }

func removeProgramDataLink(string) error { return errProgramDataVerifyUnsupported }

func resetProgramDataTreeContents(string, bool) ([]string, error) { return nil, nil }

func readProgramDataPathSecurity(string) (programDataPathSecurity, error) {
	return programDataPathSecurity{}, errProgramDataVerifyUnsupported
}
