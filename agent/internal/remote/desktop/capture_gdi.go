package desktop

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

// Windows GDI screen-capture support that does not itself call Win32.
//
// No build tag, on purpose — the same reason capture_errors.go carries none.
// The GDI capturer is `//go:build windows && !cgo` (capture_windows_nocgo.go),
// the Test Agent CI job runs on ubuntu-latest, and remote/desktop is one of the
// packages explicitly EXCLUDED from the Test Agent (Windows) job's package list
// (ci.yml, inherited red tracked in #2523). A test placed beside the capturer
// would therefore execute on no platform at all and pass vacuously.
//
// Everything here is pure Go over plain structs and error values, so it
// compiles and is exercised on the Linux runner, while capture_windows_nocgo.go
// keeps only the syscalls themselves.

// Win32 GDI constants used by the capture path.
const (
	srcCopy      = 0x00CC0020
	captureBlt   = 0x40000000
	biRGB        = 0
	dibRGBColors = 0
)

// bitmapInfoHeaderSize is the BITMAPINFOHEADER size Win32 requires in BiSize.
// GetDIBits and CreateDIBSection both reject a header whose BiSize does not
// match a structure they recognise, so this is a hard ABI constant, not a
// convenience: if bitmapInfoHeader ever gains, loses or reorders a field, the
// Win32 call starts failing at runtime on Windows only. Asserted in
// capture_gdi_test.go so the break surfaces on the Linux runner instead.
const bitmapInfoHeaderSize = 40

type bitmapInfoHeader struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type bitmapInfo struct {
	BmiHeader bitmapInfoHeader
	BmiColors [1]uint32
}

// newCaptureBitmapInfo builds the BITMAPINFO the capture path hands to Win32.
//
// A NEGATIVE BiHeight is what requests a top-down DIB, so row 0 of the buffer
// is the top row of the screen. With a positive height Win32 writes the rows
// bottom-up and every captured frame arrives vertically mirrored.
//
// 32bpp BI_RGB means uncompressed BGRA, which is what bgraToRGBA expects, and
// it means the colour table (BmiColors) is unused — for BI_RGB at 32bpp Win32
// reads no palette entries, so leaving it zero is correct rather than merely
// tolerated.
func newCaptureBitmapInfo(width, height int) bitmapInfo {
	return bitmapInfo{
		BmiHeader: bitmapInfoHeader{
			BiSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
			BiWidth:       int32(width),
			BiHeight:      -int32(height), // negative = top-down
			BiPlanes:      1,
			BiBitCount:    32,
			BiCompression: biRGB,
		},
	}
}

// gdiCallError turns a failed GDI call into an error that carries the Win32
// error code, and unwraps to the syscall.Errno so callers can match on it.
//
// Why this exists (#5284): every GDI call on the capture path used the
// `ret, _, _ :=` form, discarding the errno. The Winlogon-desktop failure that
// took remote desktop to 0 FPS at the logged-out console was therefore reported
// to the technician as the bare string "GetDIBits failed" — no code, nothing to
// look up, and no way to tell an access denial from an invalid parameter. This
// path cannot be reproduced off a live secure desktop, so the error text IS the
// diagnostic channel.
//
// The message reports what was OBSERVED and names no single cause, per the
// convention capture_errors.go establishes.
//
// A zero errno is reported distinctly rather than as "error 0". Not every GDI
// entry point sets extended error information on failure — BitBlt documents
// that it does, GetDIBits does not guarantee it — so "the call failed and Win32
// recorded no reason" is a real observation, distinct from "failed with code N",
// and rendering it as code 0 would send the reader to look up ERROR_SUCCESS.
//
// The zero is trustworthy rather than stale: Go's Windows syscall trampoline
// clears the thread's last-error before the native call and reads it back
// afterwards, so an explicit SetLastError(0) here would be redundant.
func gdiCallError(op string, errno error) error {
	var e syscall.Errno
	if errors.As(errno, &e) {
		if e == 0 {
			return fmt.Errorf("%s failed (Win32 recorded no error code)", op)
		}
		return fmt.Errorf("%s failed: Win32 error %d (0x%X): %w", op, uint32(e), uint32(e), e)
	}
	if errno == nil {
		return fmt.Errorf("%s failed (Win32 recorded no error code)", op)
	}
	return fmt.Errorf("%s failed: %w", op, errno)
}

// shouldRebuildGDIHandles decides whether the cached GDI handles must be torn
// down and recreated before the next frame.
//
// The thread check is the part that is easy to miss (#5284). GDI handles were
// created lazily by whichever OS thread first drove a capture, and on a session
// that starts on a secure desktop that thread is the STARTUP PROBE's thread:
// StartSession calls newProbeRepainter, which does LockOSThread +
// SetThreadDesktop, and then releases the pin the moment the probe returns
// (session_webrtc.go, desktop_repaint_windows.go). The streaming loop then runs
// on a DIFFERENT goroutine that pins and attaches ITS OWN thread
// (prepareCaptureThread, called from captureLoop) — so every frame after the
// probe used a display DC and bitmap created against a thread, and a desktop
// attachment, that no longer exist. Rebuilding when the owning thread changes
// keeps handle creation and handle use on the same attached thread.
//
// Passing 0 for both thread ids disables the thread check, which is what
// non-Windows builds and tests that only care about the resolution rule do.
func shouldRebuildGDIHandles(inited bool, haveWidth, haveHeight, wantWidth, wantHeight int, ownerThread, currentThread uint32) bool {
	if !inited {
		return true
	}
	if haveWidth != wantWidth || haveHeight != wantHeight {
		return true
	}
	if ownerThread != 0 && currentThread != 0 && ownerThread != currentThread {
		return true
	}
	return false
}

