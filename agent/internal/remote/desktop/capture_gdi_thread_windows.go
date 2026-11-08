//go:build windows && !cgo

package desktop

import (
	"fmt"
	"image"
	"log/slog"
	"strings"
	"time"
	"unsafe"
)

// The GDI capturer's thread-owned half: everything in this file runs on the
// capturer's lockedThread (capture_windows_nocgo.go) and nowhere else, which
// is what keeps the desktop attachment, the display DC and the DIB section on
// one OS thread (#8434).

// gdiThreadState is the GDI capturer's per-thread state. Every method runs on
// the capturer's lockedThread and nowhere else.
type gdiThreadState struct {
	// Persistent GDI handles
	screenDC      uintptr
	screenDCOwned bool // true if screenDC was created via CreateDC (must use DeleteDC)
	memDC         uintptr
	section       uintptr // DIB section selected into memDC
	oldBitmap     uintptr // memDC's original bitmap, restored before teardown
	bits          []byte  // the section's pixel memory (top-down BGRA), owned by GDI
	width         int
	height        int
	inited        bool
	ownerThreadID uint32

	// desktop is the HDESK this thread was moved onto, owned by us and closed
	// once the thread has moved off it; 0 while the thread is still on the
	// desktop it started on. originalDesktop is that starting desktop, from
	// GetThreadDesktop — not ours to close.
	desktop         uintptr
	originalDesktop uintptr
	lastAttachLog   time.Time

	// followIssue is why the last followInputDesktop could not tell whether
	// the thread was on the input desktop (OpenInputDesktop failed, or a
	// desktop name was unreadable). Capture goes on with the current desktop
	// in that case, so this is not an error by itself, but when the frame
	// then fails it is the likely cause and is attached to the frame error.
	followIssue        error
	lastFollowIssueLog time.Time

	// Throttling for GDI handles Win32 refused to free. Separate from the
	// capture-failure counters because a leak is a different problem with a
	// different remedy, and it must not be hidden by the capture throttle.
	teardownFailures int
	lastTeardownLog  time.Time
}

// capture grabs one frame. Try once with the current handles, then rebuild
// them and retry.
func (s *gdiThreadState) capture() (*image.RGBA, error) {
	if err := s.followInputDesktop(); err != nil {
		return nil, err
	}
	var errs [2]error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt == 1 {
			s.releaseHandles()
		}
		if err := s.ensureHandles(); err != nil {
			errs[attempt] = err
			continue
		}
		img := captureImagePool.Get(s.width, s.height)
		err := captureGDIFrame(winGDIFrameOps{}, gdiFrameHandles{
			screenDC: s.screenDC,
			memDC:    s.memDC,
			width:    s.width,
			height:   s.height,
		}, s.bits, img.Pix)
		if err == nil {
			return img, nil
		}
		captureImagePool.Put(img)
		errs[attempt] = err
	}
	// The first attempt's error is the one with the original handles and is
	// the one reported (and unwrapped for its Win32 code); the retry's is
	// kept as context rather than replacing it.
	err := errs[0]
	if errs[1] != nil && errs[1].Error() != errs[0].Error() {
		err = fmt.Errorf("%w (retry with rebuilt handles: %v)", errs[0], errs[1])
	}
	if s.followIssue != nil {
		err = fmt.Errorf("%w; capture thread may not be on the input desktop: %v", err, s.followIssue)
	}
	return nil, err
}

// followInputDesktop attaches this thread to the current input desktop when it
// is not already on it. Called before every frame: OpenInputDesktop plus a
// name read costs microseconds against a full-screen BitBlt, and checking
// every frame means the first frame after a Default→Winlogon transition is
// already taken on the right desktop.
//
// A blit from a thread attached to a desktop other than the input desktop
// fails (#9558 logged BitBlt ERROR_INVALID_HANDLE right after a failed
// switch), so a failed attach is returned as the frame's error: it is the
// cause the technician needs, not the BitBlt failure that would follow it.
func (s *gdiThreadState) followInputDesktop() error {
	s.followIssue = nil
	inputDesk, _, openErrno := procOpenInputDesktop.Call(0, 0, uintptr(desktopGenericAll))
	if inputDesk == 0 {
		// No input desktop this process can open (a disconnected session, or
		// mid-transition). Capture whatever this thread is attached to, which
		// is what the capturer always did — but keep the reason, because an
		// access denial here on Winlogon would otherwise surface only as the
		// BitBlt failure it causes.
		s.noteFollowIssue(gdiCallError("OpenInputDesktop", openErrno))
		return nil
	}
	inputName := desktopName(inputDesk)
	tid := currentThreadID()
	current, _, _ := procGetThreadDesktop.Call(uintptr(tid))
	currentName := desktopName(current)
	if inputName == "" {
		procCloseDesktop.Call(inputDesk)
		s.noteFollowIssue(fmt.Errorf("input desktop name is unreadable (GetUserObjectInformationW); thread desktop is %s",
			quoteDesktopName(currentName)))
		return nil
	}
	if strings.EqualFold(inputName, currentName) {
		procCloseDesktop.Call(inputDesk)
		return nil
	}

	// The DC and section were created while attached to the old desktop.
	s.releaseHandles()
	if s.originalDesktop == 0 {
		s.originalDesktop = current
	}
	ret, _, errno := procSetThreadDesktop.Call(inputDesk)
	if ret == 0 {
		procCloseDesktop.Call(inputDesk)
		err := setThreadDesktopError(currentName, inputName, errno)
		s.logAttachFailure(err, currentName, inputName, tid)
		return err
	}
	if s.desktop != 0 {
		// The previous desktop we moved onto is no longer this thread's, so it
		// can be closed now.
		procCloseDesktop.Call(s.desktop)
	}
	s.desktop = inputDesk
	slog.Info("GDI capture thread attached to input desktop",
		"from", currentName, "to", inputName, "thread", tid)
	return nil
}

