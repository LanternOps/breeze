//go:build !darwin && !linux && !windows

package flashguard

import (
	"errors"
	"os"
)

// No flash runs on these platforms. Enter refuses on this error and admission
// proceeds, so nothing changes for a power action.
func tryLock(*os.File, lockMode) error {
	return errors.New("flashguard: file locking is not implemented on this platform")
}
