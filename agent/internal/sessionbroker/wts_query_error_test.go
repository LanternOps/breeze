package sessionbroker

import (
	"errors"
	"strings"
	"syscall"
	"testing"
)

// A failed WTSUserName query is what makes UsernameUnknown; the Win32 code
// has to survive into the error so the "keeping the sign-in console" Warn can
// carry it (#8434 review).
func TestWTSQueryErrorKeepsTheWin32Code(t *testing.T) {
	err := wtsQueryError(5, syscall.Errno(5))
	var errno syscall.Errno
	if !errors.As(err, &errno) || errno != 5 {
		t.Fatalf("wtsQueryError(...) = %v; want it to unwrap to syscall.Errno(5)", err)
	}
	if !strings.Contains(err.Error(), "WTSQuerySessionInformationW") || !strings.Contains(err.Error(), "Win32 error 5") {
		t.Fatalf("wtsQueryError text = %q", err)
	}

	for _, noCode := range []error{nil, syscall.Errno(0)} {
		err := wtsQueryError(5, noCode)
		if err == nil {
			t.Fatalf("wtsQueryError(5, %v) = nil; a failed query must still be an error", noCode)
		}
		if errors.As(err, &errno) {
			t.Errorf("wtsQueryError(5, %v) unwraps to Errno %d; there was no code", noCode, errno)
		}
		if !strings.Contains(err.Error(), "no error code") {
			t.Errorf("wtsQueryError(5, %v) = %q; want it to say no code was recorded", noCode, err)
		}
	}
}
