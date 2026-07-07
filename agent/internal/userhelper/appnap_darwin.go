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
// suspended (issue #2273). Idempotent: a second call is a no-op.
//
// Option choice — NSActivityUserInitiatedAllowingIdleSystemSleep:
//   * It suppresses App Nap and sudden/automatic termination, which is the
//     behavior that was suspending the helper and causing the broker to evict
//     it on the ~60s keepalive timeout.
//   * It deliberately does NOT set NSActivityIdleSystemSleepDisabled. The
//     helper is an always-on background LaunchAgent; holding an
//     idle-system-sleep-disabling assertion for the entire process lifetime
//     would stop a laptop from ever idle-sleeping and needlessly drain the
//     battery. Normal system sleep (idle timeout, lid close) is still allowed;
//     when the machine sleeps the broker sleeps with it, so no keepalive is
//     due anyway.
static void beginActivityAssertion(void) {
	if (activityToken != nil) {
		return;
	}
	activityToken = [[NSProcessInfo processInfo]
		beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep
		reason:@"Breeze desktop helper IPC keepalive"];
}
*/
import "C"

// guardAgainstAppNap takes a process-lifetime NSProcessInfo activity assertion
// so macOS App Nap does not throttle or suspend the helper's IPC + keepalive
// goroutines (issue #2273). Safe to call once at helper startup; the underlying
// assertion is idempotent and held until the process exits.
//
// This is a best-effort OS-behavior mitigation and is not unit-testable in a
// meaningful way (it asserts against the OS scheduler); the load-bearing,
// tested fix for the eviction is the ipc.Conn.Send write deadline.
func guardAgainstAppNap() {
	C.beginActivityAssertion()
	log.Info("macOS App Nap guard active — holding NSProcessInfo activity assertion for process lifetime")
}
