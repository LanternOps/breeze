package desktop

import (
	"errors"
	"strings"
	"syscall"
	"testing"
)

// No build tag — see capture_gdi.go. These assert the Win32 contract that
// #5284 violated, on the Linux runner, because the real capturer is
// `windows && !cgo` and remote/desktop is excluded from the Windows CI job.

// fakeGDI models the parts of Win32 the frame sequence depends on, including
// the rule the bug broke: GetDIBits requires that the bitmap NOT be selected
// into a device context. MSDN, GetDIBits Remarks:
//
//	"The bitmap identified by the hbmp parameter must not be selected into a
//	 device context when the application calls this function."
//
// The rule is categorical — it is not "not selected into the DC you pass".
// So the fake tracks selection across ALL DCs and fails GetDIBits whenever the
// target bitmap is selected anywhere, which is precisely how a driver is
// entitled to behave and how the reporter's Intel UHD 630 apparently did.
type fakeGDI struct {
	// selected maps a DC to the bitmap currently selected into it.
	selected map[uintptr]uintptr

	calls []string

	// injected failures
	bitBltFailCaptureBlt bool // fail only the CAPTUREBLT attempt
	bitBltFailAlways     bool
	getDIBitsErrno       syscall.Errno
	getDIBitsPartial     bool // copy fewer scan lines than asked
	failSelectTo         uintptr
	selectErrno          syscall.Errno

	dibHDC uintptr // the DC actually handed to GetDIBits
}

func newFakeGDI(h gdiFrameHandles) *fakeGDI {
	return &fakeGDI{
		selected: map[uintptr]uintptr{h.memDC: h.hBitmap},
	}
}

func (f *fakeGDI) SelectObject(hdc, hgdiobj uintptr) (uintptr, error) {
	f.calls = append(f.calls, "SelectObject")
	if f.failSelectTo != 0 && hgdiobj == f.failSelectTo {
		return 0, f.selectErrno
	}
	prev := f.selected[hdc]
	f.selected[hdc] = hgdiobj
	if prev == 0 {
		// A real memory DC always has something selected, so a non-zero
		// previous object is what Win32 returns on success.
		prev = 0xDEAD
	}
	return prev, syscall.Errno(0)
}

func (f *fakeGDI) BitBlt(dstDC uintptr, width, height int, srcDC uintptr, rop uint32) (bool, error) {
	f.calls = append(f.calls, "BitBlt")
	if f.bitBltFailAlways {
		return false, syscall.Errno(6) // ERROR_INVALID_HANDLE
	}
	if f.bitBltFailCaptureBlt && rop&captureBlt != 0 {
		return false, syscall.Errno(87) // ERROR_INVALID_PARAMETER
	}
	return true, syscall.Errno(0)
}

func (f *fakeGDI) GetDIBits(hdc, hbm uintptr, lines int, bits *byte, bi *bitmapInfo) (int, error) {
	f.calls = append(f.calls, "GetDIBits")
	f.dibHDC = hdc

	// The contract. Any DC holding this bitmap makes the call illegal.
	for dc, sel := range f.selected {
		if sel == hbm {
			_ = dc
			return 0, syscall.Errno(87) // ERROR_INVALID_PARAMETER
		}
	}
	if f.getDIBitsErrno != 0 {
		return 0, f.getDIBitsErrno
	}
	if f.getDIBitsPartial {
		return lines - 1, syscall.Errno(0)
	}
	return lines, syscall.Errno(0)
}

func testHandles() gdiFrameHandles {
	return gdiFrameHandles{
		screenDC:  0x100,
		memDC:     0x200,
		hBitmap:   0x300,
		oldBitmap: 0x301,
		width:     4,
		height:    3,
	}
}

// The regression test for #5284. Against the shipped sequence — which selects
// the bitmap into memDC once and never deselects it — this fails, because the
// bitmap is still selected when GetDIBits runs.
func TestCaptureGDIFrameDeselectsBitmapBeforeReadback(t *testing.T) {
	h := testHandles()
	f := newFakeGDI(h)
	bi := newCaptureBitmapInfo(h.width, h.height)
	dst := make([]byte, h.width*h.height*4)

	if err := captureGDIFrame(f, h, &bi, dst); err != nil {
		t.Fatalf("capture failed: %v", err)
	}

	// The DC handed to GetDIBits must not be the one the bitmap lives in.
	if f.dibHDC == h.memDC {
		t.Errorf("GetDIBits was passed memDC (0x%X), the DC the capture bitmap is selected into", f.dibHDC)
	}
	if f.dibHDC != h.screenDC {
		t.Errorf("GetDIBits hdc = 0x%X, want screenDC 0x%X", f.dibHDC, h.screenDC)
	}
	// And the bitmap must be back in the memory DC afterwards, or the next
	// frame's BitBlt draws into the DC's default 1x1 monochrome bitmap.
	if got := f.selected[h.memDC]; got != h.hBitmap {
		t.Errorf("after the frame, memDC holds 0x%X, want the capture bitmap 0x%X", got, h.hBitmap)
	}
}

