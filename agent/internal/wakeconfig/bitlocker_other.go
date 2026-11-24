//go:build !windows

package wakeconfig

import (
	"context"
	"errors"
)

var errBitLockerWindowsOnly = errors.New("bitlocker is only read on windows")

// SystemBitLockerReaders off Windows read nothing and fail, so the guard
// blocks. No firmware adapter writes off Windows in any case.
func SystemBitLockerReaders() BitLockerReaders {
	return BitLockerReaders{
		State:      func() (string, error) { return "", errBitLockerWindowsOnly },
		Protectors: func(context.Context) (string, error) { return "", errBitLockerWindowsOnly },
	}
}
