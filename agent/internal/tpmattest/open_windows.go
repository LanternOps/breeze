//go:build windows

package tpmattest

import (
	"errors"
	"fmt"

	"github.com/google/go-tpm/tpm2/transport"
	"github.com/google/go-tpm/tpm2/transport/windowstpm"
)

// openPlatformTPM opens the TPM through TBS. A TPM 1.2, or no TPM at all,
// is ErrNoTPM. go-tpm's Open returns a transport even when TBS refused the
// context, so its error is checked before the transport is used.
func openPlatformTPM() (t transport.TPMCloser, err error) {
	defer func() {
		// tbs answers with panics on some unusual hosts; never let one escape.
		if r := recover(); r != nil {
			t, err = nil, fmt.Errorf("%w: %v", ErrNoTPM, r)
		}
	}()
	t, err = windowstpm.Open()
	if err != nil {
		if t != nil {
			_ = t.Close()
		}
		if errors.Is(err, windowstpm.ErrNotTPM20) || isTBSUnavailable(err) {
			return nil, fmt.Errorf("%w: %v", ErrNoTPM, err)
		}
		return nil, err
	}
	return t, nil
}
