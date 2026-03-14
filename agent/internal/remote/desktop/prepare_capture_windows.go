//go:build windows

package desktop

import "runtime"

// prepareCaptureThread pins the capture goroutine to a single OS thread and
// attaches it to the currently active input desktop. Required for helper
// processes spawned into user sessions (e.g., SYSTEM in Session 1) where the
// thread is not automatically on the correct desktop.
//
// For DXGI: the capture loop's existing ACCESS_LOST recovery would eventually
// call switchToInputDesktop, but this avoids the initial failure + 100ms delay.
// For GDI: BitBlt requires the thread to be on the input desktop; without this
// the GDI fallback path produces zero frames indefinitely.
func prepareCaptureThread() {
	runtime.LockOSThread()
	switchThreadToInputDesktop()
}
