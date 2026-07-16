package userhelper

import "github.com/breeze-rmm/agent/internal/ipc"

// pamDesktopOps isolates the per-thread desktop lifecycle from the Win32
// syscalls so fallback, restore, and handle ownership can be tested on every
// development platform.
type pamDesktopOps interface {
	LockOSThread()
	UnlockOSThread()
	CurrentThreadDesktop() (uintptr, error)
	OpenInputDesktop() (uintptr, error)
	DesktopName(handle uintptr) (string, error)
	SetThreadDesktop(handle uintptr) error
	CloseDesktop(handle uintptr) error
}

// showPamDialogOnInputDesktop temporarily attaches the calling OS thread to
// the desktop currently receiving input, shows the dialog there, then restores
// the original desktop. Discovery failures preserve the old behavior by
// showing on the helper thread's current desktop.
func showPamDialogOnInputDesktop(ops pamDesktopOps, show func(inputDesktopName string) ipc.PamDialogResult) ipc.PamDialogResult {
	ops.LockOSThread()
	shouldUnlock := true
	defer func() {
		if shouldUnlock {
			ops.UnlockOSThread()
		}
	}()

	originalDesktop, err := ops.CurrentThreadDesktop()
	if err != nil || originalDesktop == 0 {
		log.Warn("pam: current thread desktop unavailable; showing dialog on current desktop", "error", pamDesktopErrorString(err))
		return show("")
	}

	inputDesktop, err := ops.OpenInputDesktop()
	if err != nil || inputDesktop == 0 {
		log.Warn("pam: active input desktop unavailable; showing dialog on current desktop", "error", pamDesktopErrorString(err))
		return show("")
	}

	inputDesktopName, err := ops.DesktopName(inputDesktop)
	if err != nil || inputDesktopName == "" {
		log.Warn("pam: active input desktop name unavailable; showing dialog on current desktop", "error", pamDesktopErrorString(err))
		closePamDesktop(ops, inputDesktop)
		return show("")
	}

	if err := ops.SetThreadDesktop(inputDesktop); err != nil {
		log.Warn("pam: failed to attach dialog thread to active input desktop; showing on current desktop",
			"desktop", inputDesktopName, "error", err.Error())
		closePamDesktop(ops, inputDesktop)
		return show("")
	}

	// Register restoration only after the switch succeeds. It runs before the
	// unlock defer above, including if MessageBoxW panics. The input handle is
	// safe to close only after this thread is no longer attached to it.
	defer func() {
		if err := ops.SetThreadDesktop(originalDesktop); err != nil {
			// Returning a Winlogon-bound thread to Go's scheduler could put an
			// unrelated goroutine on the secure desktop. Leave the goroutine
			// locked; safeGo's short-lived handler goroutine will exit and Go will
			// retire its OS thread. CloseDesktop cannot close a handle still used
			// by this thread, so this exceptional path intentionally leaves the
			// process-owned handle open until the helper restarts or exits.
			shouldUnlock = false
			log.Error("pam: failed to restore original thread desktop; retiring locked OS thread and leaving input handle open",
				"desktop", inputDesktopName, "error", err.Error())
			return
		}
		closePamDesktop(ops, inputDesktop)
	}()

	return show(inputDesktopName)
}

func closePamDesktop(ops pamDesktopOps, handle uintptr) {
	if err := ops.CloseDesktop(handle); err != nil {
		log.Warn("pam: failed to close input desktop handle", "error", err.Error())
	}
}

func pamDesktopErrorString(err error) string {
	if err == nil {
		return "unknown error"
	}
	return err.Error()
}
