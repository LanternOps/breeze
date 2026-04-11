package userhelper

import (
	"errors"
	"fmt"
	"strings"
)

// looksLikeSID returns true if s is plausibly a Windows SID string.
// Shape check only — does not validate semantics.
func looksLikeSID(s string) bool {
	return strings.HasPrefix(s, "S-1-") && len(s) >= 7
}

// ErrSIDLookupFailed is returned when the Windows SID for the current
// process token cannot be determined after several retries. This usually
// indicates a cross-session process spawn (CreateProcessAsUser) where the
// freshly-duplicated token has not yet been fully materialized by the kernel.
// Treated as fatal by the reconnect loop — the helper exits with code 2 so
// the lifecycle manager can back off.
var ErrSIDLookupFailed = errors.New("userhelper: failed to determine Windows SID after retries")

// PermanentRejectError is returned by Client.Run when the broker has
// permanently rejected the helper's identity. The reconnect loop treats this
// as fatal: the helper process exits with code 2 and the lifecycle manager
// skips respawn for a cooldown period.
//
// Fields:
//   - Code: machine-readable reason (e.g. "binary_path_unknown", "sid_mismatch")
//   - Reason: human-readable explanation from the broker
type PermanentRejectError struct {
	Code   string
	Reason string
}

func (e *PermanentRejectError) Error() string {
	if e == nil {
		return "permanent reject"
	}
	if e.Code == "" {
		return fmt.Sprintf("broker permanently rejected helper: %s", e.Reason)
	}
	return fmt.Sprintf("broker permanently rejected helper: %s (%s)", e.Reason, e.Code)
}

// CodeOr returns the code, or the fallback if this error is nil or the code
// is empty. Convenient for logging without having to nil-check.
func (e *PermanentRejectError) CodeOr(fallback string) string {
	if e == nil || e.Code == "" {
		return fallback
	}
	return e.Code
}

// ReasonOr returns the reason, or the fallback if this error is nil or the
// reason is empty.
func (e *PermanentRejectError) ReasonOr(fallback string) string {
	if e == nil || e.Reason == "" {
		return fallback
	}
	return e.Reason
}
