package systemrestore

import (
	"errors"
	"fmt"
	"syscall"
)

// ErrUnsupported means this machine has no usable System Restore provider:
// no srclient.dll, no SRSetRestorePointW entry point, no SystemRestore WMI
// class, or a non-Windows platform. Determined by probing, NEVER by SKU —
// Windows Server 2022, for example, ships neither the DLL nor the WMI class
// (#4752 hardware run), and a SKU table would drift (#4609 Open Decision 4).
var ErrUnsupported = errors.New("system restore is not available on this machine")

// errorServiceDisabled is ERROR_SERVICE_DISABLED (1058). srclient reports it
// in nStatus when System Restore protection is off for the system drive — a
// state the registry does not reliably show, so the DLL's answer is the probe.
const errorServiceDisabled = 1058

// nativeError is a failed SRSetRestorePointW call. It keeps nStatus so the
// classifier can tell "System Restore is turned off" from a real failure.
type nativeError struct {
	msg     string
	nStatus uint32
	cause   error // the Win32 errno from the call, when one was set
}

func (e *nativeError) Error() string {
	if e.cause != nil {
		return e.msg + ": " + e.cause.Error()
	}
	return e.msg
}

func (e *nativeError) Unwrap() error { return e.cause }

// interpretCall turns one SRSetRestorePointW call's raw outputs into a
// sequence number or a *nativeError. Proc.Call always returns a non-nil
// error, usually Errno(0); only a nonzero errno is attached as the cause.
func interpretCall(ret uintptr, callErr error, status statemgrStatus) (int64, error) {
	if msg, failed := restorePointCallFailed(ret, status.Status); failed {
		nerr := &nativeError{msg: msg, nStatus: status.Status}
		var errno syscall.Errno
		if errors.As(callErr, &errno) && errno != 0 {
			nerr.cause = errno
		}
		return 0, nerr
	}
	return status.sequence(), nil
}

// isMissingLibraryErrno reports whether a DLL-load errno means the module or
// entry point does not exist (ERROR_MOD_NOT_FOUND, ERROR_PROC_NOT_FOUND) —
// the only load failures that mean "System Restore is unsupported here".
func isMissingLibraryErrno(errno uintptr) bool {
	return errno == 126 || errno == 127
}

// restorePointCallFailed classifies one SRSetRestorePointW call from both of
// its outputs: the BOOL return and STATEMGRSTATUS.nStatus. The call can
// return TRUE with a nonzero nStatus, which the code before #4752 (checking
// only the return value) counted as a success. The message distinguishes
// the two failure shapes.
func restorePointCallFailed(ret uintptr, nStatus uint32) (string, bool) {
	switch {
	case uint32(ret) == 0: // ret is a Win32 BOOL; only the low 32 bits are defined
		return fmt.Sprintf("SRSetRestorePointW returned FALSE (nStatus=%d)", nStatus), true
	case nStatus != 0:
		return fmt.Sprintf("SRSetRestorePointW reported nStatus=%d", nStatus), true
	default:
		return "", false
	}
}
