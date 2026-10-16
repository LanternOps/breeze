//go:build windows

package tools

import (
	"log/slog"
	"runtime"

	"golang.org/x/sys/windows"
)

// SetThreadPriority mode values (processthreadsapi.h). Background mode lowers
// the calling thread's I/O and memory priority as well as its CPU priority —
// I/O priority is the part that matters for a disk walker (#8509).
const (
	threadModeBackgroundBegin = 0x00010000
	threadModeBackgroundEnd   = 0x00020000
)

var procSetThreadPriority = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadPriority")

func setCurrentThreadPriority(mode uintptr) error {
	ret, _, err := procSetThreadPriority.Call(uintptr(windows.CurrentThread()), mode)
	if ret == 0 {
		return err
	}
	return nil
}

// beginBackgroundIO puts the calling goroutine's OS thread into background
// processing mode so a filesystem walk yields disk I/O to everything else on
// the machine — notably VSS writers on a server mid-backup (#8509). The
// goroutine is locked to its thread for the duration; the returned func must
// be called from the same goroutine.
//
// If leaving background mode fails, the goroutine stays locked so its exit
// terminates the thread rather than returning a low-priority thread to the Go
// scheduler's pool. If entering it fails, the walk proceeds at normal priority
// (best-effort: a slower-to-yield scan is still a correct scan).
func beginBackgroundIO() func() {
	runtime.LockOSThread()
	if err := setCurrentThreadPriority(threadModeBackgroundBegin); err != nil {
		runtime.UnlockOSThread()
		slog.Warn("filesystem analysis: could not enter background I/O mode; walking at normal priority", "error", err.Error())
		return func() {}
	}
	return func() {
		if err := setCurrentThreadPriority(threadModeBackgroundEnd); err != nil {
			// Stay locked: the goroutine's exit then terminates this thread.
			slog.Warn("filesystem analysis: could not leave background I/O mode; retiring the worker thread", "error", err.Error())
			return
		}
		runtime.UnlockOSThread()
	}
}
