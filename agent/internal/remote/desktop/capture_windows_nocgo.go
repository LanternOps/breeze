//go:build windows && !cgo

package desktop

import (
	"errors"
	"fmt"
	"image"
	"log/slog"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	// user32 is already declared in input_windows.go (same package)
	gdi32 = syscall.NewLazyDLL("gdi32.dll")

	procGetDC              = user32.NewProc("GetDC")
	procReleaseDC          = user32.NewProc("ReleaseDC")
	procGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	procSetProcessDPIAware = user32.NewProc("SetProcessDPIAware")

	procCreateDCW              = gdi32.NewProc("CreateDCW")
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
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
// LazyProc.Call and returns it; discarding it with `ret, _, _` is what left
// #5284's Winlogon failure reported as the bare string "GetDIBits failed".
type winGDIFrameOps struct{}

func (winGDIFrameOps) SelectObject(hdc, hgdiobj uintptr) (uintptr, error) {
	prev, _, errno := procSelectObject.Call(hdc, hgdiobj)
	return prev, errno
}

func (winGDIFrameOps) BitBlt(dstDC uintptr, width, height int, srcDC uintptr, rop uint32) (bool, error) {
	ret, _, errno := procBitBlt.Call(dstDC, 0, 0, uintptr(width), uintptr(height),
		srcDC, 0, 0, uintptr(rop))
	return ret != 0, errno
}

func (winGDIFrameOps) GetDIBits(hdc, hbm uintptr, lines int, bits *byte, bi *bitmapInfo) (int, error) {
	copied, _, errno := procGetDIBits.Call(
		hdc,
		hbm,
		0,
		uintptr(lines),
		uintptr(unsafe.Pointer(bits)),
		uintptr(unsafe.Pointer(bi)),
		dibRGBColors,
	)
	return int(copied), errno
}

// currentThreadID returns the calling OS thread's id, or 0 if it cannot be
// read. See shouldRebuildGDIHandles for why the capturer tracks it.
func currentThreadID() uint32 {
	tid, _, _ := procGetCurrentThreadId.Call()
	return uint32(tid)
}

// gdiCapturer implements ScreenCapturer using Windows GDI (no CGo required).
// GDI handles are created once and reused across frames for performance.
type gdiCapturer struct {
	config CaptureConfig
	mu     sync.Mutex

	// Persistent GDI handles
	screenDC      uintptr
	screenDCOwned bool // true if screenDC was created via CreateDC (must use DeleteDC)
	memDC         uintptr
	hBitmap       uintptr
	oldBitmap     uintptr
	bi            bitmapInfo
	width         int
	height        int
	inited        bool

	// ownerThreadID is the OS thread that created the handles above. A display
	// DC from CreateDC is documented to become invalid once its creating thread
	// exits, and the GetDC fallback must be released on the same thread, so the
	// handles are rebuilt when the capturing thread changes. See
	// shouldRebuildGDIHandles.
	ownerThreadID uint32

	// Reusable pixel buffer (BGRA from GetDIBits)
	pixBuf []byte

	// Failure throttling for secure-desktop transient capture outages.
	consecutiveCaptureFailures int
	lastFailureLog             time.Time

	// Throttling for GDI handles Win32 refused to free. Separate from the
	// capture-failure counters because a leak is a different problem with a
	// different remedy, and it must not be hidden by the capture throttle.
	teardownFailures int
	lastTeardownLog  time.Time

	// lastCaptureErr is the most recent error reported to the caller as a nil
	// frame. Capture() deliberately swallows failures so a transient
	// secure-desktop outage does not kill a live session; keeping the error
	// here is what lets StartSession tell the technician WHY the startup probe
	// found no frame (see describeCaptureFailure).
	lastCaptureErr error
}

func init() {
	if procSetProcessDPIAware.Find() != nil {
		return
	}
	// Not fatal, but not nothing either: without DPI awareness GetSystemMetrics
	// reports scaled dimensions, which is the same class of capture/encoder size
	// mismatch AlignEven exists to prevent (see ensureHandles). Worth a line in
	// the helper log rather than nothing at all.
	if ret, _, errno := procSetProcessDPIAware.Call(); ret == 0 {
		slog.Debug("SetProcessDPIAware failed; capture dimensions may be DPI-scaled",
			"error", gdiCallError("SetProcessDPIAware", errno).Error())
	}
}

// ensureHandles creates or recreates GDI handles if needed.
func (c *gdiCapturer) ensureHandles() error {
	w, _, _ := procGetSystemMetrics.Call(smCxScreen)
	h, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if w == 0 || h == 0 {
		return fmt.Errorf("GetSystemMetrics returned zero dimensions")
	}
	// Round to even dimensions so the bitmap, BitBlt, and pixBuf all agree
	// with the downstream H264 encoder's required even alignment. On displays
	// with odd pixel dimensions (e.g. 1512x949 from a physical panel at 125%
	// scaling) the unrounded capture buffer produces a one-row mismatch
	// against the encoder's SetDimensions `h &^ 1` and every frame fails to
	// encode with "frame size 1434888 doesn't match 1512x948".
	width, height := AlignEven(int(w), int(h))

	tid := currentThreadID()
	if !shouldRebuildGDIHandles(c.inited, c.width, c.height, width, height, c.ownerThreadID, tid) {
		return nil
	}
	if c.inited && c.width == width && c.height == height && c.ownerThreadID != tid {
		// Worth a log line: this is the handover from the startup probe's
		// thread to the streaming loop's thread, and it is the point at which
		// a stale display DC would otherwise start being used (#5284).
		slog.Info("Rebuilding GDI capture handles on the current capture thread",
			"createdOnThread", c.ownerThreadID, "currentThread", tid)
	}

	// Release old handles if resolution or owning thread changed
	c.releaseHandles()

	// Use CreateDC("DISPLAY") instead of GetDC(0). GetDC(0) returns a DC
	// for the desktop window which fails on the Winlogon (secure) desktop.
	// CreateDC("DISPLAY") creates a DC for the physical display directly,
	// bypassing the window/desktop association, and works on all desktops.
	hdc, _, createDCErrno := procCreateDCW.Call(
		uintptr(unsafe.Pointer(displayDeviceName)),
		0, 0, 0,
	)
	if hdc == 0 {
		// Fall back to GetDC(0) if CreateDC fails
		var getDCErrno error
		hdc, _, getDCErrno = procGetDC.Call(0)
		if hdc == 0 {
			return fmt.Errorf("no display DC available: %w; %w",
				gdiCallError("CreateDC(DISPLAY)", createDCErrno),
				gdiCallError("GetDC(0)", getDCErrno))
		}
		c.screenDCOwned = false
	} else {
		c.screenDCOwned = true
	}

	// Create compatible memory DC
	memDC, _, memDCErrno := procCreateCompatibleDC.Call(hdc)
	if memDC == 0 {
		err := gdiCallError("CreateCompatibleDC", memDCErrno)
		c.freeScreenDC(hdc)
		return err
	}

	// Create compatible bitmap
	hBitmap, _, bitmapErrno := procCreateCompatibleBitmap.Call(hdc, uintptr(width), uintptr(height))
	if hBitmap == 0 {
		err := gdiCallError("CreateCompatibleBitmap", bitmapErrno)
		procDeleteDC.Call(memDC)
		c.freeScreenDC(hdc)
		return err
	}

	// Select bitmap into memory DC. It is deselected again around every
	// readback — see captureGDIFrame — because GetDIBits requires it.
	oldBitmap, _, selectErrno := procSelectObject.Call(memDC, hBitmap)
	if oldBitmap == 0 {
		err := gdiCallError("SelectObject", selectErrno)
		procDeleteObject.Call(hBitmap)
		procDeleteDC.Call(memDC)
		c.freeScreenDC(hdc)
		return err
	}

	c.screenDC = hdc
	c.memDC = memDC
	c.hBitmap = hBitmap
	c.oldBitmap = oldBitmap
	c.width = width
	c.height = height
	c.ownerThreadID = tid
	c.inited = true

	// Pre-allocate pixel buffer and BITMAPINFO
	c.pixBuf = make([]byte, width*height*4)
	c.bi = newCaptureBitmapInfo(width, height)

	return nil
}

// freeScreenDC releases a display DC through whichever entry point created it,
// and reports whether Win32 accepted the release.
func (c *gdiCapturer) freeScreenDC(hdc uintptr) bool {
	if hdc == 0 {
		return true
	}
	var ret uintptr
	if c.screenDCOwned {
		ret, _, _ = procDeleteDC.Call(hdc) // CreateDC → DeleteDC
	} else {
		ret, _, _ = procReleaseDC.Call(0, hdc) // GetDC → ReleaseDC
	}
	return ret != 0
}

// releaseHandles frees all persistent GDI handles.
//
// Teardown results are checked rather than discarded. Handles are now rebuilt
// on a thread change and after an unusable-handle frame, so a driver that
// persistently rejects these calls would leak one DC and one bitmap PER FRAME
// against the process-wide 10,000 GDI handle quota — and would do it invisibly,
// because the capture failure itself is reported while the failed teardown
// never was. Exhausting the quota breaks unrelated GDI calls elsewhere in the
// agent, so the leak has to be visible before it gets there.
func (c *gdiCapturer) releaseHandles() {
	if !c.inited {
		return
	}
	var failed []string
	if c.oldBitmap != 0 && c.memDC != 0 {
		if ret, _, _ := procSelectObject.Call(c.memDC, c.oldBitmap); ret == 0 {
			failed = append(failed, "SelectObject(restore default bitmap)")
		}
	}
	if c.hBitmap != 0 {
		if ret, _, _ := procDeleteObject.Call(c.hBitmap); ret == 0 {
			failed = append(failed, "DeleteObject(capture bitmap)")
		}
	}
	if c.memDC != 0 {
		if ret, _, _ := procDeleteDC.Call(c.memDC); ret == 0 {
			failed = append(failed, "DeleteDC(memory DC)")
		}
	}
	if !c.freeScreenDC(c.screenDC) {
		failed = append(failed, "releasing the display DC")
	}
	if len(failed) > 0 {
		c.recordTeardownFailureLocked(failed)
	}
	c.inited = false
	c.screenDC = 0
	c.screenDCOwned = false
	c.memDC = 0
	c.hBitmap = 0
	c.oldBitmap = 0
	c.ownerThreadID = 0
}

func (c *gdiCapturer) captureOnceLocked() (*image.RGBA, error) {
	err := captureGDIFrame(winGDIFrameOps{}, gdiFrameHandles{
		screenDC:  c.screenDC,
		memDC:     c.memDC,
		hBitmap:   c.hBitmap,
		oldBitmap: c.oldBitmap,
		width:     c.width,
		height:    c.height,
	}, &c.bi, c.pixBuf)
	if err != nil {
		// A selection failure leaves the memory DC holding something other
		// than the capture bitmap; reusing it would blit into the DC's default
		// 1x1 monochrome bitmap and stream black. Drop the handles so the
		// retry in Capture rebuilds them.
		if errors.Is(err, errGDIHandlesUnusable) {
			c.releaseHandles()
		}
		return nil, err
	}

	// Convert BGRA to RGBA into a pooled image
	img := captureImagePool.Get(c.width, c.height)
	bgraToRGBA(c.pixBuf, img.Pix, c.width*c.height)

	return img, nil
}

func (c *gdiCapturer) recordCaptureFailureLocked(err error) {
	c.consecutiveCaptureFailures++
	c.lastCaptureErr = err
	now := time.Now()
	if c.consecutiveCaptureFailures == 1 || now.Sub(c.lastFailureLog) >= 2*time.Second {
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

// recordTeardownFailureLocked reports GDI handles that Win32 refused to free.
// Throttled hard: the interesting signal is "this is happening at all" and then
// the running total, not one line per frame.
func (c *gdiCapturer) recordTeardownFailureLocked(failed []string) {
	c.teardownFailures++
	now := time.Now()
	if c.teardownFailures == 1 || now.Sub(c.lastTeardownLog) >= 30*time.Second {
		slog.Warn("GDI handle teardown failed; handles may be leaking",
			"operations", strings.Join(failed, ", "),
			"totalTeardownFailures", c.teardownFailures)
		c.lastTeardownLog = now
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

// Capture captures the entire screen using persistent GDI handles.
func (c *gdiCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Try once with current handles, then force handle rebuild and retry.
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt == 1 {
			c.releaseHandles()
		}
		if err := c.ensureHandles(); err != nil {
			lastErr = err
			continue
		}
		img, err := c.captureOnceLocked()
		if err == nil {
			c.resetCaptureFailuresLocked()
			return img, nil
		}
		lastErr = err
	}

	// Secure-desktop transitions can invalidate DCs transiently. Treat this as
	// "no frame yet" so the session loop skips without flooding error logs.
	// The startup probe (probeCapture) retries then fails on persistent nil
	// frames — and reads lastCaptureErr back out via LastCaptureError so the
	// technician is told which Win32 call failed and with what code.
	if lastErr != nil {
		c.recordCaptureFailureLocked(lastErr)
	}
	return nil, nil
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

// Close releases persistent GDI handles.
func (c *gdiCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.releaseHandles()
	return nil
}

var _ ScreenCapturer = (*gdiCapturer)(nil)
var _ lastCaptureErrorReporter = (*gdiCapturer)(nil)
