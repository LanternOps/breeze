//go:build windows

package patching

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/config"
)

// maxRecordBytes bounds the read: a real record is well under a kilobyte.
const maxRecordBytes = 64 << 10

// readTrustedRecordFile reads a pending-restart record only from a data
// directory whose protected ACL (SYSTEM and Administrators only) was verified
// or repaired at this agent start (config.EnforceProgramDataTreePermissions).
// A standard user can neither write nor delete a file there, so cannot
// schedule or cancel a restart through it. A link or reparse point is
// refused, and the file read must be the very file checked (os.SameFile on
// the path and on the open handle), so nothing can be swapped in between. A
// refusal is an *untrustedRecordError.
func readTrustedRecordFile(path string) ([]byte, error) {
	if dir := filepath.Dir(path); !config.ProgramDataDirTrusted(dir) {
		return nil, &untrustedRecordError{fmt.Errorf("data directory %s has not been verified as SYSTEM/Administrators-only", dir)}
	}
	linfo, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !linfo.Mode().IsRegular() {
		return nil, &untrustedRecordError{fmt.Errorf("not a regular file (mode %s)", linfo.Mode())}
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	finfo, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !finfo.Mode().IsRegular() || !os.SameFile(linfo, finfo) {
		return nil, &untrustedRecordError{errors.New("the record changed while it was being opened")}
	}
	data, err := io.ReadAll(io.LimitReader(f, maxRecordBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxRecordBytes {
		return nil, &untrustedRecordError{errors.New("the record is implausibly large")}
	}
	return data, nil
}
