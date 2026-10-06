//go:build windows

package recoveryconsole

import (
	"io"
	"strings"
	"testing"
	"time"
	"unsafe"
)

// INPUT_RECORD is 20 bytes on every Windows ABI: WORD EventType, 2 bytes of
// padding, then the 16-byte event union (KEY_EVENT_RECORD and
// MOUSE_EVENT_RECORD are its largest members). A wrong size makes
// ReadConsoleInputW write past our buffer.
func TestInputRecordLayout(t *testing.T) {
	var r inputRecord
	if got := unsafe.Sizeof(r); got != 20 {
		t.Fatalf("sizeof(inputRecord) = %d, want 20", got)
	}
	if got := unsafe.Offsetof(r.KeyDown); got != 4 {
		t.Fatalf("offsetof(KeyDown) = %d, want 4", got)
	}
	if got := unsafe.Offsetof(r.UnicodeChar); got != 14 {
		t.Fatalf("offsetof(UnicodeChar) = %d, want 14", got)
	}
}

// Under `go test` stdin is not a console (a pipe or NUL), so the countdown
// read must degrade to "no key pressed" promptly instead of blocking. The
// real keypress path is verified on WinPE in the lab.
func TestReadKeyWithTimeout_NonConsoleStdinDegrades(t *testing.T) {
	start := time.Now()
	k, ok := NewTerminalIO(strings.NewReader(""), io.Discard).ReadKeyWithTimeout(10 * time.Millisecond)
	if ok || k != 0 {
		t.Fatalf("got (%q, %v), want (0, false)", k, ok)
	}
	if el := time.Since(start); el > time.Second {
		t.Fatalf("took %v, want < 1s", el)
	}
}
