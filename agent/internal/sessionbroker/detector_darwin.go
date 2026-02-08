//go:build darwin

package sessionbroker

/*
#cgo LDFLAGS: -framework SystemConfiguration -framework CoreFoundation
#include <SystemConfiguration/SystemConfiguration.h>
#include <CoreFoundation/CoreFoundation.h>

// getConsoleUser returns the current console user's username and UID.
static int getConsoleUser(char *buf, int bufsize, unsigned int *uid) {
    CFStringRef username = SCDynamicStoreCopyConsoleUser(NULL, (uid_t *)uid, NULL);
    if (username == NULL) return 0;
    Boolean ok = CFStringGetCString(username, buf, bufsize, kCFStringEncodingUTF8);
    CFRelease(username);
    return ok ? 1 : 0;
}
*/
import "C"

import (
	"context"
	"time"
	"unsafe"
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
	if username == "loginwindow" || username == "" {
		return nil, nil
	}

	return []DetectedSession{
		{
			UID:      uint32(uid),
			Username: username,
			Session:  "console",
			Display:  "quartz",
			State:    "active",
		},
	}, nil
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
			lastUser = C.GoString((*C.char)(unsafe.Pointer(&buf[0])))
			lastUID = uint32(uid)
		}

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				var currentUser string
				var currentUID uint32

				if C.getConsoleUser(&buf[0], C.int(len(buf)), &uid) != 0 {
					currentUser = C.GoString((*C.char)(unsafe.Pointer(&buf[0])))
					currentUID = uint32(uid)
				}

				if currentUser == "loginwindow" {
					currentUser = ""
				}

				if currentUser != lastUser {
					if lastUser != "" {
						ch <- SessionEvent{
							Type:     SessionLogout,
							UID:      lastUID,
							Username: lastUser,
							Session:  "console",
						}
					}
					if currentUser != "" {
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
