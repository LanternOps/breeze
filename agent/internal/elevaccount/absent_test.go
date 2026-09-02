package elevaccount

import (
	"errors"
	"fmt"
	"syscall"
	"testing"
)

// The netapi32 and LSA wrappers in elevaccount_windows.go and
// pamlifetime/job_windows.go all report a failed status as
// fmt.Errorf(..., %w, syscall.Errno(status)). These helpers reproduce those
// wrap shapes verbatim so IsAccountAbsent is exercised against the exact error
// values Deprovision, VerifyClean and VerifyNoPrivilegedToken see in the
// field, rather than against a bare errno the production path never returns.
func wrappedSetInfoErr(status uint32) error {
	return fmt.Errorf("NetUserSetInfo level %d failed: %w", 1003, syscall.Errno(status))
}

func wrappedGetInfoErr(status uint32) error {
	return fmt.Errorf("NetUserGetInfo %s failed: %w", AccountName, syscall.Errno(status))
}

func wrappedLocalGroupsErr(status uint32) error {
	return fmt.Errorf("NetUserGetLocalGroups %s failed: %w", AccountName, syscall.Errno(status))
}

// TestIsAccountAbsentClassifiesOnlyMissingAccountStatuses pins the classifier
// behind issue #4587. On a Windows deployment that never enabled PAM the
// dormant ~breeze_elev account was never created, so every netapi32 call that
// names it fails with NERR_UserNotFound and every LSA name lookup fails with
// ERROR_NONE_MAPPED. Those two statuses mean "the account does not exist",
// which is provably clean; every other status is a real failure and must keep
// failing closed.
func TestIsAccountAbsentClassifiesOnlyMissingAccountStatuses(t *testing.T) {
	const (
		nerrSuccessStatus     = 0    // NERR_Success
		accessDeniedStatus    = 5    // ERROR_ACCESS_DENIED
		nerrUserExistsStatus  = 2224 // NERR_UserExists
		nerrNotInGroupStatus  = 2237 // NERR_UserNotInGroup
		invalidComputerStatus = 2351 // NERR_InvalidComputer
	)

	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"NetUserSetInfo user not found", wrappedSetInfoErr(nerrUserNotFound), true},
		{"NetUserGetInfo user not found", wrappedGetInfoErr(nerrUserNotFound), true},
		{"NetUserGetLocalGroups user not found", wrappedLocalGroupsErr(nerrUserNotFound), true},
		{"LookupSID none mapped", fmt.Errorf("lookup %s: %w", AccountName, syscall.Errno(errorNoneMapped)), true},
		{"bare NERR_UserNotFound", syscall.Errno(nerrUserNotFound), true},
		{"bare ERROR_NONE_MAPPED", syscall.Errno(errorNoneMapped), true},
		{"wrapped twice", fmt.Errorf("verify account clean: %w", wrappedSetInfoErr(nerrUserNotFound)), true},

		{"nil", nil, false},
		{"access denied", wrappedSetInfoErr(accessDeniedStatus), false},
		{"success status", wrappedSetInfoErr(nerrSuccessStatus), false},
		{"user already exists", wrappedSetInfoErr(nerrUserExistsStatus), false},
		{"user not in group", wrappedSetInfoErr(nerrNotInGroupStatus), false},
		{"invalid computer", wrappedSetInfoErr(invalidComputerStatus), false},
		{"one below user not found", wrappedSetInfoErr(nerrUserNotFound - 1), false},
		{"one above user not found", wrappedSetInfoErr(nerrUserNotFound + 1), false},
		{"one below none mapped", wrappedSetInfoErr(errorNoneMapped - 1), false},
		{"one above none mapped", wrappedSetInfoErr(errorNoneMapped + 1), false},
		// The status must be carried as a wrapped errno, never scraped out of
		// the message text: a real failure whose text happens to contain 2221
		// (a PID, a byte count) must not be read as a missing account.
		{"status only in message text", errors.New("NetUserSetInfo level 1003 failed: 2221"), false},
		{"wrapped non-errno error", fmt.Errorf("deprovision: %w", errors.New("ledger unavailable")), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsAccountAbsent(tt.err); got != tt.want {
				t.Fatalf("IsAccountAbsent(%v) = %v, want %v", tt.err, got, tt.want)
			}
		})
	}
}
