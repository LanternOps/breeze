package systemrestore

import (
	"errors"
	"strings"
	"syscall"
	"testing"
)

func TestRestorePointCallFailed(t *testing.T) {
	tests := []struct {
		name    string
		ret     uintptr
		nStatus uint32
		failed  bool
		want    string
	}{
		{"success", 1, 0, false, ""},
		{"call returned false with a status", 0, 5, true, "SRSetRestorePointW returned FALSE (nStatus=5)"},
		{"call returned false with no status", 0, 0, true, "SRSetRestorePointW returned FALSE (nStatus=0)"},
		{"call returned true but status nonzero", 1, 13, true, "SRSetRestorePointW reported nStatus=13"},
		{"BOOL FALSE with garbage in the upper register half", uintptr(uint64(0xFFFFFFFF00000000) & uint64(^uintptr(0))), 0, true, "SRSetRestorePointW returned FALSE (nStatus=0)"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, failed := restorePointCallFailed(tc.ret, tc.nStatus)
			if failed != tc.failed || got != tc.want {
				t.Fatalf("restorePointCallFailed(%d, %d) = (%q, %v), want (%q, %v)",
					tc.ret, tc.nStatus, got, failed, tc.want, tc.failed)
			}
		})
	}
}

func TestInterpretCall(t *testing.T) {
	ok := newStatemgrStatus()
	ok.Status = 0
	copy(ok.SequenceNumber[:], []byte{0x2a, 0, 0, 0, 1, 0, 0, 0})

	seq, err := interpretCall(1, syscall.Errno(0), ok)
	if err != nil || seq != 1<<32|0x2a {
		t.Fatalf("success = (%d, %v)", seq, err)
	}

	bad := newStatemgrStatus()
	bad.Status = 5
	_, err = interpretCall(0, syscall.Errno(5), bad)
	var nerr *nativeError
	if !errors.As(err, &nerr) || nerr.nStatus != 5 || !errors.Is(err, syscall.Errno(5)) {
		t.Fatalf("FALSE with errno 5: err = %#v", err)
	}
	if !strings.Contains(err.Error(), "nStatus=5") {
		t.Fatalf("message %q lost nStatus", err.Error())
	}

	_, err = interpretCall(0, syscall.Errno(0), bad)
	if !errors.As(err, &nerr) || nerr.cause != nil {
		t.Fatalf("Errno(0) must not be attached as a cause: %#v", err)
	}

	trueButStatus := newStatemgrStatus()
	trueButStatus.Status = 13
	if _, err := interpretCall(1, syscall.Errno(0), trueButStatus); err == nil {
		t.Fatal("TRUE with nonzero nStatus must fail")
	}
}

func TestIsMissingLibraryError(t *testing.T) {
	for _, tc := range []struct {
		errno uintptr
		want  bool
	}{
		{126, true},   // ERROR_MOD_NOT_FOUND
		{127, true},   // ERROR_PROC_NOT_FOUND
		{5, false},    // ERROR_ACCESS_DENIED
		{1455, false}, // ERROR_COMMITMENT_LIMIT
	} {
		if got := isMissingLibraryErrno(tc.errno); got != tc.want {
			t.Fatalf("isMissingLibraryErrno(%d) = %v, want %v", tc.errno, got, tc.want)
		}
	}
}
