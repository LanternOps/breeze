//go:build windows

package userhelper

import (
	"fmt"
	"os/user"
	"time"
)

// lookupSIDWithRetry returns the current process's SID as a string, retrying
// with backoff if the token isn't fully materialized yet. Freshly-spawned
// helpers (CreateProcessAsUser from a different session) can observe an
// empty/malformed SID for the first few hundred ms while the kernel finishes
// setting up the duplicated token.
//
// Backoff schedule: 100ms, 250ms, 500ms, 1s — total < 2s.
func lookupSIDWithRetry() (string, error) {
	delays := []time.Duration{0, 100 * time.Millisecond, 250 * time.Millisecond, 500 * time.Millisecond, 1 * time.Second}

	var lastErr error
	for i, d := range delays {
		if d > 0 {
			time.Sleep(d)
		}
		cu, err := user.Current()
		if err != nil {
			lastErr = err
			log.Warn("SID lookup: user.Current failed",
				"attempt", i+1,
				"error", err.Error(),
			)
			continue
		}
		// On Windows, cu.Uid is the SID string: "S-1-5-..."
		if looksLikeSID(cu.Uid) {
			if i > 0 {
				log.Info("SID lookup: succeeded after retries", "attempts", i+1, "sid", cu.Uid)
			}
			return cu.Uid, nil
		}
		lastErr = fmt.Errorf("user.Current returned non-SID Uid %q", cu.Uid)
		log.Warn("SID lookup: Uid not SID-shaped",
			"attempt", i+1,
			"uid", cu.Uid,
		)
	}
	if lastErr == nil {
		lastErr = ErrSIDLookupFailed
	}
	return "", fmt.Errorf("%w: last error: %v", ErrSIDLookupFailed, lastErr)
}

