package elevaccount

import (
	"errors"
	"fmt"
	"syscall"
)

// Windows status codes meaning "the named local account does not exist on this
// host". They live in this untagged file, rather than beside the other
// netapi32 constants in elevaccount_windows.go, so that IsAccountAbsent is
// compiled and unit tested on every platform: the classification below decides
// whether the agent reports a PAM cleanup failure, and it is worth more
// coverage than the Windows-only build of this package currently gets.
// absent_windows_test.go asserts errorNoneMapped still matches x/sys/windows.
const (
	// nerrUserNotFound is netapi32's NERR_UserNotFound. NetUserSetInfo,
	// NetUserGetInfo and NetUserGetLocalGroups all return it when the local
	// account named in the call does not exist.
	nerrUserNotFound = 2221

	// errorNoneMapped is ERROR_NONE_MAPPED, returned by the LSA account-name
	// lookup behind windows.LookupSID when a name maps to no SID at all.
	errorNoneMapped = 1332
)

// IsAccountAbsent reports whether err means the dormant elevation account
// (~breeze_elev) does not exist on this host.
//
// That is the default state: the account is only provisioned when PAM is
// enabled, so on the majority of the fleet it was never created. An account
// that does not exist is provably not enabled, provably not a member of
// Administrators, and provably has no process holding a token for it, so the
// cleanup and verification paths treat this as "already clean" rather than as
// a failure. Reporting it as a failure is issue #4587: the PAM lifecycle
// manager only clears its enabled flag on success, so a never-provisioned
// agent re-ran the same cleanup and logged the same ERROR on every heartbeat.
//
// Only the two "no such account" statuses match. Every other status — access
// denied, a locked SAM, an invalid computer name — stays a real error so
// genuine cleanup failures keep failing closed. The status has to arrive as,
// or unwrap to, a syscall.Errno, which is how the netapi32 and LSA wrappers
// report it; it is never scraped out of the message text.
//
// This is a classifier for ONE call's status, and callers must treat it that
// way. It says nothing about which account the call was about, so it is only
// meaningful applied to a call that names the elevation account. Aggregate
// callers, which see a single error out of a sequence of syscalls, must use
// errAccountAbsent instead — see cleanIfAbsent.
func IsAccountAbsent(err error) bool {
	return errors.Is(err, syscall.Errno(nerrUserNotFound)) ||
		errors.Is(err, syscall.Errno(errorNoneMapped))
}

// errAccountAbsent marks an error as proof that the ELEVATION ACCOUNT itself
// does not exist. Only a probe may attach it, and only from the one syscall in
// that probe which names the account.
//
// The distinction is not pedantic. A probe runs more than one lookup, and the
// others are about different principals entirely: accountInAdministrators and
// localGroupMembersCall both resolve the builtin Administrators alias
// (S-1-5-32-544) first, and that lookup can fail with the very same
// ERROR_NONE_MAPPED. Matching the status code at the aggregate level would
// read "the machine cannot resolve its own Administrators group" as "the
// elevation account is absent, everything is clean" — inverting a security
// check on the strength of an unrelated failure.
var errAccountAbsent = errors.New("elevation account does not exist")

// absentAccountErr tags a probe failure as proof of absence. Call it ONLY for
// the status of a syscall that named the elevation account.
func absentAccountErr(err error) error {
	return fmt.Errorf("%w: %w", errAccountAbsent, err)
}

// cleanIfAbsent decides what a FAILED account probe means for the caller.
//
// When the failure is tagged as the account being absent, that is positive
// proof of a clean state rather than a cleanup failure, so it yields clean
// evidence and no error. Every other failure is passed through untouched —
// including a raw ERROR_NONE_MAPPED from some other principal's lookup, which
// is exactly what this must not mistake for absence.
//
// Each probe site in Deprovision and VerifyClean routes through this one
// function so the tolerance is defined — and tested — in a single place. Only
// the first probe in each of those functions is reachable in the
// never-provisioned case that motivated it, so per-site copies of this
// decision would ship unexercised.
func cleanIfAbsent(err error) (AccountEvidence, error) {
	switch {
	case err == nil:
		// Misuse: this helper interprets a failure, so a nil error here means
		// a caller is about to claim a clean account it never probed.
		return AccountEvidence{}, errors.New("elevaccount: cleanIfAbsent called without a probe failure")
	case errors.Is(err, errAccountAbsent):
		return AccountEvidence{Enabled: false, InAdministrators: false}, nil
	default:
		return AccountEvidence{}, err
	}
}

// evidenceAfterAdminProbe decides VerifyClean's outcome once the account's
// enabled state has already been MEASURED and the Administrators probe has
// reported. It lives here, untagged, so both of its failure branches are unit
// tested: on a never-provisioned host the first probe always fails first, so a
// copy of this decision inlined in the Windows-only VerifyClean would ship
// unexercised.
func evidenceAfterAdminProbe(enabled, inAdministrators bool, err error) (AccountEvidence, error) {
	switch {
	case err == nil:
		return AccountEvidence{Enabled: enabled, InAdministrators: inAdministrators}, nil
	case enabled && errors.Is(err, errAccountAbsent):
		// NetUserGetInfo just measured this account as ENABLED and the very
		// next call says it does not exist. One of the two is wrong, so
		// nothing here is proven: never discard a measured "enabled" in favour
		// of clean evidence.
		return AccountEvidence{}, fmt.Errorf(
			"contradictory evidence for %s: measured enabled, then reported absent: %w", AccountName, err)
	default:
		return cleanIfAbsent(err)
	}
}
