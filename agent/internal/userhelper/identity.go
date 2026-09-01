package userhelper

import (
	"fmt"
	"os"
	"os/user"
	"strconv"
)

// Seams over the stdlib identity lookups so the retry behaviour can be tested
// without a second OS account.
var (
	currentUserLookupByID = user.LookupId
	currentUserLookup     = user.Current
)

// resolveUnixIdentity returns the uid and username of the current process on
// the non-Windows auth path.
//
// It deliberately avoids leading with user.Current(): the stdlib memoizes
// that call's result — INCLUDING its error — in a process-wide sync.Once
// (see os/user/lookup.go, "The first call will cache the current user
// information"). That was survivable while the helper exited on every IPC
// failure, because the launchd/systemd respawn started a fresh process with a
// fresh cache. Now that the reconnect supervisor keeps one process alive
// across many auth attempts (#4194), a single early failure — a lookup racing
// session setup at login, say — would be replayed forever and every
// subsequent reconnect would fail auth with the same stale error.
//
// os.Getuid() is a syscall that cannot fail, and user.LookupId() is not
// memoized, so both are re-evaluated on every attempt. The Windows branch of
// authenticate() bypasses user.Current() for the same class of reason (a
// CreateProcessAsUser race poisoning the cache — see lookupSIDWithRetry).
//
// user.Current() remains a best-effort fallback for the case where the uid
// has no passwd entry but the stdlib can still identify the process another
// way. It can still be poisoned, which is exactly why it is not tried first.
// That residual risk is accepted rather than fixed: reaching the fallback at
// all requires user.LookupId to fail on this process's own uid, and if a
// poisoned fallback then yields a stale username the broker rejects the auth
// outright — a loud failure, not a silent one. The uid itself never comes
// from the fallback, so the broker's uid-based authorization cannot widen.
func resolveUnixIdentity() (uint64, string, error) {
	uid := os.Getuid()

	u, err := currentUserLookupByID(strconv.Itoa(uid))
	if err == nil && u.Username != "" {
		return uint64(uid), u.Username, nil
	}
	lookupErr := err
	if lookupErr == nil {
		lookupErr = fmt.Errorf("uid %d resolved to an empty username", uid)
	}

	cu, fallbackErr := currentUserLookup()
	if fallbackErr != nil {
		return uint64(uid), "", fmt.Errorf("look up uid %d: %w (user.Current also failed: %v)", uid, lookupErr, fallbackErr)
	}
	// Trust the kernel uid over the passwd entry the fallback reports: the
	// broker authorises on the uid, so a mismatch must not silently widen it.
	return uint64(uid), cu.Username, nil
}
