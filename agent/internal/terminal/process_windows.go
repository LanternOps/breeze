//go:build windows

package terminal

import (
	"sync/atomic"

	"golang.org/x/sys/windows"
)

// killProcess closes the ConPTY (signalling the child to exit) and
// force-terminates the process. Handle cleanup is deferred to awaitProcess.
func (s *Session) killProcess() {
	// Close ConPTY first — this triggers an orderly shutdown of the child.
	if hPC := atomic.SwapUintptr(&s.hConPty, 0); hPC != 0 {
		closeConPTY(hPC)
	}
	// Force-terminate if still alive.
	if h := atomic.LoadUintptr(&s.hProc); h != 0 {
		_ = windows.TerminateProcess(windows.Handle(h), 1)
	} else if s.cmd != nil && s.cmd.Process != nil {
		// Fallback for legacy pipe mode.
		s.cmd.Process.Kill()
	}
}

// awaitProcess waits for the child process to exit and cleans up all
// Windows handles (process, thread, ConPTY).
func (s *Session) awaitProcess() error {
	h := windows.Handle(atomic.LoadUintptr(&s.hProc))
	if h != 0 {
		_, _ = windows.WaitForSingleObject(h, windows.INFINITE)
		// Process exited — clean up all handles.
		if h2 := windows.Handle(atomic.SwapUintptr(&s.hProc, 0)); h2 != 0 {
			windows.CloseHandle(h2)
		}
		if ht := windows.Handle(atomic.SwapUintptr(&s.hThread, 0)); ht != 0 {
			windows.CloseHandle(ht)
		}
		if hPC := atomic.SwapUintptr(&s.hConPty, 0); hPC != 0 {
			closeConPTY(hPC)
		}
		return nil
	}
	// Fallback for legacy pipe mode.
	if s.cmd != nil {
		return s.cmd.Wait()
	}
	return nil
}
