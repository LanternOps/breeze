//go:build darwin && cgo

package desktop

/*
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <unistd.h>

// namedWindowVisible reports whether another process's on-screen window
// carries a title. The window server fills kCGWindowName for other
// processes' windows only when this process holds the Screen Recording grant
// (macOS 10.15+). This is a metadata query: it does not capture a frame and
// does not go through replayd, so it cannot raise the screen-capture
// acknowledgement alert (#8390). Dock and WindowServer windows are skipped:
// their names are visible regardless of the grant.
static int namedWindowVisible(void) {
    CFArrayRef windows = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (windows == NULL) {
        return 0;
    }
    pid_t self = getpid();
    int found = 0;
    CFIndex n = CFArrayGetCount(windows);
    for (CFIndex i = 0; i < n && !found; i++) {
        CFDictionaryRef w = (CFDictionaryRef)CFArrayGetValueAtIndex(windows, i);
        CFNumberRef pidRef = (CFNumberRef)CFDictionaryGetValue(w, kCGWindowOwnerPID);
        int pid = 0;
        if (pidRef != NULL) {
            CFNumberGetValue(pidRef, kCFNumberIntType, &pid);
        }
        if (pid == self || pid <= 0) {
            continue;
        }
        CFStringRef owner = (CFStringRef)CFDictionaryGetValue(w, kCGWindowOwnerName);
        if (owner != NULL && (CFEqual(owner, CFSTR("Window Server")) || CFEqual(owner, CFSTR("Dock")))) {
            continue;
        }
        CFStringRef name = (CFStringRef)CFDictionaryGetValue(w, kCGWindowName);
        if (name != NULL && CFStringGetLength(name) > 0) {
            found = 1;
        }
    }
    CFRelease(windows);
    return found;
}
*/
import "C"

import "log/slog"

// namedWindowVisibleFn is a seam so tests never query the window server.
var namedWindowVisibleFn = func() bool { return C.namedWindowVisible() != 0 }

// preflightUnreliable is true on macOS 26+ (Darwin 25+), where
// CGPreflightScreenCaptureAccess can report false while the grant is present
// for the bare helper binary.
func preflightUnreliable() bool { return macOSMajorVersion >= 25 }

var captureAccessUnverifiedWarned bool

// CheckCaptureAccess is the non-capturing Screen Recording access check for
// the helper's permission checks (#8390): the TCC check loop, the connect-time
// capability probe, the background re-probe and the startup log. It never
// opens a capturer. The one real capture happens when a session opens its
// capturer (newPlatformCapturer) or an operator runs the CLI probe.
//
// At the login window and on macOS 12/13 preflight alone decides: there is
// no ScreenCaptureKit session to learn from and no other-app window to read.
func CheckCaptureAccess(config CaptureConfig) CaptureAccessReport {
	signals := captureAccessSignals{preflight: screenRecordingPreflight}
	if config.DesktopContext != "login_window" && hasSCScreenshotManager() {
		signals.preflightUnreliable = preflightUnreliable()
		signals.namedWindowVisible = namedWindowVisibleFn
		signals.lastSessionCaptured = sckPolicy.lastSessionCaptured
	}
	report := checkCaptureAccess(signals)
	logCaptureAccessOnce(report, &captureAccessUnverifiedWarned)
	return report
}

// logCaptureAccessOnce keeps the unverified-state explanation to one line per
// process: the TCC loop checks every few minutes.
func logCaptureAccessOnce(r CaptureAccessReport, warned *bool) {
	if r.State == CaptureAccessUnknown && !*warned {
		*warned = true
		slog.Warn("Screen Recording access could not be verified without capturing: preflight reports no grant " +
			"(macOS 26 can report false while the grant is present), no other app's titled window is on screen, " +
			"and no session has captured yet; a session will be allowed and its own capture decides")
	}
}
