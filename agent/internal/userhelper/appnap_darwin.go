//go:build darwin && cgo

package userhelper

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Foundation

#include <Foundation/Foundation.h>

// activityToken holds the NSProcessInfo activity assertion for the lifetime of
// the process. Under ARC a file-static strong id retains its object, and a
// static lives for the whole process, so this reference is never released —
// which is exactly what we want: the assertion must stay in effect the entire
// time the helper runs.
static id<NSObject> activityToken = nil;

// beginActivityAssertion asks macOS to exempt this process from App Nap so the
// IPC read loop and its keepalive TypePong reply are never throttled or
// suspended (issue #2273). Idempotent: a second call is a no-op. Returns 1 if
// the assertion is held (newly taken or already held from a prior call), 0 if
// macOS declined to provide one.
//
// Option choice — NSActivityUserInitiatedAllowingIdleSystemSleep:
//   * It suppresses App Nap and sudden/automatic termination, which is the
//     behavior that was suspending the helper. A suspended helper stops
//     answering the broker's keepalive pings, so the broker closes the session
//     once no pong has arrived within its ~45s keepalive timeout (observed in
//     the field as a ~60s eviction age, since the broker only checks on its
//     30s ping tick).
//   * It deliberately does NOT set NSActivityIdleSystemSleepDisabled. The
//     helper is an always-on background LaunchAgent; holding an
//     idle-system-sleep-disabling assertion for the entire process lifetime
//     would stop a laptop from ever idle-sleeping and needlessly drain the
//     battery. Normal system sleep (idle timeout, lid close) is still allowed;
//     when the machine sleeps the broker sleeps with it, so no keepalive is
//     due anyway.
static int beginActivityAssertion(void) {
	if (activityToken != nil) {
		return 1;
	}
	activityToken = [[NSProcessInfo processInfo]
		beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep
		reason:@"Breeze desktop helper IPC keepalive"];
	return activityToken != nil ? 1 : 0;
}
*/
import "C"

import "sync/atomic"

// appNapLogged ensures the "guard active" success line is logged only once even
// if guardAgainstAppNap is ever called more than once in a single process.
var appNapLogged atomic.Bool

// guardAgainstAppNap takes a process-lifetime NSProcessInfo activity assertion
// so macOS App Nap does not throttle or suspend the helper's IPC + keepalive
// goroutines (issue #2273). Safe to call once at helper startup; the underlying
// assertion is idempotent and held until the process exits.
//
// This is a best-effort OS-behavior mitigation and is not unit-testable in a
// meaningful way (it asserts against the OS scheduler); the load-bearing,
// tested fix for the eviction is the ipc.Conn.Send write deadline.
func guardAgainstAppNap() {
	if C.beginActivityAssertion() != 0 {
		if !appNapLogged.Swap(true) {
			log.Info("macOS App Nap guard active — holding NSProcessInfo activity assertion for process lifetime")
		}
		return
	}
	// Best-effort mitigation failed: macOS returned no activity assertion (a
	// sandbox/entitlement restriction or OS edge case). The helper may still be
	// throttled/suspended by App Nap. Surface this loudly so a recurrence of the
	// #2273 eviction is not misdiagnosed against a "guard active" log that would
	// otherwise be a lie. The write-deadline fix in ipc.Conn.Send remains the
	// load-bearing protection regardless.
	log.Warn("macOS App Nap guard could not take an NSProcessInfo activity assertion — helper may be throttled/suspended by App Nap (issue #2273)")
}
