//go:build windows

package tpmattest

import (
	"errors"
	"syscall"

	"github.com/google/go-tpm/tpmutil/tbs"
)

// isTBSUnavailable: TBS says there is no TPM to talk to, or it is off, or
// tbs.dll itself cannot be loaded. The agent then has no TPM to use.
func isTBSUnavailable(err error) bool {
	var code tbs.Error
	if errors.As(err, &code) {
		switch code {
		case tbs.ErrTPMNotFound, tbs.ErrServiceDisabled, tbs.ErrServiceNotRunning:
			return true
		}
		return false
	}
	// go-tpm loads tbs.dll with syscall.NewLazyDLL: a missing DLL is a *syscall.DLLError.
	var dllErr *syscall.DLLError
	return errors.As(err, &dllErr)
}
