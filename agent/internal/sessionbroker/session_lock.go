package sessionbroker

// WTSINFOEX_LEVEL1.SessionFlags values (Windows 8 / Server 2012 and later;
// Windows 7 inverted them, but no supported build runs there).
const (
	wtsSessionStateLock   = 0
	wtsSessionStateUnlock = 1
)

// wtsLockState maps WTSINFOEX_LEVEL1.SessionFlags to (locked, known).
// WTS_SESSIONSTATE_UNKNOWN (-1) and anything unexpected stay unknown.
func wtsLockState(flags int32) (locked, known bool) {
	switch flags {
	case wtsSessionStateLock:
		return true, true
	case wtsSessionStateUnlock:
		return false, true
	default:
		return false, false
	}
}
