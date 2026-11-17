package wire

// JSONMillis converts a millisecond count decoded from JSON (a float64) to
// int64. A non-positive or non-finite value is 0, meaning absent. A huge one
// saturates at 2^53 instead of wrapping: Go's conversion of an out-of-range
// float to an integer is implementation-defined and can come out negative,
// which would read as "absent" and silently select a fallback. Callers that
// need a tighter bound cap the result themselves.
func JSONMillis(v float64) int64 {
	const maxMillis = 1 << 53
	if !(v > 0) {
		return 0
	}
	if v > maxMillis {
		return maxMillis
	}
	return int64(v)
}