// Ordering, stated independently of the assertions above: the deselect must
// happen before the readback and the reselect after it.
func TestCaptureGDIFrameCallOrder(t *testing.T) {
	h := testHandles()
	f := newFakeGDI(h)
	bi := newCaptureBitmapInfo(h.width, h.height)

	if err := captureGDIFrame(f, h, &bi, make([]byte, h.width*h.height*4)); err != nil {
		t.Fatalf("capture failed: %v", err)
	}

	want := []string{"BitBlt", "SelectObject", "GetDIBits", "SelectObject"}
	if strings.Join(f.calls, ",") != strings.Join(want, ",") {
		t.Fatalf("call order = %v, want %v", f.calls, want)
	}
}

// If the reselect fails, the frame must fail too — even though the pixels were
// read successfully — and the caller must be told the handles are unusable.
// Returning the good frame here would leave the memory DC pointing at its
// default 1x1 bitmap and stream black frames for the rest of the session.
func TestCaptureGDIFrameFailsWhenReselectFails(t *testing.T) {
	h := testHandles()
	f := newFakeGDI(h)
	f.failSelectTo = h.hBitmap // the reselect, not the deselect
	f.selectErrno = syscall.Errno(6)
	bi := newCaptureBitmapInfo(h.width, h.height)

	err := captureGDIFrame(f, h, &bi, make([]byte, h.width*h.height*4))
	if err == nil {
		t.Fatal("a failed reselect must fail the frame, got nil error")
	}
	if !errors.Is(err, errGDIHandlesUnusable) {
		t.Errorf("error must mark the handles unusable so the caller rebuilds, got %v", err)
	}
	if !errors.Is(err, syscall.Errno(6)) {
		t.Errorf("error must carry the Win32 code, got %v", err)
	}
}

// A failed deselect must abort BEFORE GetDIBits — calling it anyway is the
// exact contract violation being fixed.
func TestCaptureGDIFrameSkipsReadbackWhenDeselectFails(t *testing.T) {
	h := testHandles()
	f := newFakeGDI(h)
	f.failSelectTo = h.oldBitmap // the deselect
	f.selectErrno = syscall.Errno(5)
	bi := newCaptureBitmapInfo(h.width, h.height)

	err := captureGDIFrame(f, h, &bi, make([]byte, h.width*h.height*4))
	if err == nil {
		t.Fatal("a failed deselect must fail the frame")
	}
	for _, c := range f.calls {
		if c == "GetDIBits" {
			t.Fatal("GetDIBits ran with the bitmap still selected — the #5284 contract violation")
		}
	}
	if !errors.Is(err, errGDIHandlesUnusable) {
		t.Errorf("error must mark the handles unusable, got %v", err)
	}
}

func TestCaptureGDIFrameRetriesWithoutCaptureBlt(t *testing.T) {
	h := testHandles()
	f := newFakeGDI(h)
	f.bitBltFailCaptureBlt = true
	bi := newCaptureBitmapInfo(h.width, h.height)

	if err := captureGDIFrame(f, h, &bi, make([]byte, h.width*h.height*4)); err != nil {
		t.Fatalf("CAPTUREBLT rejection must fall back to plain SRCCOPY, got %v", err)
	}
	if n := countCalls(f.calls, "BitBlt"); n != 2 {
		t.Errorf("expected 2 BitBlt attempts, got %d", n)
	}
}

