package elevaccount

import (
	"errors"
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
// denied, a locked SAM, an unreachable computer — stays a real error so
// genuine cleanup failures keep failing closed. The status has to arrive as a
// wrapped syscall.Errno, which is how the netapi32 and LSA wrappers report it;
// it is never scraped out of the message text.
func IsAccountAbsent(err error) bool {
	return errors.Is(err, syscall.Errno(nerrUserNotFound)) ||
		errors.Is(err, syscall.Errno(errorNoneMapped))
}

// cleanIfAbsent decides what a FAILED account probe means for the caller.
//
// When the failure means the account does not exist, that is positive proof of
// a clean state rather than a cleanup failure, so it yields clean evidence and
// no error. Every other failure is passed through untouched.
//
// All four probe sites in Deprovision and VerifyClean route through this one
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
	case IsAccountAbsent(err):
		return AccountEvidence{Enabled: false, InAdministrators: false}, nil
	default:
		return AccountEvidence{}, err
	}
}