// noteFollowIssue records why the input desktop could not be checked and logs
// it, throttled, with its Win32 code.
func (s *gdiThreadState) noteFollowIssue(err error) {
	s.followIssue = err
	now := time.Now()
	if now.Sub(s.lastFollowIssueLog) < 5*time.Second {
		return
	}
	s.lastFollowIssueLog = now
	attrs := []any{"error", err.Error()}
	if code, ok := win32ErrorCode(err); ok {
		attrs = append(attrs, "win32Error", code)
	}
	slog.Warn("GDI capture thread could not check the input desktop; capturing on its current desktop", attrs...)
}

func (s *gdiThreadState) logAttachFailure(err error, from, to string, tid uint32) {
	now := time.Now()
	if now.Sub(s.lastAttachLog) < 2*time.Second {
		return
	}
	s.lastAttachLog = now
	attrs := []any{"from", from, "to", to, "thread", tid, "error", err.Error()}
	if code, ok := win32ErrorCode(err); ok {
		attrs = append(attrs, "win32Error", code)
	}
	slog.Warn("GDI capture thread could not attach to the input desktop", attrs...)
}

// ensureHandles creates or recreates the display DC, memory DC and DIB section
// if needed.
func (s *gdiThreadState) ensureHandles() error {
	w, _, _ := procGetSystemMetrics.Call(smCxScreen)
	h, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if w == 0 || h == 0 {
		return fmt.Errorf("GetSystemMetrics returned zero dimensions")
	}
	// Round to even dimensions so the section, BitBlt, and frame all agree
	// with the downstream H264 encoder's required even alignment. On displays
	// with odd pixel dimensions (e.g. 1512x949 from a physical panel at 125%
	// scaling) the unrounded capture buffer produces a one-row mismatch
	// against the encoder's SetDimensions `h &^ 1` and every frame fails to
	// encode with "frame size 1434888 doesn't match 1512x948".
	width, height := AlignEven(int(w), int(h))

	// The thread check can no longer fire — the capturer owns its thread — but
	// it costs nothing and keeps a regression to cross-thread handle use from
	// being silent.
	tid := currentThreadID()
	if !shouldRebuildGDIHandles(s.inited, s.width, s.height, width, height, s.ownerThreadID, tid) {
		return nil
	}
	s.releaseHandles()

	_, size, err := dibSectionLayout(width, height)
	if err != nil {
		return err
	}

	// Use CreateDC("DISPLAY") instead of GetDC(0). GetDC(0) returns a DC
	// for the desktop window which fails on the Winlogon (secure) desktop.
	// CreateDC("DISPLAY") creates a DC for the physical display directly.
	hdc, _, createDCErrno := procCreateDCW.Call(
		uintptr(unsafe.Pointer(displayDeviceName)),
		0, 0, 0,
	)
	screenDCOwned := true
	if hdc == 0 {
		// Fall back to GetDC(0) if CreateDC fails
		var getDCErrno error
		hdc, _, getDCErrno = procGetDC.Call(0)
		if hdc == 0 {
			return fmt.Errorf("no display DC available: %w; %w",
				gdiCallError("CreateDC(DISPLAY)", createDCErrno),
				gdiCallError("GetDC(0)", getDCErrno))
		}
		screenDCOwned = false
		slog.Debug("CreateDC(DISPLAY) failed; using GetDC(0)",
			"error", gdiCallError("CreateDC(DISPLAY)", createDCErrno).Error())
	}
	freeScreenDC := func() { releaseScreenDC(hdc, screenDCOwned) }

	memDC, _, memDCErrno := procCreateCompatibleDC.Call(hdc)
	if memDC == 0 {
		err := gdiCallError("CreateCompatibleDC", memDCErrno)
		freeScreenDC()
		return err
	}

	// The capture target is a top-down 32bpp DIB section, not a
	// CreateCompatibleBitmap DDB: its pixels are in memory this process reads
	// directly, so no GetDIBits readback is needed (#8434, capture_gdi.go).
	bi := newCaptureBitmapInfo(width, height)
	var bits unsafe.Pointer
	section, _, sectionErrno := procCreateDIBSection.Call(
		hdc,
		uintptr(unsafe.Pointer(&bi)),
		dibRGBColors,
		uintptr(unsafe.Pointer(&bits)),
		0, // hSection: let GDI allocate the memory
		0, // offset
	)
	if section == 0 || bits == nil {
		err := gdiCallError("CreateDIBSection", sectionErrno)
		if section != 0 {
			procDeleteObject.Call(section)
		}
		procDeleteDC.Call(memDC)
		freeScreenDC()
		return err
	}

	oldBitmap, _, selectErrno := procSelectObject.Call(memDC, section)
	if oldBitmap == 0 {
		err := gdiCallError("SelectObject", selectErrno)
		procDeleteObject.Call(section)
		procDeleteDC.Call(memDC)
		freeScreenDC()
		return err
	}

	s.screenDC = hdc
	s.screenDCOwned = screenDCOwned
	s.memDC = memDC
	s.section = section
	s.oldBitmap = oldBitmap
	s.bits = unsafe.Slice((*byte)(bits), size)
	s.width = width
	s.height = height
	s.ownerThreadID = tid
	s.inited = true
	return nil
}

