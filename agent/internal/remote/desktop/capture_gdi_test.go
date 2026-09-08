package desktop

import (
	"errors"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

// No build tag, on purpose — see the header of capture_gdi.go. The GDI capturer
// is `windows && !cgo` and remote/desktop is excluded from the Test Agent
// (Windows) job, so a windows-tagged test here would run on no platform.

func TestCaptureBitmapInfoMatchesWin32ABI(t *testing.T) {
	const (
		width  = 1920
		height = 1080
	)
	bi := newCaptureBitmapInfo(width, height)
	h := bi.BmiHeader

	if got := unsafe.Sizeof(bitmapInfoHeader{}); got != bitmapInfoHeaderSize {
		t.Fatalf("bitmapInfoHeader is %d bytes, Win32 BITMAPINFOHEADER is %d — "+
			"a field was added, removed, resized or reordered; GetDIBits and "+
			"CreateDIBSection reject a header whose BiSize they do not recognise",
			got, bitmapInfoHeaderSize)
	}
	if h.BiSize != bitmapInfoHeaderSize {
		t.Errorf("BiSize = %d, want %d", h.BiSize, bitmapInfoHeaderSize)
	}
	if h.BiWidth != width {
		t.Errorf("BiWidth = %d, want %d", h.BiWidth, width)
	}
	// The sign is the whole point: positive height means bottom-up rows and
	// every captured frame reaches the viewer vertically mirrored.
	if h.BiHeight != -height {
		t.Errorf("BiHeight = %d, want %d (negative requests a top-down DIB)", h.BiHeight, -height)
	}
	if h.BiPlanes != 1 {
		t.Errorf("BiPlanes = %d, want 1", h.BiPlanes)
	}
	if h.BiBitCount != 32 {
		t.Errorf("BiBitCount = %d, want 32 (bgraToRGBA consumes 4 bytes per pixel)", h.BiBitCount)
	}
	if h.BiCompression != biRGB {
		t.Errorf("BiCompression = %d, want BI_RGB (%d)", h.BiCompression, biRGB)
	}
}

// A zero errno must not be reported as "Win32 error 0". Not every GDI entry
// point calls SetLastError, so "failed, and Win32 recorded nothing" is a real
// and distinct observation — reporting it as error code 0 sends the reader
// looking up ERROR_SUCCESS.
func TestGDICallErrorDistinguishesZeroErrno(t *testing.T) {
	zero := gdiCallError("GetDIBits", syscall.Errno(0))
	if !strings.Contains(zero.Error(), "GetDIBits failed") {
		t.Errorf("zero-errno message lost the operation name: %q", zero)
	}
	if strings.Contains(zero.Error(), "error 0") || strings.Contains(zero.Error(), "0x0") {
		t.Errorf("zero errno must not be rendered as an error code, got %q", zero)
	}

	nilErr := gdiCallError("BitBlt", nil)
	if !strings.Contains(nilErr.Error(), "BitBlt failed") {
		t.Errorf("nil-errno message lost the operation name: %q", nilErr)
	}
}

// The whole point of #5284: the numeric Win32 code must survive into the error
// text, because the failure is only reproducible on a live Winlogon console and
// the error string is the only diagnostic channel back from the endpoint.
func TestGDICallErrorCarriesWin32Code(t *testing.T) {
	// 5 == ERROR_ACCESS_DENIED, 87 == ERROR_INVALID_PARAMETER on Windows. The
	// assertions below are on the NUMBER, not on the platform's message text,
	// so they hold on the Linux runner too.
	for _, code := range []uint32{5, 87, 6} {
		errno := syscall.Errno(code)
		err := gdiCallError("GetDIBits", errno)

		if !strings.Contains(err.Error(), "GetDIBits failed") {
			t.Errorf("code %d: message lost the operation name: %q", code, err)
		}
		for _, want := range []string{
			// decimal and hex both, so a log line is greppable either way
			strconv.FormatUint(uint64(code), 10),
			strings.ToUpper(strconv.FormatUint(uint64(code), 16)),
		} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("code %d: message %q does not contain %q", code, err, want)
			}
		}
		if !errors.Is(err, errno) {
			t.Errorf("code %d: errors.Is must match the wrapped syscall.Errno, got %v", code, err)
		}
	}
}

func TestShouldRebuildGDIHandles(t *testing.T) {
	tests := []struct {
		name                       string
		inited                     bool
		haveW, haveH, wantW, wantH int
		ownerThread, currentThread uint32
		want                       bool
	}{
		{"not initialised", false, 0, 0, 1920, 1080, 0, 0, true},
		{"same size, thread check disabled", true, 1920, 1080, 1920, 1080, 0, 0, false},
		{"width changed", true, 1280, 1080, 1920, 1080, 7, 7, true},
		{"height changed", true, 1920, 720, 1920, 1080, 7, 7, true},
		{"same size, same thread", true, 1920, 1080, 1920, 1080, 7, 7, false},
		// The #5284 case: handles were created on the startup probe's pinned
		// thread, and the streaming loop runs on a different pinned thread.
		{"same size, different thread", true, 1920, 1080, 1920, 1080, 7, 9, true},
		// A thread id we could not read must not force a rebuild every frame.
		{"owner thread unknown", true, 1920, 1080, 1920, 1080, 0, 9, false},
		{"current thread unknown", true, 1920, 1080, 1920, 1080, 7, 0, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldRebuildGDIHandles(tc.inited, tc.haveW, tc.haveH, tc.wantW, tc.wantH, tc.ownerThread, tc.currentThread)
			if got != tc.want {
				t.Fatalf("shouldRebuildGDIHandles = %v, want %v", got, tc.want)
			}
		})
	}
}

// errnoForTest builds a syscall.Errno so tests read the same on every platform.
// The assertions that use it are on the numeric code and on unwrapping, never
// on the host's message text for that number.
func errnoForTest(code uint32) error { return syscall.Errno(code) }

// win32ErrorCode is what puts the numeric code into the helper log as its own
// structured field, so a reporter can grep it without parsing the message.
func TestWin32ErrorCode(t *testing.T) {
	if code, ok := win32ErrorCode(gdiCallError("GetDIBits", syscall.Errno(87))); !ok || code != 87 {
		t.Errorf("win32ErrorCode = %d, %v; want 87, true", code, ok)
	}
	// Wrapped one level deeper, as describeCaptureFailure leaves it.
	deep := describeCaptureFailure(
		&reportingCapturer{lastErr: gdiCallError("GetDIBits", syscall.Errno(5))},
		errors.New("no frame after 5 attempts"),
	)
	if code, ok := win32ErrorCode(deep); !ok || code != 5 {
		t.Errorf("win32ErrorCode through a wrapped error = %d, %v; want 5, true", code, ok)
	}
	// A zero errno carries no code — reporting 0 would read as ERROR_SUCCESS.
	if _, ok := win32ErrorCode(gdiCallError("GetDIBits", syscall.Errno(0))); ok {
		t.Error("a zero errno must not be reported as a Win32 code")
	}
	if _, ok := win32ErrorCode(errors.New("plain error")); ok {
		t.Error("a non-syscall error must not yield a Win32 code")
	}
}
