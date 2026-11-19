//go:build !linux && !windows

package tpmattest

import "github.com/google/go-tpm/tpm2/transport"

// macOS has no TPM: Macs get the manual reattach path with hints only (§7.2).
func openPlatformTPM() (transport.TPMCloser, error) {
	return nil, ErrNoTPM
}
