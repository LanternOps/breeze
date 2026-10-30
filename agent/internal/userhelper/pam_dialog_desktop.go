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
	var result ipc.PamDialogResult
	runOnInputDesktop(ops, false, func(name string) { result = show(name) })
	return result
}

// runOnInputDesktop runs show with the calling OS thread attached to the
// desktop that has input now, and restores the thread's desktop after. When
// the input desktop cannot be attached, a non-strict caller (today's PAM
// dialog) runs show on the thread's current desktop; a strict caller (the
// SYSTEM helper's prompt renderer, #10190 W07) runs nothing. It reports
// whether show ran.
func runOnInputDesktop(ops pamDesktopOps, strict bool, show func(inputDesktopName string)) bool {
	ops.LockOSThread()
	shouldUnlock := true
	defer func() {
		if shouldUnlock {
			ops.UnlockOSThread()
		}
	}()
	fallback := func() bool {
		if strict {
			return false
		}
		show("")
		return true
	}

	originalDesktop, err := ops.CurrentThreadDesktop()
	if err != nil || originalDesktop == 0 {
		log.Warn("pam: current thread desktop unavailable", "strict", strict, "error", pamDesktopErrorString(err))
		return fallback()
	}

	inputDesktop, err := ops.OpenInputDesktop()
	if err != nil || inputDesktop == 0 {
		log.Warn("pam: active input desktop unavailable", "strict", strict, "error", pamDesktopErrorString(err))
		return fallback()
	}

	inputDesktopName, err := ops.DesktopName(inputDesktop)
	if err != nil || inputDesktopName == "" {
		log.Warn("pam: active input desktop name unavailable", "strict", strict, "error", pamDesktopErrorString(err))
		closePamDesktop(ops, inputDesktop)
		return fallback()
	}

	if err := ops.SetThreadDesktop(inputDesktop); err != nil {
		log.Warn("pam: failed to attach dialog thread to active input desktop",
			"desktop", inputDesktopName, "strict", strict, "error", err.Error())
		closePamDesktop(ops, inputDesktop)
		return fallback()
	}

	// Register restoration only after the switch succeeds. It runs before the
	// unlock defer above, including if the dialog panics. The input handle is
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

	show(inputDesktopName)
	return true
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
