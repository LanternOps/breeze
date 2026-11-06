//go:build windows && !cgo

package desktop

import (
	"fmt"
	"image"
	"log/slog"
	"runtime"
	"sync"
	"syscall"
	"time"
)

var (
	// user32 is already declared in input_windows.go (same package)
	gdi32 = syscall.NewLazyDLL("gdi32.dll")

	procGetDC            = user32.NewProc("GetDC")
	procReleaseDC        = user32.NewProc("ReleaseDC")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")

	procCreateDCW          = gdi32.NewProc("CreateDCW")
	procCreateCompatibleDC = gdi32.NewProc("CreateCompatibleDC")
	procCreateDIBSection   = gdi32.NewProc("CreateDIBSection")
	procSelectObject       = gdi32.NewProc("SelectObject")
	procBitBlt             = gdi32.NewProc("BitBlt")
	procGdiFlush           = gdi32.NewProc("GdiFlush")
	procDeleteDC           = gdi32.NewProc("DeleteDC")
	procDeleteObject       = gdi32.NewProc("DeleteObject")
)

const (
	smCxScreen = 0
	smCyScreen = 1
)

// displayDeviceName is L"DISPLAY" as a UTF-16 null-terminated string.
var displayDeviceName = syscall.StringToUTF16Ptr("DISPLAY")

// winGDIFrameOps is the real, syscall-backed gdiFrameOps. The frame sequence
// itself lives in capture_gdi.go so it can be exercised on the Linux CI runner
// — this type is only the thin Win32 binding. Every call keeps the errno from
// LazyProc.Call and returns it.
type winGDIFrameOps struct{}

func (winGDIFrameOps) BitBlt(dstDC uintptr, width, height int, srcDC uintptr, rop uint32) (bool, error) {
	ret, _, errno := procBitBlt.Call(dstDC, 0, 0, uintptr(width), uintptr(height),
		srcDC, 0, 0, uintptr(rop))
	return ret != 0, errno
}

func (winGDIFrameOps) GdiFlush() (bool, error) {
	ret, _, errno := procGdiFlush.Call()
	return ret != 0, errno
}

// currentThreadID returns the calling OS thread's id, or 0 if it cannot be
// read.
func currentThreadID() uint32 {
	tid, _, _ := procGetCurrentThreadId.Call()
	return uint32(tid)
}

// gdiThreadRecycleInterval bounds how often a capturer retires its capture
// thread after an ERROR_BUSY desktop attach. The startup probe retries every
// 200ms, so this has to be shorter than that for a recycled thread to be ready
// for the probe's next attempt.
const gdiThreadRecycleInterval = 150 * time.Millisecond

// gdiCapturer implements ScreenCapturer using Windows GDI (no CGo required).
//
// Every GDI and desktop call runs on one dedicated, locked OS thread owned by
// the capturer (lockedThread), whichever goroutine calls Capture (#8434). That
// thread attaches itself to the input desktop before creating its display DC
// and DIB section, and re-attaches (rebuilding both) whenever the input desktop
// changes, so the desktop switch, the DC and the bitmap can never end up on
// different threads or different desktops.
type gdiCapturer struct {
	config CaptureConfig
	mu     sync.Mutex

	// thread runs all GDI work; state is touched only inside thread.Do.
	// Both are nil until the first capture, and again after Close or after a
	// thread is retired (see recycleThreadLocked).
	thread      *lockedThread
	state       *gdiThreadState
	lastRecycle time.Time

	// Failure throttling for secure-desktop transient capture outages.
	consecutiveCaptureFailures int
	lastFailureLog             time.Time

	// lastCaptureErr is the most recent error reported to the caller as a nil
	// frame. Capture() deliberately swallows failures so a transient
	// secure-desktop outage does not kill a live session; keeping the error
	// here is what lets StartSession tell the technician WHY the startup probe
	// found no frame (see describeCaptureFailure).
	lastCaptureErr error
}

// startThreadLocked starts the capture thread. Caller holds c.mu.
func (c *gdiCapturer) startThreadLocked() {
	st := &gdiThreadState{}
	c.state = st
	c.thread = startLockedThread(st.shutdown)
	// Safety net only: every owner Closes its capturer, but a capturer that is
	// dropped without Close would otherwise strand a locked OS thread for the
	// life of the helper. The cleanup holds the thread, never the capturer.
	runtime.AddCleanup(c, func(t *lockedThread) { t.stopAsync() }, c.thread)
}

