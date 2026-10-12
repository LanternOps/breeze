//go:build windows

package systemrestore

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// srSetRestorePoint is srclient.dll!SRSetRestorePointW. NewLazySystemDLL loads
// only from System32, never from the agent's directory or the search path.
var srSetRestorePoint = windows.NewLazySystemDLL("srclient.dll").NewProc("SRSetRestorePointW")

func nativeRestorePointAPI() nativeAPI {
	return nativeAPI{
		begin: func(description string) (int64, error) {
			rpi, err := restorePointInfoFor(beginSystemChange, 0, description)
			if err != nil {
				return 0, err
			}
			return callOnCOMThread(&rpi)
		},
		end: func(sequence int64) error {
			rpi, err := restorePointInfoFor(endSystemChange, sequence, "")
			if err != nil {
				return err
			}
			_, err = callOnCOMThread(&rpi)
			return err
		},
	}
}

// callOnCOMThread makes one SRSetRestorePointW call on a fresh goroutine that
// is locked to its OS thread with COM initialised (multithreaded), and waits
// for it. A fresh thread keeps the call independent of whatever apartment the
// caller's thread is in — the patching caller, for one, runs inside its own
// Windows Update COM session.
//
// CoInitializeSecurity is deliberately NOT called: it is process-wide, and the
// backup/VSS subsystem has its own requirements of it.
//
// The goroutine never unlocks its thread, so when it exits the Go runtime
// destroys the thread rather than handing one that touched COM to unrelated
// code (the same rule as backup/vss/session_lifetime.go).
//
// This wait is NOT cancellable. Proc.Call is a synchronous foreign call; see
// Create's timeout caveat.
func callOnCOMThread(rpi *restorePointInfo) (int64, error) {
	type result struct {
		seq int64
		err error
	}
	done := make(chan result, 1)
	go func() {
		runtime.LockOSThread()
		seq, err := callSRSetRestorePoint(rpi)
		done <- result{seq, err}
	}()
	r := <-done
	return r.seq, r.err
}

func callSRSetRestorePoint(rpi *restorePointInfo) (int64, error) {
	var hr uintptr
	if err := windows.CoInitializeEx(0, windows.COINIT_MULTITHREADED); err != nil {
		var errno syscall.Errno
		if !errors.As(err, &errno) {
			return 0, fmt.Errorf("CoInitializeEx failed: %w", err)
		}
		hr = uintptr(errno)
	}
	proceed, uninit := comInitDisposition(hr)
	if !proceed {
		return 0, fmt.Errorf("CoInitializeEx failed: HRESULT %#x", uint32(hr))
	}
	if uninit {
		defer windows.CoUninitialize()
	}

	if err := findEntryPoint(); err != nil {
		return 0, err
	}

	status := newStatemgrStatus()
	ret, _, callErr := srSetRestorePoint.Call(
		uintptr(unsafe.Pointer(rpi)),
		uintptr(unsafe.Pointer(&status)),
	)
	// Both signals: the call can return TRUE with a nonzero nStatus.
	return interpretCall(ret, callErr, status)
}
