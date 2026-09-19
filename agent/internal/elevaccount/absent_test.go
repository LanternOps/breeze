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
// adminAliasSIDForTest mirrors the windows-only adminAliasSID constant, which
// an untagged test file cannot reference.
const adminAliasSIDForTest = "S-1-5-32-544"

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
		evidence, err := cleanIfAbsent(absentAccountErr(wrappedSetInfoErr(nerrUserNotFound)))
		if err != nil {
			t.Fatalf("cleanIfAbsent(absent) error = %v, want nil", err)
		}
		if evidence.Enabled || evidence.InAdministrators {
			t.Fatalf("cleanIfAbsent(absent) evidence = %+v, want both false", evidence)
		}
	})

	t.Run("unresolvable name becomes clean evidence", func(t *testing.T) {
		evidence, err := cleanIfAbsent(absentAccountErr(syscall.Errno(errorNoneMapped)))
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

// TestCleanIfAbsentIgnoresAbsenceStatusesFromOtherPrincipals is the regression
// test for the review finding that motivated errAccountAbsent. Both
// accountInAdministrators and localGroupMembersCall resolve the builtin
// Administrators alias (S-1-5-32-544) BEFORE they touch the elevation account,
// and that lookup fails with the very same ERROR_NONE_MAPPED. Classifying on
// the status code alone would read "this machine cannot resolve its own
// Administrators group" as "the elevation account is absent, all clean" —
// inverting the security check on an unrelated failure.
func TestCleanIfAbsentIgnoresAbsenceStatusesFromOtherPrincipals(t *testing.T) {
	aliasLookupFailures := []error{
		// What administratorsGroupName() returns: a bare errno from
		// LookupAccountSid on the builtin alias, untagged by any probe.
		syscall.Errno(errorNoneMapped),
		fmt.Errorf("LookupAccountSid %s: %w", adminAliasSIDForTest, syscall.Errno(errorNoneMapped)),
		syscall.Errno(nerrUserNotFound),
	}

	for _, aliasErr := range aliasLookupFailures {
		evidence, err := cleanIfAbsent(aliasErr)
		if err == nil {
			t.Fatalf("cleanIfAbsent(%v) returned evidence %+v and no error; an alias-lookup failure is not proof the elevation account is absent", aliasErr, evidence)
		}
		if !errors.Is(err, aliasErr) {
			t.Fatalf("cleanIfAbsent(%v) error = %v, want the original failure passed through", aliasErr, err)
		}
		if evidence != (AccountEvidence{}) {
			t.Fatalf("cleanIfAbsent(%v) evidence = %+v, want zero evidence", aliasErr, evidence)
		}
	}

	// The identical status IS absence once the probe that named the account
	// tags it. Same errno, opposite meaning — which is the whole point.
	if _, err := cleanIfAbsent(absentAccountErr(syscall.Errno(errorNoneMapped))); err != nil {
		t.Fatalf("cleanIfAbsent(tagged absence) = %v, want nil", err)
	}
}

// TestEvidenceAfterAdminProbeNeverDiscardsAMeasuredEnabledAccount covers the
// second VerifyClean probe, which is unreachable on a never-provisioned host
// because the first probe fails first.
func TestEvidenceAfterAdminProbeNeverDiscardsAMeasuredEnabledAccount(t *testing.T) {
	t.Run("both probes succeeded", func(t *testing.T) {
		evidence, err := evidenceAfterAdminProbe(true, true, nil)
		if err != nil {
			t.Fatalf("error = %v, want nil", err)
		}
		if !evidence.Enabled || !evidence.InAdministrators {
			t.Fatalf("evidence = %+v, want the measured values preserved", evidence)
		}
	})

	t.Run("disabled account reported absent is clean", func(t *testing.T) {
		evidence, err := evidenceAfterAdminProbe(false, false, absentAccountErr(syscall.Errno(nerrUserNotFound)))
		if err != nil {
			t.Fatalf("error = %v, want nil", err)
		}
		if evidence.Enabled || evidence.InAdministrators {
			t.Fatalf("evidence = %+v, want both false", evidence)
		}
	})

	// The contradiction: NetUserGetInfo measured the account ENABLED, then the
	// next call says it does not exist. Returning clean evidence here would
	// throw away the one measurement that says the account is dangerous.
	t.Run("enabled account reported absent fails closed", func(t *testing.T) {
		evidence, err := evidenceAfterAdminProbe(true, false, absentAccountErr(syscall.Errno(nerrUserNotFound)))
		if err == nil {
			t.Fatalf("returned evidence %+v and no error; a measured enabled account must never be discarded as clean", evidence)
		}
		if evidence != (AccountEvidence{}) {
			t.Fatalf("evidence = %+v, want zero evidence alongside the error", evidence)
		}
	})

	t.Run("alias lookup failure propagates even when disabled", func(t *testing.T) {
		aliasErr := syscall.Errno(errorNoneMapped)
		if _, err := evidenceAfterAdminProbe(false, false, aliasErr); !errors.Is(err, aliasErr) {
			t.Fatalf("error = %v, want the alias-lookup failure passed through", err)
		}
	})
}