// recycleThreadLocked retires the capture thread so the next frame starts a
// fresh one. Used only for ERROR_BUSY from SetThreadDesktop, which is a
// property of the OS thread (it owns windows or hooks): the retired thread is
// terminated rather than returned to the Go scheduler, because lockedThread
// never unlocks it. Caller holds c.mu.
func (c *gdiCapturer) recycleThreadLocked(cause error) {
	if c.thread == nil || time.Since(c.lastRecycle) < gdiThreadRecycleInterval {
		return
	}
	c.lastRecycle = time.Now()
	c.thread.Stop()
	c.thread = nil
	c.state = nil
	slog.Warn("Retiring GDI capture thread that cannot attach to the input desktop; the next frame starts a new thread",
		"error", cause.Error())
}

// Capture captures the primary screen on the capturer's own thread.
func (c *gdiCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.thread == nil {
		c.startThreadLocked()
	}
	st := c.state
	var img *image.RGBA
	var capErr error
	if err := c.thread.Do(func() { img, capErr = st.capture() }); err != nil {
		capErr = err
	}
	if capErr == nil && img != nil {
		c.resetCaptureFailuresLocked()
		return img, nil
	}
	if capErr == nil {
		capErr = fmt.Errorf("GDI capture produced no image")
	}
	if shouldRecycleCaptureThread(capErr) {
		c.recycleThreadLocked(capErr)
	}

	// Secure-desktop transitions can invalidate DCs transiently. Treat this as
	// "no frame yet" so the session loop skips without flooding error logs.
	// The startup probe (probeCapture) retries then fails on persistent nil
	// frames — and reads lastCaptureErr back out via LastCaptureError so the
	// technician is told which Win32 call failed and with what code.
	c.recordCaptureFailureLocked(capErr)
	return nil, nil
}

func (c *gdiCapturer) recordCaptureFailureLocked(err error) {
	c.consecutiveCaptureFailures++
	changed := c.lastCaptureErr == nil || c.lastCaptureErr.Error() != err.Error()
	c.lastCaptureErr = err
	now := time.Now()
	// A different failure is always logged: the throttle exists to stop one
	// repeating error flooding the log, not to hide that the cause changed.
	if changed || c.consecutiveCaptureFailures == 1 || now.Sub(c.lastFailureLog) >= 2*time.Second {
		attrs := []any{
			"error", err.Error(),
			"consecutive", c.consecutiveCaptureFailures,
		}
		// Surface the Win32 code as its own field so it is greppable in a
		// helper log without parsing the message.
		if code, ok := win32ErrorCode(err); ok {
			attrs = append(attrs, "win32Error", code)
		}
		slog.Warn("GDI capture unavailable (returning no frame)", attrs...)
		c.lastFailureLog = now
	}
}

func (c *gdiCapturer) resetCaptureFailuresLocked() {
	c.consecutiveCaptureFailures = 0
	c.lastCaptureErr = nil
}

// LastCaptureError implements lastCaptureErrorReporter.
func (c *gdiCapturer) LastCaptureError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastCaptureErr
}

// CaptureRegion captures a specific region of the screen.
func (c *gdiCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	fullImg, err := c.Capture()
	if err != nil {
		return nil, err
	}
	if fullImg == nil {
		return nil, nil
	}

	bounds := image.Rect(x, y, x+width, y+height)
	if !bounds.In(fullImg.Bounds()) {
		captureImagePool.Put(fullImg)
		return nil, fmt.Errorf("region out of bounds")
	}

	cropped := image.NewRGBA(image.Rect(0, 0, width, height))
	for dy := 0; dy < height; dy++ {
		srcStart := (y+dy)*fullImg.Stride + x*4
		dstStart := dy * cropped.Stride
		copy(cropped.Pix[dstStart:dstStart+width*4], fullImg.Pix[srcStart:srcStart+width*4])
	}

	captureImagePool.Put(fullImg)
	return cropped, nil
}

// GetScreenBounds returns the primary screen dimensions.
func (c *gdiCapturer) GetScreenBounds() (width, height int, err error) {
	w, _, _ := procGetSystemMetrics.Call(smCxScreen)
	h, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if w == 0 || h == 0 {
		return 0, 0, fmt.Errorf("GetSystemMetrics returned zero dimensions")
	}
	return int(w), int(h), nil
}

// Close releases the GDI handles and the desktop handle on the capture thread,
// then stops the thread. A later Capture starts a new thread.
func (c *gdiCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.thread != nil {
		c.thread.Stop()
		c.thread = nil
		c.state = nil
	}
	return nil
}

var _ ScreenCapturer = (*gdiCapturer)(nil)
var _ lastCaptureErrorReporter = (*gdiCapturer)(nil)
