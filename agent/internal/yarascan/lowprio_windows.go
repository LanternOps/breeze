//go:build windows

package yarascan

import "golang.org/x/sys/windows"

// THREAD_MODE_BACKGROUND_BEGIN lowers the calling thread's scheduling, I/O
// and memory priority (it is only valid for the current thread).
const threadModeBackgroundBegin = 0x00010000

var procSetThreadPriority = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetThreadPriority")

// EnterBackgroundThread lowers CPU and I/O priority of the CURRENT OS thread.
// The caller must have called runtime.LockOSThread and must never unlock it,
// so the runtime retires the thread with the goroutine (DECISION W02-c:
// per-thread, so heartbeats and remote sessions keep normal priority).
func EnterBackgroundThread() {
	if err := procSetThreadPriority.Find(); err != nil {
		log.Warn("could not enter background thread mode", "error", err.Error())
		return
	}
	r, _, err := procSetThreadPriority.Call(uintptr(windows.CurrentThread()), threadModeBackgroundBegin)
	if r == 0 {
		log.Warn("could not enter background thread mode", "error", err.Error())
	}
}
