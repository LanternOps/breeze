//go:build !unix && !windows

package patching

import "errors"

// trustPendingRecordFile has no way to vouch for the record here, so a
// pending restart is never restored on this platform.
func trustPendingRecordFile(string) error {
	return errors.New("pending restart records are not trusted on this platform")
}
