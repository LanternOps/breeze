//go:build windows

package userhelper

import (
	"fmt"
	"time"

	"golang.org/x/sys/windows"
)

// lookupSIDWithRetry returns the current process's SID as a string, retrying
// with backoff if the token isn't fully materialized yet. Freshly-spawned
// helpers (CreateProcessAsUser from a different session) can observe an
// empty/malformed SID for the first few hundred ms while the kernel finishes
// setting up the duplicated token.
//
// Backoff schedule: 0, 100ms, 250ms, 500ms, 1s — total < 2s.
//
// We deliberately bypass Go's os/user package here: user.Current() caches
// its result via sync.Once, so a single early failure poisons every retry
// with the same stale error. Calling OpenProcessToken + GetTokenUser each
// attempt actually re-queries the kernel.
func lookupSIDWithRetry() (string, error) {
	delays := []time.Duration{0, 100 * time.Millisecond, 250 * time.Millisecond, 500 * time.Millisecond, 1 * time.Second}

	var lastErr error
	for i, d := range delays {
		if d > 0 {
			time.Sleep(d)
		}
		sid, err := queryProcessSID()
		if err != nil {
			lastErr = err
			log.Warn("SID lookup: token query failed",
				"attempt", i+1,
				"error", err.Error(),
			)
			continue
		}
		if looksLikeSID(sid) {
			if i > 0 {
				log.Info("SID lookup: succeeded after retries", "attempts", i+1, "sid", sid)
			}
			return sid, nil
		}
		lastErr = fmt.Errorf("token returned non-SID string %q", sid)
		log.Warn("SID lookup: token SID not SID-shaped",
			"attempt", i+1,
			"sid", sid,
		)
	}
	if lastErr == nil {
		lastErr = ErrSIDLookupFailed
	}
	return "", fmt.Errorf("%w: last error: %v", ErrSIDLookupFailed, lastErr)
}

// queryProcessSID opens the current process token and returns its user SID
// as a string. No caching — every call hits the kernel.
func queryProcessSID() (string, error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return "", fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer token.Close()

	tokenUser, err := token.GetTokenUser()
	if err != nil {
		return "", fmt.Errorf("GetTokenUser: %w", err)
	}
	return tokenUser.User.Sid.String(), nil
}

// lookupUsernameDirect returns the current process's username in
// DOMAIN\user (SAM) format, querying secur32 directly rather than via
// os/user — same sync.Once cache trap as lookupSIDWithRetry.
func lookupUsernameDirect() (string, error) {
	// GetUserNameExW signals a too-small buffer with ERROR_MORE_DATA (234),
	// not ERROR_INSUFFICIENT_BUFFER — unlike most Win32 sizing APIs.
	n := uint32(256)
	for attempt := 0; attempt < 5; attempt++ {
		buf := make([]uint16, n)
		err := windows.GetUserNameEx(windows.NameSamCompatible, &buf[0], &n)
		if err == nil {
			name := windows.UTF16ToString(buf[:n])
			if name == "" {
				return "", fmt.Errorf("GetUserNameEx: returned empty username")
			}
			return name, nil
		}
		if err != windows.ERROR_MORE_DATA {
			return "", fmt.Errorf("GetUserNameEx: %w", err)
		}
		if n <= uint32(len(buf)) {
			return "", fmt.Errorf("GetUserNameEx: buffer size did not grow (n=%d)", n)
		}
	}
	return "", fmt.Errorf("GetUserNameEx: exceeded buffer-growth retries")
}
