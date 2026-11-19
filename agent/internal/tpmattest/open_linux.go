//go:build linux

package tpmattest

import (
	"errors"
	"io/fs"
	"os"

	"github.com/google/go-tpm/tpm2/transport"
	"github.com/google/go-tpm/tpm2/transport/linuxtpm"
)

// linuxTPMPath is the kernel's TPM 2.0 resource manager: it flushes what a
// client leaves behind and shares the TPM with other users (tpm2-abrmd, the
// tpm2-tools). /dev/tpm0 is never used: it is exclusive.
const linuxTPMPath = "/dev/tpmrm0"

func openPlatformTPM() (transport.TPMCloser, error) {
	if _, err := os.Stat(linuxTPMPath); errors.Is(err, fs.ErrNotExist) {
		return nil, ErrNoTPM
	}
	return linuxtpm.Open(linuxTPMPath)
}
