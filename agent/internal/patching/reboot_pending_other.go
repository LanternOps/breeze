//go:build !unix && !windows

package patching

import "errors"

// readTrustedRecordFile has no way to vouch for the record here, so a
// pending restart is never restored on this platform.
func readTrustedRecordFile(string) ([]byte, error) {
	return nil, &untrustedRecordError{errors.New("pending restart records are not trusted on this platform")}
}
