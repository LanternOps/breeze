package userhelper

import (
	"syscall"
	"testing"
)

// #10351 re-review: when SetWindowLongPtrW took the new style but
// SetWindowPos failed, the previous extended style is put back, so a pill
// left on screen is never click-through when it should take clicks, or the
// reverse. When SetWindowLongPtrW itself failed there is nothing to undo.
func TestPillStyleRestoreDecision(t *testing.T) {
	for _, tc := range []struct {
		name        string
		setLong     uintptr
		setLongErr  error
		setPos      uintptr
		failed      bool
		restorePrev bool
	}{
		{"both succeed", 0x08080088, syscall.Errno(0), 1, false, false},
		{"SetWindowPos failed after the style changed", 0x08080088, syscall.Errno(0), 0, true, true},
		{"SetWindowPos failed, previous style was 0", 0, syscall.Errno(0), 0, true, true},
		{"SetWindowLongPtrW failed", 0, syscall.Errno(1400), 1, true, false},
		{"both failed", 0, syscall.Errno(1400), 0, true, false},
	} {
		failed, restore := pillStyleOutcome(tc.setLong, tc.setLongErr, tc.setPos)
		if failed != tc.failed || restore != tc.restorePrev {
			t.Errorf("%s: failed=%v restore=%v, want %v/%v", tc.name, failed, restore, tc.failed, tc.restorePrev)
		}
	}
}
