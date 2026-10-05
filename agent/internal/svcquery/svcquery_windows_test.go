//go:build windows

package svcquery

import (
	"errors"
	"fmt"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestClassifyOpenError(t *testing.T) {
	tests := []struct {
		name         string
		err          error
		wantNotFound bool
	}{
		{"does not exist", windows.ERROR_SERVICE_DOES_NOT_EXIST, true},
		{"invalid name", windows.ERROR_INVALID_NAME, true},
		{"wrapped does not exist", fmt.Errorf("open: %w", windows.ERROR_SERVICE_DOES_NOT_EXIST), true},
		{"access denied", windows.ERROR_ACCESS_DENIED, false},
		{"invalid handle", windows.ERROR_INVALID_HANDLE, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyOpenError(tt.err)
			if errors.Is(got, ErrServiceNotFound) != tt.wantNotFound {
				t.Fatalf("classifyOpenError(%v) = %v; ErrServiceNotFound=%v, want %v",
					tt.err, got, errors.Is(got, ErrServiceNotFound), tt.wantNotFound)
			}
			if !errors.Is(got, tt.err) {
				t.Fatalf("classifyOpenError(%v) = %v; original error not preserved", tt.err, got)
			}
		})
	}
}

// svcquery only reads status and config. Requesting anything more (as
// mgr.OpenService does with SERVICE_ALL_ACCESS) is refused by services with a
// restrictive DACL such as WinDefend (#7967).
func TestQueryServiceAccessIsReadOnly(t *testing.T) {
	const allowed = windows.SERVICE_QUERY_STATUS | windows.SERVICE_QUERY_CONFIG
	if extra := uint32(queryServiceAccess) &^ uint32(allowed); extra != 0 {
		t.Fatalf("queryServiceAccess requests extra rights %#x beyond QUERY_STATUS|QUERY_CONFIG", extra)
	}
}

func TestGetStatusMissingServiceIsNotFound(t *testing.T) {
	_, err := GetStatus("breeze-svcquery-no-such-service-7967")
	if err == nil {
		t.Fatal("expected an error for a nonexistent service")
	}
	if !errors.Is(err, ErrServiceNotFound) {
		t.Fatalf("GetStatus(nonexistent) error = %v, want it to wrap ErrServiceNotFound", err)
	}
}

// WinDefend carries a restrictive DACL. The least-privilege open must succeed
// and report a real state. (CI runners are elevated, so this alone would not
// have caught the SERVICE_ALL_ACCESS bug; TestQueryServiceAccessIsReadOnly
// pins the access mask.)
func TestGetStatusProtectedService(t *testing.T) {
	m, err := mgr.Connect()
	if err != nil {
		t.Skipf("cannot connect to SCM: %v", err)
	}
	s, err := openServiceForQuery(m, "WinDefend")
	m.Disconnect()
	if errors.Is(err, ErrServiceNotFound) {
		t.Skip("WinDefend not installed on this host")
	}
	if err != nil {
		t.Fatalf("openServiceForQuery(WinDefend) = %v, want success with query-only access", err)
	}
	s.Close()

	info, err := GetStatus("WinDefend")
	if err != nil {
		t.Fatalf("GetStatus(WinDefend) error = %v", err)
	}
	if info.Status != StatusRunning && info.Status != StatusStopped {
		t.Fatalf("GetStatus(WinDefend).Status = %q, want running or stopped", info.Status)
	}
}
