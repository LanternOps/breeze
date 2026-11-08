package desktop

import (
	"bytes"
	"errors"
	"strings"
	"syscall"
	"testing"
)

// No build tag — see capture_gdi.go. These assert the GDI frame sequence on the
// Linux runner, because the real capturer is `windows && !cgo` and
// remote/desktop is excluded from the Test Agent (Windows) job.
//
// #8434: the frame used to be read back with GetDIBits from a device-dependent
// bitmap (CreateCompatibleBitmap). On the Winlogon desktop BitBlt succeeded
// but GetDIBits copied zero scan lines and set no Win32 error, every frame.
// The capture target is now a DIB section, whose pixels live in memory the
// process reads directly; there is no readback call left to fail. The fake
// below models the one rule that replaces it: GDI may batch the blit, so the
// pixels are only guaranteed to be in the section after GdiFlush.

type fakeGDI struct {
	calls []string

	// section is the DIB section memory the fake "draws" into.
	section []byte
	// pattern is what a successful blit paints (BGRA). Staged on BitBlt and
	// only committed to section by GdiFlush, to model GDI batching.
	pattern []byte
	staged  bool

	bitBltFailCaptureBlt bool // fail only the CAPTUREBLT attempt
	bitBltFailAlways     bool
	bitBltErrno          syscall.Errno
	flushFails           bool
	flushErrno           syscall.Errno
}

func (f *fakeGDI) BitBlt(dstDC uintptr, width, height int, srcDC uintptr, rop uint32) (bool, error) {
	f.calls = append(f.calls, "BitBlt")
	if f.bitBltFailAlways {
		code := f.bitBltErrno
		if code == 0 {
			code = 6 // ERROR_INVALID_HANDLE, what #9558 logged
		}
		return false, code
	}
	if f.bitBltFailCaptureBlt && rop&captureBlt != 0 {
		return false, syscall.Errno(87) // ERROR_INVALID_PARAMETER
	}
	f.staged = true
	return true, syscall.Errno(0)
}

func (f *fakeGDI) GdiFlush() (bool, error) {
	f.calls = append(f.calls, "GdiFlush")
	if f.flushFails {
		return false, f.flushErrno
	}
	if f.staged {
		copy(f.section, f.pattern)
		f.staged = false
	}
	return true, syscall.Errno(0)
}

const testW, testH = 4, 3

func testHandles() gdiFrameHandles {
	return gdiFrameHandles{screenDC: 0x100, memDC: 0x200, width: testW, height: testH}
}

// bgraPattern returns a distinct BGRA value per pixel so a conversion that
// reads the wrong bytes, or none, cannot match by accident.
func bgraPattern(w, h int) []byte {
	p := make([]byte, w*h*4)
	for i := 0; i < w*h; i++ {
		p[i*4+0] = byte(10 + i) // B
		p[i*4+1] = byte(100 + i)
		p[i*4+2] = byte(200 + i) // R
		p[i*4+3] = 0             // GDI leaves alpha 0 in a 32bpp DIB
	}
	return p
}

func newFakeGDI() *fakeGDI {
	return &fakeGDI{
		section: make([]byte, testW*testH*4),
		pattern: bgraPattern(testW, testH),
	}
}

// The #8434 regression: the frame is the DIB section's own memory, converted to
// RGBA, and the only Win32 calls on the frame path are the blit and the flush.
func TestCaptureGDIFrameReadsDIBSectionAfterBlit(t *testing.T) {
	f := newFakeGDI()
	dst := make([]byte, testW*testH*4)

	if err := captureGDIFrame(f, testHandles(), f.section, dst); err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	if got, want := strings.Join(f.calls, ","), "BitBlt,GdiFlush"; got != want {
		t.Fatalf("call sequence = %s, want %s", got, want)
	}
	want := make([]byte, len(dst))
	bgraToRGBA(f.pattern, want, testW*testH)
	if !bytes.Equal(dst, want) {
		t.Fatalf("frame is not the blitted pixels converted to RGBA:\n got %v\nwant %v", dst, want)
	}
	for i := 3; i < len(dst); i += 4 {
		if dst[i] != 255 {
			t.Fatalf("pixel %d alpha = %d, want 255 (GDI leaves 0 in the section)", i/4, dst[i])
		}
	}
}

// GDI batches drawing calls per thread; reading the section before GdiFlush
// can see the previous frame or nothing. The fake only commits the blit on
// flush, so skipping the flush would leave dst all-zero RGB.
func TestCaptureGDIFrameFlushesBeforeReading(t *testing.T) {
	f := newFakeGDI()
	dst := make([]byte, testW*testH*4)
	if err := captureGDIFrame(f, testHandles(), f.section, dst); err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	if dst[0] == 0 && dst[1] == 0 && dst[2] == 0 {
		t.Fatal("frame was read before the blit was flushed into the DIB section")
	}
}

func TestCaptureGDIFrameRetriesWithoutCaptureBlt(t *testing.T) {
	f := newFakeGDI()
	f.bitBltFailCaptureBlt = true
	if err := captureGDIFrame(f, testHandles(), f.section, make([]byte, testW*testH*4)); err != nil {
		t.Fatalf("CAPTUREBLT rejection must fall back to plain SRCCOPY, got %v", err)
	}
	if n := countCalls(f.calls, "BitBlt"); n != 2 {
		t.Errorf("expected 2 BitBlt attempts, got %d", n)
	}
}