// dibSectionLayout returns the row stride and total byte size of the 32bpp
// top-down DIB section the GDI capturer blits into.
//
// At 32bpp every row is already a whole number of DWORDs, so the stride is
// exactly width*4 with no padding; that is what lets the section's memory be
// handed to bgraToRGBA as one contiguous BGRA buffer. The size is refused when
// it does not fit an int32: BITMAPINFOHEADER.biSizeImage is a DWORD and GDI
// caps a DIB well below that, and the Go slice laid over the section's memory
// is built from this number, so a wrapped value would mean reading past the
// end of the mapping rather than an error.
func dibSectionLayout(width, height int) (stride, size int, err error) {
	if width <= 0 || height <= 0 {
		return 0, 0, fmt.Errorf("invalid capture dimensions %dx%d", width, height)
	}
	const maxDIBBytes = 1<<31 - 1
	stride = width * 4
	if height > maxDIBBytes/stride {
		return 0, 0, fmt.Errorf("capture dimensions %dx%d exceed the largest DIB section GDI supports", width, height)
	}
	return stride, stride * height, nil
}

// gdiFrameOps is the set of Win32 calls one GDI frame makes. The Windows build
// supplies a syscall-backed implementation (capture_windows_nocgo.go); tests
// supply a fake.
type gdiFrameOps interface {
	// BitBlt reports whether the blit succeeded.
	BitBlt(dstDC uintptr, width, height int, srcDC uintptr, rop uint32) (ok bool, errno error)
	// GdiFlush flushes the calling thread's GDI batch and reports whether
	// every batched call succeeded.
	GdiFlush() (ok bool, errno error)
}

// gdiFrameHandles is the handle set one frame operates on. memDC has the
// capture DIB section selected into it for the handle set's whole lifetime.
type gdiFrameHandles struct {
	screenDC uintptr
	memDC    uintptr
	width    int
	height   int
}

// captureGDIFrame performs one GDI screen grab: it blits the display into the
// DIB section selected into h.memDC, flushes, and converts the section's
// memory (BGRA) into dst (RGBA).
//
// Why a DIB section and no GetDIBits (#8434): the capturer used to blit into a
// device-dependent bitmap from CreateCompatibleBitmap and read it back with
// GetDIBits. On the Winlogon desktop of a logged-out console BitBlt succeeded
// and GetDIBits then copied zero scan lines while recording no Win32 error,
// every frame, on Windows 10, 11 and Server 2022 alike. A DIB section's pixels
// live in memory this process maps and reads directly, so once the blit has
// landed there is no second GDI call, and no device-format conversion, left
// to fail.
//
// GdiFlush is required, not belt-and-braces: GDI batches drawing calls per
// thread, and the documented rule for DIB sections is to flush before the
// application touches the bits, or it may read the previous frame.
func captureGDIFrame(ops gdiFrameOps, h gdiFrameHandles, section, dst []byte) error {
	// Bounds-check before any Win32 call: section is a slice laid over GDI's
	// memory and dst comes from the image pool, and bgraToRGBA indexes both
	// by width*height*4 with no idea how long either really is.
	need := h.width * h.height * 4
	if h.width <= 0 || h.height <= 0 || len(section) < need || len(dst) < need {
		return fmt.Errorf("capture buffers are %d (section) and %d (frame) bytes, need %d for %dx%d",
			len(section), len(dst), need, h.width, h.height)
	}

	// The errno of the CAPTUREBLT attempt is deliberately dropped: a driver
	// that refuses CAPTUREBLT is an expected secure-desktop condition, and the
	// errno that matters is the one from the plain-SRCCOPY retry below.
	ok, _ := ops.BitBlt(h.memDC, h.width, h.height, h.screenDC, srcCopy|captureBlt)
	if !ok {
		var errno error
		ok, errno = ops.BitBlt(h.memDC, h.width, h.height, h.screenDC, srcCopy)
		if !ok {
			return gdiCallError("BitBlt", errno)
		}
	}

	if ok, errno := ops.GdiFlush(); !ok {
		return gdiCallError("GdiFlush", errno)
	}

	bgraToRGBA(section, dst, h.width*h.height)
	return nil
}

// win32ErrorCode extracts the numeric Win32 error from an error produced by
// gdiCallError, so a log line can carry it as a structured field rather than
// only inside a message string. Returns false when no code is present.
func win32ErrorCode(err error) (uint32, bool) {
	var e syscall.Errno
	if errors.As(err, &e) && e != 0 {
		return uint32(e), true
	}
	return 0, false
}