// releaseScreenDC releases a display DC through whichever entry point created
// it, and reports whether Win32 accepted the release.
func releaseScreenDC(hdc uintptr, owned bool) bool {
	if hdc == 0 {
		return true
	}
	var ret uintptr
	if owned {
		ret, _, _ = procDeleteDC.Call(hdc) // CreateDC → DeleteDC
	} else {
		ret, _, _ = procReleaseDC.Call(0, hdc) // GetDC → ReleaseDC
	}
	return ret != 0
}

// releaseHandles frees all persistent GDI handles.
//
// Teardown results are checked rather than discarded: handles are rebuilt on
// a resolution change, a desktop switch and after a failed frame, so a driver
// that persistently rejects these calls would leak a DC and a section per
// rebuild against the process-wide 10,000 GDI handle quota — invisibly,
// because the capture failure is reported while a failed teardown never was.
func (s *gdiThreadState) releaseHandles() {
	if !s.inited {
		return
	}
	var failed []string
	if s.oldBitmap != 0 && s.memDC != 0 {
		if ret, _, _ := procSelectObject.Call(s.memDC, s.oldBitmap); ret == 0 {
			failed = append(failed, "SelectObject(restore default bitmap)")
		}
	}
	if s.section != 0 {
		if ret, _, _ := procDeleteObject.Call(s.section); ret == 0 {
			failed = append(failed, "DeleteObject(capture DIB section)")
		}
	}
	if s.memDC != 0 {
		if ret, _, _ := procDeleteDC.Call(s.memDC); ret == 0 {
			failed = append(failed, "DeleteDC(memory DC)")
		}
	}
	if !releaseScreenDC(s.screenDC, s.screenDCOwned) {
		failed = append(failed, "releasing the display DC")
	}
	if len(failed) > 0 {
		s.recordTeardownFailure(failed)
	}
	s.inited = false
	s.screenDC = 0
	s.screenDCOwned = false
	s.memDC = 0
	s.section = 0
	s.oldBitmap = 0
	s.bits = nil
	s.ownerThreadID = 0
}

// recordTeardownFailure reports GDI handles that Win32 refused to free.
// Throttled hard: the interesting signal is "this is happening at all" and then
// the running total, not one line per frame.
func (s *gdiThreadState) recordTeardownFailure(failed []string) {
	s.teardownFailures++
	now := time.Now()
	if s.teardownFailures == 1 || now.Sub(s.lastTeardownLog) >= 30*time.Second {
		slog.Warn("GDI handle teardown failed; handles may be leaking",
			"operations", strings.Join(failed, ", "),
			"totalTeardownFailures", s.teardownFailures)
		s.lastTeardownLog = now
	}
}

// shutdown runs on the capture thread as it exits: it frees the GDI handles,
// then moves the thread back to its starting desktop so the desktop handle we
// opened is no longer in use and can be closed. CloseDesktop refuses a handle
// that any thread in the process is still using, and the handle is
// process-wide, so skipping the move back would leak one HDESK per capturer.
func (s *gdiThreadState) shutdown() {
	s.releaseHandles()
	if s.desktop == 0 {
		return
	}
	if s.originalDesktop == 0 {
		// Cannot happen while followInputDesktop is the only writer of
		// s.desktop, but the leak is worth naming if that ever changes.
		slog.Warn("GDI capture thread has no starting desktop to return to; one desktop handle is leaked",
			"desktop", desktopName(s.desktop))
		return
	}
	ret, _, errno := procSetThreadDesktop.Call(s.originalDesktop)
	if ret != 0 {
		procCloseDesktop.Call(s.desktop)
		s.desktop = 0
		return
	}
	err := setThreadDesktopError(desktopName(s.desktop), desktopName(s.originalDesktop), errno)
	attrs := []any{"error", err.Error()}
	if code, ok := win32ErrorCode(err); ok {
		attrs = append(attrs, "win32Error", code)
	}
	slog.Warn("GDI capture thread could not leave its input desktop; one desktop handle is leaked", attrs...)
}