func TestCaptureGDIFrameReportsBitBltErrno(t *testing.T) {
	h := testHandles()
	f := newFakeGDI(h)
	f.bitBltFailAlways = true
	bi := newCaptureBitmapInfo(h.width, h.height)

	err := captureGDIFrame(f, h, &bi, make([]byte, h.width*h.height*4))
	if err == nil {
		t.Fatal("expected an error")
	}
	// #2160 saw this path and reported only "BitBlt failed".
	if !strings.Contains(err.Error(), "BitBlt failed") {
		t.Errorf("BitBlt failure must name the call, got %q", err)
	}
	// Exact match, not strings.Contains: single-digit codes are substrings of
	// the codes the fake injects elsewhere ("6" matches "6" in "0x6" but also
	// any longer code), so a substring check can read green on the WRONG error.
	if code, ok := win32ErrorCode(err); !ok || code != 6 {
		t.Errorf("BitBlt failure must carry Win32 code 6, got %d (present=%v) in %q", code, ok, err)
	}
	if !errors.Is(err, syscall.Errno(6)) {
		t.Errorf("errno must stay unwrappable, got %v", err)
	}
	// A plain blit failure does not by itself invalidate the handle set.
	if errors.Is(err, errGDIHandlesUnusable) {
		t.Errorf("BitBlt failure must not force a handle rebuild: %v", err)
	}
}

func TestCaptureGDIFrameReportsGetDIBitsErrno(t *testing.T) {
	h := testHandles()
	f := newFakeGDI(h)
	f.getDIBitsErrno = syscall.Errno(8) // ERROR_NOT_ENOUGH_MEMORY
	bi := newCaptureBitmapInfo(h.width, h.height)

	err := captureGDIFrame(f, h, &bi, make([]byte, h.width*h.height*4))
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "GetDIBits failed") {
		t.Errorf("GetDIBits failure must name the call, got %q", err)
	}
	// Exact match. `strings.Contains(err, "8")` is satisfied by "87" — the code
	// the fake returns for the selection-contract violation — so the substring
	// form read green whether the injected errno or the #5284 regression
	// produced the failure, i.e. it did not discriminate at all.
	if code, ok := win32ErrorCode(err); !ok || code != 8 {
		t.Errorf("GetDIBits failure must carry Win32 code 8, got %d (present=%v) in %q", code, ok, err)
	}
	// The bitmap must still be put back even on the failure path, so a later
	// retry with the same handles is not silently blitting into nowhere.
	if got := f.selected[h.memDC]; got != h.hBitmap {
		t.Errorf("capture bitmap not restored after a failed readback: memDC holds 0x%X", got)
	}
}

// A short readback is a torn frame, not a good one. GetDIBits returns the
// number of scan lines it copied; only the full height is a complete frame.
func TestCaptureGDIFrameRejectsPartialReadback(t *testing.T) {
	h := testHandles()
	f := newFakeGDI(h)
	f.getDIBitsPartial = true
	bi := newCaptureBitmapInfo(h.width, h.height)

	err := captureGDIFrame(f, h, &bi, make([]byte, h.width*h.height*4))
	if err == nil {
		t.Fatal("a partial scan-line copy must not be reported as a good frame")
	}
	if !strings.Contains(err.Error(), "scan lines") {
		t.Errorf("error should say what was short, got %q", err)
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

// GetDIBits writes width*height*4 bytes at &dst[0] regardless of how long the
// Go slice actually is, so a short buffer would be heap corruption and an empty
// one panics. The guard must reject both before any Win32 call runs.
func TestCaptureGDIFrameRejectsUndersizedBuffer(t *testing.T) {
	h := testHandles()
	bi := newCaptureBitmapInfo(h.width, h.height)
	full := h.width * h.height * 4

	for _, tc := range []struct {
		name string
		dst  []byte
		h    gdiFrameHandles
	}{
		{"empty buffer", nil, h},
		{"one byte short", make([]byte, full-1), h},
		{"zero width", make([]byte, full), gdiFrameHandles{memDC: h.memDC, screenDC: h.screenDC, hBitmap: h.hBitmap, oldBitmap: h.oldBitmap, width: 0, height: h.height}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeGDI(h)
			err := captureGDIFrame(f, tc.h, &bi, tc.dst)
			if err == nil {
				t.Fatal("expected the frame to be rejected")
			}
			if len(f.calls) != 0 {
				t.Errorf("no Win32 call may run with a bad buffer, got %v", f.calls)
			}
		})
	}

	// An oversized buffer is fine — pixBuf is reused across resolutions.
	f := newFakeGDI(h)
	if err := captureGDIFrame(f, h, &bi, make([]byte, full*2)); err != nil {
		t.Errorf("an oversized buffer must be accepted, got %v", err)
	}
}