func TestCaptureGDIFrameReportsBitBltErrno(t *testing.T) {
	f := newFakeGDI()
	f.bitBltFailAlways = true
	dst := make([]byte, testW*testH*4)

	err := captureGDIFrame(f, testHandles(), f.section, dst)
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "BitBlt failed") {
		t.Errorf("BitBlt failure must name the call, got %q", err)
	}
	// Exact match, not strings.Contains: "6" is a substring of many codes.
	if code, ok := win32ErrorCode(err); !ok || code != 6 {
		t.Errorf("BitBlt failure must carry Win32 code 6, got %d (present=%v) in %q", code, ok, err)
	}
	if countCalls(f.calls, "GdiFlush") != 0 {
		t.Error("a failed blit must not go on to flush and read the section")
	}
	if !bytes.Equal(dst, make([]byte, len(dst))) {
		t.Error("a failed blit must leave the destination untouched")
	}
}

func TestCaptureGDIFrameReportsFlushFailure(t *testing.T) {
	f := newFakeGDI()
	f.flushFails = true
	f.flushErrno = syscall.Errno(8) // ERROR_NOT_ENOUGH_MEMORY
	dst := make([]byte, testW*testH*4)

	err := captureGDIFrame(f, testHandles(), f.section, dst)
	if err == nil {
		t.Fatal("a failed GdiFlush means the batched blit failed; the frame must fail")
	}
	if !strings.Contains(err.Error(), "GdiFlush failed") {
		t.Errorf("flush failure must name the call, got %q", err)
	}
	if code, ok := win32ErrorCode(err); !ok || code != 8 {
		t.Errorf("flush failure must carry Win32 code 8, got %d (present=%v)", code, ok)
	}
	if !bytes.Equal(dst, make([]byte, len(dst))) {
		t.Error("a failed flush must leave the destination untouched")
	}
}

func countCalls(calls []string, name string) int {
	n := 0
	for _, c := range calls {
		if c == name {
			n++
		}
	}
	return n
}

// The section slice is built over Win32 memory from a size this package
// computed, and dst comes from the image pool. Either one being short would be
// an out-of-range read or write, so both are checked before any Win32 call.
func TestCaptureGDIFrameRejectsUndersizedBuffers(t *testing.T) {
	full := testW * testH * 4
	h := testHandles()

	for _, tc := range []struct {
		name    string
		section []byte
		dst     []byte
		h       gdiFrameHandles
	}{
		{"empty section", nil, make([]byte, full), h},
		{"section one byte short", make([]byte, full-1), make([]byte, full), h},
		{"empty destination", make([]byte, full), nil, h},
		{"destination one byte short", make([]byte, full), make([]byte, full-1), h},
		{"zero width", make([]byte, full), make([]byte, full), gdiFrameHandles{screenDC: h.screenDC, memDC: h.memDC, width: 0, height: testH}},
		{"negative height", make([]byte, full), make([]byte, full), gdiFrameHandles{screenDC: h.screenDC, memDC: h.memDC, width: testW, height: -1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeGDI()
			if err := captureGDIFrame(f, tc.h, tc.section, tc.dst); err == nil {
				t.Fatal("expected the frame to be rejected")
			}
			if len(f.calls) != 0 {
				t.Errorf("no Win32 call may run with a bad buffer, got %v", f.calls)
			}
		})
	}

	// Oversized buffers are fine: the image pool may hand back a larger Pix.
	f := newFakeGDI()
	big := make([]byte, full*2)
	copy(big, f.section)
	f.section = big
	if err := captureGDIFrame(f, h, f.section, make([]byte, full*2)); err != nil {
		t.Errorf("oversized buffers must be accepted, got %v", err)
	}
}

func TestDIBSectionLayout(t *testing.T) {
	for _, tc := range []struct {
		name         string
		w, h         int
		stride, size int
	}{
		{"1080p", 1920, 1080, 7680, 7680 * 1080},
		{"4K", 3840, 2160, 15360, 15360 * 2160},
		// 32bpp rows are always DWORD-aligned, so an odd width needs no padding.
		{"odd width", 1513, 949, 1513 * 4, 1513 * 4 * 949},
		{"one pixel", 1, 1, 4, 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stride, size, err := dibSectionLayout(tc.w, tc.h)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if stride != tc.stride || size != tc.size {
				t.Fatalf("layout = (%d, %d), want (%d, %d)", stride, size, tc.stride, tc.size)
			}
			if stride%4 != 0 {
				t.Fatalf("stride %d is not DWORD-aligned", stride)
			}
		})
	}

	for _, tc := range []struct {
		name string
		w, h int
	}{
		{"zero width", 0, 1080},
		{"zero height", 1920, 0},
		{"negative width", -1920, 1080},
		{"negative height", 1920, -1080},
		// BITMAPINFOHEADER.biSizeImage is a DWORD and GDI caps a DIB well
		// below that; a size that does not fit int32 must be refused rather
		// than truncated into a short allocation.
		{"exceeds int32", 1 << 16, 1 << 16},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := dibSectionLayout(tc.w, tc.h); err == nil {
				t.Fatalf("dibSectionLayout(%d, %d) must be rejected", tc.w, tc.h)
			}
		})
	}
}

// errors.Is must keep working through the frame error so callers can match on
// the Win32 code.
func TestCaptureGDIFrameErrorsUnwrapToErrno(t *testing.T) {
	f := newFakeGDI()
	f.bitBltFailAlways = true
	f.bitBltErrno = syscall.Errno(5)
	err := captureGDIFrame(f, testHandles(), f.section, make([]byte, testW*testH*4))
	if !errors.Is(err, syscall.Errno(5)) {
		t.Fatalf("errors.Is(err, Errno(5)) = false for %v", err)
	}
}
