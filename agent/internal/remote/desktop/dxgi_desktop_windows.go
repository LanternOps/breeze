//go:build windows && !cgo

package desktop

import (
	"fmt"
	"log/slog"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// pinCaptureThreadLocked pins the capture goroutine to one OS thread.
// Caller must hold c.mu.
func (c *dxgiCapturer) pinCaptureThreadLocked() {
	if c.captureThreadPinned {
		return
	}
	runtime.LockOSThread()
	c.captureThreadPinned = true
	slog.Debug("Pinned capture goroutine to OS thread")
}

// closeDesktopHandle closes the desktop handle opened via OpenInputDesktop.
// Called during final cleanup (Close).
func (c *dxgiCapturer) closeDesktopHandle() {
	if c.currentDesktop != 0 {
		procCloseDesktop.Call(c.currentDesktop)
		c.currentDesktop = 0
	}
}

// switchToInputDesktop attempts to switch the calling thread to the currently
// active input desktop. This allows DXGI Desktop Duplication to capture the
// Secure Desktop (UAC prompts, lock screen, Ctrl+Alt+Del) when the agent runs
// as an elevated process. Returns true if the desktop was switched.
//
// Must be called before initDXGI() — DuplicateOutput binds to whichever
// desktop is current on the calling thread.
func (c *dxgiCapturer) switchToInputDesktop() bool {
	// SetThreadDesktop is per-thread; keep capture on a single OS thread.
	c.pinCaptureThreadLocked()

	// Open the currently active input desktop.
	// Required to attach to the secure desktop (UAC, lock screen).
	hDesk, _, err := procOpenInputDesktop.Call(
		0,                          // dwFlags
		0,                          // fInherit (FALSE)
		uintptr(desktopGenericAll), // dwDesiredAccess
	)
	if hDesk == 0 {
		slog.Warn("OpenInputDesktop failed", "error", err.Error())
		return false
	}

	// Attempt to switch. SetThreadDesktop fails if the thread has any
	// windows or hooks on the current desktop, which shouldn't apply to
	// our capture goroutine.
	ret, _, err := procSetThreadDesktop.Call(hDesk)
	if ret == 0 {
		// Fails with ERROR_INVALID_PARAMETER if already on this desktop,
		// or ACCESS_DENIED if the thread owns windows. Either way, clean up.
		procCloseDesktop.Call(hDesk)
		slog.Debug("SetThreadDesktop failed (may already be on input desktop)", "error", err.Error())
		return false
	}

	// Close the previous desktop handle we opened (if any).
	if c.currentDesktop != 0 {
		procCloseDesktop.Call(c.currentDesktop)
	}
	c.currentDesktop = hDesk

	slog.Info("Switched to input desktop for secure desktop capture",
		"desktop", fmt.Sprintf("0x%X", hDesk))
	return true
}

// desktopName returns the name of the given desktop handle using
// GetUserObjectInformationW(UOI_NAME). Returns "" on failure.
func desktopName(hDesk uintptr) string {
	var buf [128]uint16
	var needed uint32
	ret, _, _ := procGetUserObjectInformationW.Call(
		hDesk,
		uoiName,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(len(buf)*2),
		uintptr(unsafe.Pointer(&needed)),
	)
	if ret == 0 {
		return ""
	}
	// Find null terminator
	n := int(needed / 2)
	if n > len(buf) {
		n = len(buf)
	}
	for i := 0; i < n; i++ {
		if buf[i] == 0 {
			n = i
			break
		}
	}
	return syscall.UTF16ToString(buf[:n])
}

// checkDesktopSwitch detects UAC/lock screen transitions that don't trigger
// DXGI_ERROR_ACCESS_LOST. Some Windows versions just stop producing frames
// when the Secure Desktop activates, causing endless timeouts instead of
// ACCESS_LOST. This method periodically checks if the input desktop changed.
//
// When switching TO a Secure Desktop (Winlogon/Screen-saver), DXGI Desktop
// Duplication cannot capture the content — it produces empty frames. We fall
// back to GDI (BitBlt) which can capture the Secure Desktop.
// When switching BACK to Default, we reinit DXGI for GPU-accelerated capture.
//
// Returns true if a desktop switch was detected and capture was reconfigured.
func (c *dxgiCapturer) checkDesktopSwitch() bool {
	// Desktop attachment must be stable across calls in this loop.
	c.pinCaptureThreadLocked()

	now := time.Now()
	if now.Sub(c.lastDesktopCheck) < 500*time.Millisecond {
		return false
	}
	c.lastDesktopCheck = now

	// Get the current thread's desktop name
	threadID, _, _ := procGetCurrentThreadId.Call()
	currentDesk, _, _ := procGetThreadDesktop.Call(threadID)
	if currentDesk == 0 {
		c.logDesktopCheckSkip("GetThreadDesktop returned 0")
		return false
	}
	currentName := desktopName(currentDesk)

	// Open the active input desktop (may be Secure/Winlogon during UAC)
	inputDesk, _, _ := procOpenInputDesktop.Call(0, 0, uintptr(desktopGenericAll))
	if inputDesk == 0 {
		// Can't open input desktop — may lack permission or be in transition.
		// Rate-limited log so the watchdog can correlate.
		c.logDesktopCheckSkip("OpenInputDesktop returned 0 (possible transition)")
		return false
	}
	inputName := desktopName(inputDesk)

	// Empty name from GetUserObjectInformationW is transient — comparing two
	// empty strings would falsely assert "same desktop" and suppress switch
	// detection. Bail out so the watchdog can retry once the names become
	// readable again.
	if currentName == "" || inputName == "" {
		c.logDesktopCheckSkip(fmt.Sprintf("desktop name empty (current=%q input=%q)", currentName, inputName))
		procCloseDesktop.Call(inputDesk)
		return false
	}

	// Compare by name: handle values differ even for the same desktop
	// because OpenInputDesktop returns a new handle each time.
	// Desktop names: "Default" (normal), "Winlogon" (UAC/lock), "Screen-saver".
	if currentName == inputName {
		onSecure := inputName != "" && !strings.EqualFold(inputName, "Default")
		wasSecure := c.secureDesktopFlag.Load()
		c.secureDesktopFlag.Store(onSecure)
		c.gdiNoFrameCount = 0

		// Startup edge-case: if capture starts while already on Winlogon/UAC,
		// there is no "transition" event to trigger fallback. Force GDI now
		// and explicitly re-attach the capture thread to the input desktop so
		// subsequent GetThreadDesktop / GetUserObjectInformationW calls return
		// a consistent name. Without the explicit re-attach, the thread can
		// remain pointed at a stale desktop handle from prepareCaptureThread
		// and checkDesktopSwitch will fail to detect later transitions.
		if onSecure && c.gdiFallback == nil {
			c.releaseDXGI()
			if ret, _, err := procSetThreadDesktop.Call(inputDesk); ret != 0 {
				if c.currentDesktop != 0 && c.currentDesktop != inputDesk {
					procCloseDesktop.Call(c.currentDesktop)
				}
				c.currentDesktop = inputDesk
				inputDesk = 0 // prevent double-close below
			} else {
				slog.Warn("SetThreadDesktop failed during secure-desktop startup",
					"desktop", inputName, "error", err.Error())
			}
			c.gdiFallback = &gdiCapturer{config: c.config}
			c.desktopSwitchFlag.Store(true)
			slog.Info("Secure desktop active without transition event, using GDI capture",
				"desktop", inputName)
		} else if !onSecure && c.gdiFallback != nil {
			// Recover DXGI if we're back on Default but still in fallback mode.
			c.gdiFallback.releaseHandles()
			c.gdiFallback = nil
			if err := c.initDXGI(); err != nil {
				slog.Warn("DXGI reinit failed while leaving fallback mode", "error", err.Error())
				c.switchToGDI()
			}
		}
		if onSecure != wasSecure {
			c.desktopSwitchFlag.Store(true)
		}
		if inputDesk != 0 {
			procCloseDesktop.Call(inputDesk)
		}
		return false
	}

	slog.Info("Desktop change detected",
		"from", currentName, "to", inputName)

	// Release current capture resources
	c.releaseDXGI()
	if c.gdiFallback != nil {
		c.gdiFallback.releaseHandles()
		c.gdiFallback = nil
	}

	// Switch thread to new desktop
	ret, _, _ := procSetThreadDesktop.Call(inputDesk)
	if ret == 0 {
		procCloseDesktop.Call(inputDesk)
		// Determine the desktop we're actually on after the failed switch and
		// reconfigure capture accordingly so session-layer state stays coherent.
		threadID, _, _ := procGetCurrentThreadId.Call()
		threadDesk, _, _ := procGetThreadDesktop.Call(threadID)
		actualName := desktopName(threadDesk)
		if actualName == "" {
			actualName = currentName
		}
		switched := !strings.EqualFold(actualName, currentName)
		if switched {
			c.desktopSwitchFlag.Store(true)
		}

		onSecure := !strings.EqualFold(actualName, "Default")
		c.secureDesktopFlag.Store(onSecure)
		c.gdiNoFrameCount = 0

		if onSecure {
			c.gdiFallback = &gdiCapturer{config: c.config}
			slog.Warn("SetThreadDesktop failed during desktop switch; using GDI on current desktop",
				"from", currentName, "to", inputName, "current", actualName)
			return switched
		}

		if err := c.initDXGI(); err != nil {
			slog.Warn("DXGI reinit failed after SetThreadDesktop failure", "error", err.Error())
			c.switchToGDI()
		}
		slog.Warn("SetThreadDesktop failed during desktop switch; capture fallback active on current desktop",
			"from", currentName, "to", inputName, "current", actualName)
		return switched
	}

	if c.currentDesktop != 0 {
		procCloseDesktop.Call(c.currentDesktop)
	}
	c.currentDesktop = inputDesk

	// Signal desktop switch to the session layer
	c.desktopSwitchFlag.Store(true)

	if strings.EqualFold(inputName, "Default") {
		// Returning to normal desktop: use DXGI for GPU-accelerated capture.
		c.secureDesktopFlag.Store(false)
		c.gdiNoFrameCount = 0
		slog.Info("Switched back to Default desktop, reinitializing DXGI")
		if err := c.initDXGI(); err != nil {
			slog.Warn("DXGI reinit failed after desktop switch", "error", err.Error())
			c.switchToGDI()
		}
	} else {
		// Secure Desktop (Winlogon, Screen-saver): use GDI. DXGI captures
		// partial/filtered content for UAC dialogs (blank white rectangles).
		// GDI BitBlt captures the full composed output.
		c.secureDesktopFlag.Store(true)
		slog.Info("Switched to Secure Desktop, using GDI capture",
			"desktop", inputName)
		c.gdiFallback = &gdiCapturer{config: c.config}
		c.gdiNoFrameCount = 0
	}
	return true
}

func (c *dxgiCapturer) switchToGDI() {
	c.releaseDXGI()
	c.gdiFallback = &gdiCapturer{config: c.config}
	c.gdiNoFrameCount = 0
	slog.Info("Switched to GDI screen capture fallback")
}

// switchThreadToInputDesktop is a standalone helper that attaches the calling
// OS thread to the currently active input desktop. Unlike switchToInputDesktop
// (which is a method on dxgiCapturer and manages capturer state), this is safe
// to call from any goroutine without affecting capturer bookkeeping.
//
// The caller MUST have called runtime.LockOSThread() first, because
// SetThreadDesktop is per-OS-thread. The returned desktop handle is left open
// (it becomes the thread's current desktop); closing it would detach the thread.
func switchThreadToInputDesktop() bool {
	hDesk, _, err := procOpenInputDesktop.Call(
		0,                          // dwFlags
		0,                          // fInherit (FALSE)
		uintptr(desktopGenericAll), // dwDesiredAccess
	)
	if hDesk == 0 {
		slog.Debug("switchThreadToInputDesktop: OpenInputDesktop failed", "error", err.Error())
		return false
	}
	ret, _, err := procSetThreadDesktop.Call(hDesk)
	if ret == 0 {
		procCloseDesktop.Call(hDesk)
		slog.Debug("switchThreadToInputDesktop: SetThreadDesktop failed (may already be on input desktop)", "error", err.Error())
		return false
	}
	slog.Info("Attached thread to input desktop", "desktop", fmt.Sprintf("0x%X", hDesk))
	return true
}

// ConsumeDesktopSwitch implements DesktopSwitchNotifier.
func (c *dxgiCapturer) ConsumeDesktopSwitch() bool {
	return c.desktopSwitchFlag.CompareAndSwap(true, false)
}

// OnSecureDesktop implements DesktopSwitchNotifier.
func (c *dxgiCapturer) OnSecureDesktop() bool {
	return c.secureDesktopFlag.Load()
}

// logDesktopCheckSkip emits a rate-limited warning when checkDesktopSwitch
// bails out before doing its comparison. Surfaces transitional Win32
// failures (empty names, OpenInputDesktop returning 0) so the no-video
// watchdog can be correlated to a root cause.
func (c *dxgiCapturer) logDesktopCheckSkip(reason string) {
	if time.Since(c.lastDesktopSkipLog) < 5*time.Second {
		return
	}
	c.lastDesktopSkipLog = time.Now()
	slog.Warn("checkDesktopSwitch skipped", "reason", reason)
}

// ForceReattach tears down the current capture backend, re-reads the current
// thread desktop, and re-initializes DXGI (or GDI on secure desktops). It is
// the recovery path used by the capture-loop watchdog when video output has
// stalled — typically the silent "user logged in" case where OpenInputDesktop
// or GetUserObjectInformationW returns empty names and the normal
// checkDesktopSwitch path cannot detect the transition.
//
// MUST be called from the pinned capture goroutine: it relies on the OS
// thread already being locked and desktop-attached (e.g. by the watchdog
// calling switchThreadToInputDesktop before this method).
func (c *dxgiCapturer) ForceReattach() {
	c.releaseDXGI()
	if c.gdiFallback != nil {
		c.gdiFallback.releaseHandles()
		c.gdiFallback = nil
	}
	c.gdiNoFrameCount = 0
	c.consecutiveFailures = 0

	// Re-read the current thread desktop after the caller's
	// switchThreadToInputDesktop() has run.
	threadID, _, _ := procGetCurrentThreadId.Call()
	currentDesk, _, _ := procGetThreadDesktop.Call(threadID)
	currentName := desktopName(currentDesk)
	onSecure := decideReattach(currentName) == reattachUseGDI

	c.secureDesktopFlag.Store(onSecure)
	c.desktopSwitchFlag.Store(true)

	if onSecure {
		c.gdiFallback = &gdiCapturer{config: c.config}
		slog.Warn("ForceReattach: on secure desktop, using GDI",
			"desktop", currentName)
		return
	}

	if err := c.initDXGI(); err != nil {
		slog.Warn("ForceReattach: initDXGI failed, falling back to GDI",
			"desktop", currentName, "error", err.Error())
		c.switchToGDI()
		return
	}
	slog.Info("ForceReattach: re-initialized DXGI", "desktop", currentName)
}
