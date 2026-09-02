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

// TestCleanIfAbsentConvertsOnlyAbsenceIntoCleanEvidence covers the decision
// every probe site in Deprovision and VerifyClean delegates to. Only the first
// probe in each of those functions is reachable on a never-provisioned host,
// so exercising the shared helper here is what keeps the later sites from
// shipping unverified.
func TestCleanIfAbsentConvertsOnlyAbsenceIntoCleanEvidence(t *testing.T) {
	t.Run("absent account becomes clean evidence", func(t *testing.T) {
		evidence, err := cleanIfAbsent(wrappedSetInfoErr(nerrUserNotFound))
		if err != nil {
			t.Fatalf("cleanIfAbsent(absent) error = %v, want nil", err)
		}
		if evidence.Enabled || evidence.InAdministrators {
			t.Fatalf("cleanIfAbsent(absent) evidence = %+v, want both false", evidence)
		}
	})

	t.Run("unresolvable name becomes clean evidence", func(t *testing.T) {
		evidence, err := cleanIfAbsent(syscall.Errno(errorNoneMapped))
		if err != nil {
			t.Fatalf("cleanIfAbsent(none mapped) error = %v, want nil", err)
		}
		if evidence.Enabled || evidence.InAdministrators {
			t.Fatalf("cleanIfAbsent(none mapped) evidence = %+v, want both false", evidence)
		}
	})

	t.Run("every other failure passes through unchanged", func(t *testing.T) {
		for _, probeErr := range []error{
			wrappedSetInfoErr(5),    // ERROR_ACCESS_DENIED
			wrappedGetInfoErr(2224), // NERR_UserExists
			errors.New("SAM database is locked"),
		} {
			evidence, err := cleanIfAbsent(probeErr)
			if !errors.Is(err, probeErr) {
				t.Fatalf("cleanIfAbsent(%v) error = %v, want the original failure", probeErr, err)
			}
			if evidence != (AccountEvidence{}) {
				t.Fatalf("cleanIfAbsent(%v) evidence = %+v, want zero evidence alongside a real error", probeErr, evidence)
			}
		}
	})

	// Misuse must fail closed rather than manufacture a clean result: this
	// helper interprets a failure, so a nil error means the caller is about to
	// claim an account state it never probed.
	t.Run("nil probe failure is refused", func(t *testing.T) {
		evidence, err := cleanIfAbsent(nil)
		if err == nil {
			t.Fatalf("cleanIfAbsent(nil) returned evidence %+v and no error; it must not invent a clean result", evidence)
		}
	})
}
