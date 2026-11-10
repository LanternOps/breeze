package sessionbroker

import (
	"errors"
	"fmt"
	"syscall"
)

// No build tag: the only caller is the Windows detector, but formatting the
// error is pure Go and tested on every OS.

// wtsQueryError formats a failed WTSQuerySessionInformationW, keeping the
// Win32 code unwrappable to syscall.Errno when one was recorded.
func wtsQueryError(infoClass uint32, errno error) error {
	var e syscall.Errno
	if errors.As(errno, &e) && e != 0 {
		return fmt.Errorf("WTSQuerySessionInformationW(class %d) failed: Win32 error %d: %w", infoClass, uint32(e), e)
	}
	return fmt.Errorf("WTSQuerySessionInformationW(class %d) failed (Win32 recorded no error code)", infoClass)
}
