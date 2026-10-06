//go:build windows

package recoveryconsole

import (
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// procReadConsoleInputW is kernel32!ReadConsoleInputW, which
// golang.org/x/sys/windows does not wrap. Loaded from System32 only
// (NewLazySystemDLL), never through the DLL search path.
var procReadConsoleInputW = windows.NewLazySystemDLL("kernel32.dll").NewProc("ReadConsoleInputW")

// inputRecord is INPUT_RECORD with its Event union laid out as
// KEY_EVENT_RECORD (the union's other members are no larger, so the size,
// 20 bytes, matches the real struct — TestInputRecordLayout pins it):
//
//	WORD  EventType;            // offset 0
//	(2 bytes padding)           // union is DWORD-aligned
//	BOOL  bKeyDown;             // offset 4
//	WORD  wRepeatCount;         // offset 8
//	WORD  wVirtualKeyCode;      // offset 10
//	WORD  wVirtualScanCode;     // offset 12
//	WCHAR uChar.UnicodeChar;    // offset 14
//	DWORD dwControlKeyState;    // offset 16
type inputRecord struct {
	EventType       uint16
	_               uint16
	KeyDown         int32
	RepeatCount     uint16
	VirtualKeyCode  uint16
	VirtualScanCode uint16
	UnicodeChar     uint16
	ControlKeyState uint32
}

// readOneKey waits up to d for one key-down event on the console input
// handle behind os.Stdin (on WinPE: the console winpeshl.ini starts the
// recovery console on). Non-key events (focus, mouse, window resize, menu)
// and key-up events are consumed and ignored while time remains. Any key
// counts, including one with no character (a lone Shift): the countdown is
// "press any key to stay".
//
// When stdin is not a console (GetConsoleMode fails: a pipe, a file, NUL —
// as under `go test`), it reports "no key" without reading: it waits out d
// rather than returning instantly, so ReadKeyWithTimeout's slice loop does
// not spin a CPU for the whole countdown, and the countdown keeps its
// length. Any wait or read error degrades the same way.
func readOneKey(d time.Duration) (rune, bool) {
	deadline := time.Now().Add(d)
	h := windows.Handle(os.Stdin.Fd())

	var mode uint32
	if err := windows.GetConsoleMode(h, &mode); err != nil {
		sleepUntil(deadline)
		return 0, false
	}

	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return 0, false
		}
		ms := uint32(remaining / time.Millisecond)
		if ms == 0 {
			ms = 1
		}
		ev, err := windows.WaitForSingleObject(h, ms)
		if err != nil || ev != windows.WAIT_OBJECT_0 {
			// WAIT_TIMEOUT (nothing pressed) or a wait failure.
			if err != nil {
				sleepUntil(deadline)
			}
			return 0, false
		}

		var rec inputRecord
		var n uint32
		r1, _, _ := procReadConsoleInputW.Call(
			uintptr(h),
			uintptr(unsafe.Pointer(&rec)),
			1,
			uintptr(unsafe.Pointer(&n)),
		)
		if r1 == 0 {
			sleepUntil(deadline)
			return 0, false
		}
		if n == 1 && rec.EventType == windows.KEY_EVENT && rec.KeyDown != 0 {
			return rune(rec.UnicodeChar), true
		}
		// Not a key-down: keep waiting for the rest of d.
	}
}

func sleepUntil(deadline time.Time) {
	if r := time.Until(deadline); r > 0 {
		time.Sleep(r)
	}
}
