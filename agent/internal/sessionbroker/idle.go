package sessionbroker

import (
	"math"
	"strconv"
	"strings"
	"time"
)

// filetimeEpochDiff100ns is the number of 100ns intervals between the Windows
// FILETIME epoch (1601-01-01 UTC) and the Unix epoch (1970-01-01 UTC).
const filetimeEpochDiff100ns = 116444736000000000

// filetimeToTime converts a Windows FILETIME value (100ns intervals since
// 1601-01-01 UTC) to a time.Time. A zero FILETIME — which WTSSessionInfoEx
// reports for sessions with no recorded input, notably the physical console on
// some Windows versions — maps to the zero time so callers treat it as
// unknown rather than "idle since 1601".
func filetimeToTime(ft uint64) time.Time {
	if ft == 0 {
		return time.Time{}
	}
	return time.Unix(0, (int64(ft)-filetimeEpochDiff100ns)*100).UTC()
}

// idleSince computes how long a session has been idle given the current wall
// clock and the time of last user input. known=false means no idle data —
// callers must never conflate that with "0 minutes idle".
func idleSince(now, lastInput time.Time) (idle time.Duration, known bool) {
	if lastInput.IsZero() {
		return 0, false
	}
	d := now.Sub(lastInput)
	if d < 0 {
		d = 0
	}
	return d, true
}

// parseIdleSinceHint parses loginctl's IdleSinceHint property, which systemd
// prints either as raw microseconds since the Unix epoch or, in some
// versions, as a formatted timestamp.
func parseIdleSinceHint(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" || value == "0" {
		return time.Time{}, false
	}
	if usec, err := strconv.ParseUint(value, 10, 64); err == nil {
		if usec > math.MaxInt64/1000 {
			return time.Time{}, false
		}
		return time.Unix(0, int64(usec)*1000).UTC(), true
	}
	if t, err := time.Parse("Mon 2006-01-02 15:04:05 MST", value); err == nil {
		return t, true
	}
	return time.Time{}, false
}
