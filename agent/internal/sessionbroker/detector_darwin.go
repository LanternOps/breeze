//go:build darwin && cgo

package sessionbroker

/*
#cgo LDFLAGS: -framework SystemConfiguration -framework CoreFoundation -framework IOKit
#include <SystemConfiguration/SystemConfiguration.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>

// getConsoleUser returns the current console user's username and UID.
static int getConsoleUser(char *buf, int bufsize, unsigned int *uid) {
    CFStringRef username = SCDynamicStoreCopyConsoleUser(NULL, (uid_t *)uid, NULL);
    if (username == NULL) return 0;
    Boolean ok = CFStringGetCString(username, buf, bufsize, kCFStringEncodingUTF8);
    CFRelease(username);
    return ok ? 1 : 0;
}

// getHIDIdleNanos reads the system-wide HID idle time (nanoseconds since last
// keyboard/mouse input) from the IOHIDSystem registry entry. Returns 0 on
// failure, 1 on success. Passing 0 as the master port targets the default
// port on all supported macOS versions.
static int getHIDIdleNanos(long long *ns) {
    io_service_t svc = IOServiceGetMatchingService(0, IOServiceMatching("IOHIDSystem"));
    if (!svc) return 0;
    CFTypeRef prop = IORegistryEntryCreateCFProperty(svc, CFSTR("HIDIdleTime"), kCFAllocatorDefault, 0);
    IOObjectRelease(svc);
    if (!prop) return 0;
    int ok = 0;
    if (CFGetTypeID(prop) == CFNumberGetTypeID()) {
        ok = CFNumberGetValue((CFNumberRef)prop, kCFNumberSInt64Type, ns);
    }
    CFRelease(prop);
    return ok;
}
*/
import "C"

import (
	"context"
	"time"
)

type darwinDetector struct{}

// NewSessionDetector creates a macOS session detector using SCDynamicStore.
func NewSessionDetector() SessionDetector {
	return &darwinDetector{}
}

func (d *darwinDetector) ListSessions() ([]DetectedSession, error) {
	var buf [256]C.char
	var uid C.uint

	ret := C.getConsoleUser(&buf[0], C.int(len(buf)), &uid)
	if ret == 0 {
		return nil, nil // No console user
	}

	username := C.GoString(&buf[0])
	if username == "" {
		return nil, nil
	}

	session, err := sanitizeDetectedSession(DetectedSession{
		UID:      uint32(uid),
		Username: username,
		Session:  "console",
		Display:  "quartz",
		State:    "active",
		Type:     "console",
	})
	if err != nil {
		return nil, err
	}

	var idleNs C.longlong
	if C.getHIDIdleNanos(&idleNs) != 0 && idleNs >= 0 {
		session.IdleFor = time.Duration(idleNs)
		session.IdleKnown = true
	}

	return []DetectedSession{session}, nil
}

func (d *darwinDetector) WatchSessions(ctx context.Context) <-chan SessionEvent {
	ch := make(chan SessionEvent, 8)

	go func() {
		defer close(ch)

		var buf [256]C.char
		var uid C.uint
		var lastUser string
		var lastUID uint32

		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		// Get initial state
		if C.getConsoleUser(&buf[0], C.int(len(buf)), &uid) != 0 {
			if session, err := sanitizeDetectedSession(DetectedSession{
				UID:      uint32(uid),
				Username: C.GoString(&buf[0]),
				Session:  "console",
				Display:  "quartz",
				State:    "active",
				Type:     "console",
			}); err == nil {
				lastUser = session.Username
				lastUID = session.UID
			}
		}

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				var currentUser string
				var currentUID uint32

				if C.getConsoleUser(&buf[0], C.int(len(buf)), &uid) != 0 {
					if session, err := sanitizeDetectedSession(DetectedSession{
						UID:      uint32(uid),
						Username: C.GoString(&buf[0]),
						Session:  "console",
						Display:  "quartz",
						State:    "active",
						Type:     "console",
					}); err == nil {
						currentUser = session.Username
						currentUID = session.UID
					}
				}

				if currentUser != lastUser {
					if lastUser != "" && lastUser != "loginwindow" {
						ch <- SessionEvent{
							Type:     SessionLogout,
							UID:      lastUID,
							Username: lastUser,
							Session:  "console",
						}
					}
					if currentUser != "" && currentUser != "loginwindow" {
						ch <- SessionEvent{
							Type:     SessionLogin,
							UID:      currentUID,
							Username: currentUser,
							Session:  "console",
							Display:  "quartz",
						}
					}
					lastUser = currentUser
					lastUID = currentUID
				}
			}
		}
	}()

	return ch
}
