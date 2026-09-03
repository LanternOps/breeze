//go:build windows

package elevaccount

import (
	"context"
	"testing"

	"golang.org/x/sys/windows"
)

// TestAbsentStatusCodesMatchWin32 keeps the platform-independent copies in
// absent.go honest. absent.go carries the numeric statuses so the classifier
// can be unit tested on every platform, which means it cannot reference
// x/sys/windows; this is the only place the two can be compared.
func TestAbsentStatusCodesMatchWin32(t *testing.T) {
	if got := uint32(windows.ERROR_NONE_MAPPED); got != errorNoneMapped {
		t.Fatalf("errorNoneMapped = %d, but windows.ERROR_NONE_MAPPED = %d", errorNoneMapped, got)
	}
}

// requireAbsentElevationAccount asserts the precondition the tests below need:
// ~breeze_elev does not exist on this host. That is the state of every machine
// that has never enabled PAM, including a CI runner, and it is the state
// issue #4587 was reported against.
func requireAbsentElevationAccount(t *testing.T) {
	t.Helper()
	_, err := accountEnabled(AccountName)
	if err == nil {
		t.Skipf("%s exists on this host; these tests only cover the never-provisioned case", AccountName)
	}
	if !IsAccountAbsent(err) {
		t.Skipf("cannot confirm %s is absent (NetUserGetInfo: %v); needs a host where querying local accounts is permitted", AccountName, err)
	}
}

// TestVerifyCleanTreatsAbsentAccountAsClean exercises the real netapi32 path
// behind issue #4587. An account that was never created is provably not
// enabled and provably not in Administrators, so VerifyClean must report clean
// evidence rather than NERR_UserNotFound. Before the fix this returned
// "NetUserGetInfo ~breeze_elev failed: 2221", which the PAM lifecycle manager
// turned into an ERROR log line on every single heartbeat.
func TestVerifyCleanTreatsAbsentAccountAsClean(t *testing.T) {
	requireAbsentElevationAccount(t)

	evidence, err := NewVerified().VerifyClean(context.Background())
	if err != nil {
		t.Fatalf("VerifyClean on an absent account = %v, want nil", err)
	}
	if evidence.Enabled || evidence.InAdministrators {
		t.Fatalf("VerifyClean evidence = %+v, want both false for an account that does not exist", evidence)
	}
}

// TestDeprovisionTreatsAbsentAccountAsClean covers the other half. The call is
// non-destructive here precisely because the account is absent: the first
// netapi32 write reports NERR_UserNotFound and nothing is modified.
func TestDeprovisionTreatsAbsentAccountAsClean(t *testing.T) {
	requireAbsentElevationAccount(t)

	evidence, err := NewVerified().Deprovision(context.Background())
	if err != nil {
		t.Fatalf("Deprovision on an absent account = %v, want nil", err)
	}
	if evidence.Enabled || evidence.InAdministrators {
		t.Fatalf("Deprovision evidence = %+v, want both false for an account that does not exist", evidence)
	}
}
