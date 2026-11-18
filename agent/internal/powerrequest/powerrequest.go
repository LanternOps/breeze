// Package powerrequest keeps the device from idle-sleeping while long work
// runs (#12193). On Windows it holds a system-required power request
// (PowerCreateRequest + PowerSetRequest(PowerRequestSystemRequired)); on other
// platforms HoldSystemAwake is a no-op.
//
// A power request blocks idle sleep only. A user-initiated sleep (Start >
// Sleep, closing a laptop lid set to sleep), a critical-battery action and a
// shutdown still happen. The request is a handle, not thread state like
// SetThreadExecutionState, so it does not depend on which OS thread the
// calling goroutine runs on, and Windows drops it when the process exits.
package powerrequest

// HoldSystemAwake asks the OS to keep the system out of idle sleep until the
// returned release is called. reason is the text Windows shows for the
// request in `powercfg /requests`. release is safe to call more than once and
// from any goroutine. On error nothing is held and release is nil.
func HoldSystemAwake(reason string) (release func(), err error) {
	return holdSystemAwake(reason)
}
