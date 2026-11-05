package helper

import (
	"errors"
	"fmt"
	"io"
)

// maxUntrustedFileBytes caps a read of a helper_config.yaml or
// helper_status.yaml. On unix the session directory is owned by the logged-in
// user while the Agent runs as root, so these files are untrusted. Worst case
// with branding is ~3 KiB of text (limits in branding.go, 4 bytes per code
// point) plus a few small keys; 64 KiB leaves wide headroom.
const maxUntrustedFileBytes = 64 * 1024

// errNotRegularFile is returned for a path that names anything but a regular
// file, such as a FIFO or a directory.
var errNotRegularFile = errors.New("not a regular file")

// readUntrustedFile reads a file a session user can replace. The Manager calls
// it with its mutex held and enrollment clears branding through it, so it must
// not block on what the user puts there: the open does not wait on a FIFO, a
// final symlink is refused, the type is checked on the opened descriptor (a
// check before the open could be raced), and the read is capped. Errors never
// include file content.
func readUntrustedFile(path string) ([]byte, error) {
	f, err := openUntrustedFile(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, errNotRegularFile
	}
	data, err := io.ReadAll(io.LimitReader(f, maxUntrustedFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxUntrustedFileBytes {
		return nil, fmt.Errorf("larger than %d bytes", maxUntrustedFileBytes)
	}
	return data, nil
}
