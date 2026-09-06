package userhelper

import (
	"errors"
	"os"
	"os/user"
	"runtime"
	"testing"
)

// The reconnect supervisor keeps one process alive across many auth attempts,
// so any memoized failure in identity lookup becomes permanent instead of
// being cleared by the respawn that used to follow every IPC error. These
// tests pin the two properties that protects: the lookup is retried for real
// on every call, and a transient failure does not poison later attempts.
func TestResolveUnixIdentityRetriesAfterATransientFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("resolveUnixIdentity is only used on the non-Windows auth path")
	}

	restore := currentUserLookupByID
	restoreFallback := currentUserLookup
	t.Cleanup(func() {
		currentUserLookupByID = restore
		currentUserLookup = restoreFallback
	})

	// The fallback must not paper over the seam under test.
	currentUserLookup = func() (*user.User, error) {
		return nil, errors.New("fallback unavailable")
	}

	var calls int
	currentUserLookupByID = func(uid string) (*user.User, error) {
		calls++
		if calls == 1 {
			return nil, errors.New("transient: user database not ready")
		}
		return &user.User{Uid: uid, Username: "consoleuser"}, nil
	}

	if _, _, err := resolveUnixIdentity(); err == nil {
		t.Fatal("expected the first lookup to fail")
	}

	// A second call must perform a real lookup, not replay the cached error.
	// user.Current() memoizes both its value and its error in a process-wide
	// sync.Once, which is exactly why this code must not use it.
	uid, username, err := resolveUnixIdentity()
	if err != nil {
		t.Fatalf("second lookup should have succeeded, got %v", err)
	}
	if calls != 2 {
		t.Errorf("expected 2 real lookups, got %d", calls)
	}
	if username != "consoleuser" {
		t.Errorf("username = %q, want %q", username, "consoleuser")
	}
	if uid != uint64(os.Getuid()) {
		t.Errorf("uid = %d, want %d", uid, os.Getuid())
	}
}

// The load-bearing property is the ORDER: the non-memoizing uid lookup must
// be the primary path and user.Current() only a fallback. If that order ever
// flips back, a single early failure is cached for the life of the process
// and the reconnect loop can never authenticate again.
func TestResolveUnixIdentityPrefersTheNonMemoizingLookup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("resolveUnixIdentity is only used on the non-Windows auth path")
	}

	restore := currentUserLookupByID
	restoreFallback := currentUserLookup
	t.Cleanup(func() {
		currentUserLookupByID = restore
		currentUserLookup = restoreFallback
	})

	// Both seams would succeed, and they disagree — so the username proves
	// which one was consulted, and the call count proves the memoizing one
	// was not touched at all.
	currentUserLookupByID = func(uid string) (*user.User, error) {
		return &user.User{Uid: uid, Username: "from-lookupid"}, nil
	}
	var fallbackCalls int
	currentUserLookup = func() (*user.User, error) {
		fallbackCalls++
		return &user.User{Uid: "501", Username: "from-current"}, nil
	}

	_, username, err := resolveUnixIdentity()
	if err != nil {
		t.Fatalf("resolveUnixIdentity failed: %v", err)
	}
	if username != "from-lookupid" {
		t.Errorf("username = %q, want %q — user.Current() must not be the primary lookup", username, "from-lookupid")
	}
	if fallbackCalls != 0 {
		t.Errorf("user.Current() was called %d times; it must not run when the uid lookup succeeds, "+
			"because its sync.Once caches failures for the life of the process", fallbackCalls)
	}
}

func TestResolveUnixIdentityFallsBackToCurrentUser(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("resolveUnixIdentity is only used on the non-Windows auth path")
	}

	restore := currentUserLookupByID
	restoreFallback := currentUserLookup
	t.Cleanup(func() {
		currentUserLookupByID = restore
		currentUserLookup = restoreFallback
	})

	currentUserLookupByID = func(string) (*user.User, error) {
		return nil, errors.New("no passwd entry")
	}
	var fallbackCalls int
	currentUserLookup = func() (*user.User, error) {
		fallbackCalls++
		return &user.User{Uid: "501", Username: "fallbackuser"}, nil
	}

	uid, username, err := resolveUnixIdentity()
	if err != nil {
		t.Fatalf("expected the fallback to succeed, got %v", err)
	}
	if fallbackCalls != 1 {
		t.Errorf("fallback called %d times, want 1", fallbackCalls)
	}
	if username != "fallbackuser" {
		t.Errorf("username = %q, want %q", username, "fallbackuser")
	}
	if uid != uint64(os.Getuid()) {
		t.Errorf("uid = %d, want %d (the kernel uid always wins over the passwd entry)", uid, os.Getuid())
	}
}

func TestResolveUnixIdentityReportsErrorWhenBothLookupsFail(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("resolveUnixIdentity is only used on the non-Windows auth path")
	}

	restore := currentUserLookupByID
	restoreFallback := currentUserLookup
	t.Cleanup(func() {
		currentUserLookupByID = restore
		currentUserLookup = restoreFallback
	})

	currentUserLookupByID = func(string) (*user.User, error) {
		return nil, errors.New("no passwd entry")
	}
	currentUserLookup = func() (*user.User, error) {
		return nil, errors.New("fallback unavailable")
	}

	if _, _, err := resolveUnixIdentity(); err == nil {
		t.Fatal("expected an error when both lookups fail")
	}
}

// Real-environment smoke check: the production seams must actually resolve
// this process's identity, so the tests above cannot pass vacuously against
// stubs that never match reality.
func TestResolveUnixIdentityResolvesTheRealProcessUser(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("resolveUnixIdentity is only used on the non-Windows auth path")
	}

	uid, username, err := resolveUnixIdentity()
	if err != nil {
		t.Fatalf("resolveUnixIdentity failed for the real process: %v", err)
	}
	if uid != uint64(os.Getuid()) {
		t.Errorf("uid = %d, want %d", uid, os.Getuid())
	}
	if username == "" {
		t.Error("username must not be empty; authenticate() rejects an empty username")
	}
	if cu, cerr := user.Current(); cerr == nil && cu.Username != username {
		t.Errorf("username = %q, want %q (must agree with user.Current on a healthy box)", username, cu.Username)
	}
}
