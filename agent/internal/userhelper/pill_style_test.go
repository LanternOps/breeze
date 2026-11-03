package userhelper

import (
	"errors"
	"syscall"
	"testing"
)

// #10351 review: a failed in-place style change (SetWindowLongPtrW returns 0
// with a last error, or SetWindowPos returns 0) is reported, so the pill is
// refused and the host takes today's banner instead of a pill whose
// click-through state is unknown.
func TestPillStyleChangeFailed(t *testing.T) {
	for _, tc := range []struct {
		name       string
		setLong    uintptr
		setLongErr error
		setPos     uintptr
		want       bool
	}{
		{"both succeed", 0x08080088, syscall.Errno(0), 1, false},
		{"previous style 0, no error", 0, syscall.Errno(0), 1, false},
		{"SetWindowLongPtrW failed", 0, syscall.Errno(1400), 1, true}, // ERROR_INVALID_WINDOW_HANDLE
		{"SetWindowPos failed", 0x08080088, syscall.Errno(0), 0, true},
		{"nil error is success", 0x08080088, nil, 1, false},
		{"non-errno error with 0", 0, errors.New("call failed"), 1, true},
	} {
		if got := pillStyleChangeFailed(tc.setLong, tc.setLongErr, tc.setPos); got != tc.want {
			t.Errorf("%s: failed = %v, want %v", tc.name, got, tc.want)
		}
	}
}
