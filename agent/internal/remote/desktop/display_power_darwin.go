//go:build darwin && cgo

package desktop

/*
#cgo LDFLAGS: -framework IOKit -framework CoreGraphics -framework CoreFoundation

#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/pwr_mgt/IOPMLib.h>
#include <stdint.h>

// breezeDisplayCounts reads the online display list (attached displays,
// sleeping ones included), how many of those are asleep, and the active
// (drawable) display count. Returns 0 on success.
static int breezeDisplayCounts(uint32_t *online, uint32_t *active, uint32_t *asleep) {
    CGDirectDisplayID ids[32];
    uint32_t n = 0;
    if (CGGetOnlineDisplayList(32, ids, &n) != kCGErrorSuccess) return 1;
    uint32_t sleeping = 0;
    for (uint32_t i = 0; i < n; i++) {
        if (CGDisplayIsAsleep(ids[i])) sleeping++;
    }
    uint32_t a = 0;
    if (CGGetActiveDisplayList(0, NULL, &a) != kCGErrorSuccess) return 1;
    *online = n;
    *asleep = sleeping;
    *active = a;
    return 0;
}

// breezeDeclareUserActivity is what `caffeinate -u` does: it powers a
// sleeping display on and restarts its idle timer. *id carries the previous
// call's assertion ID in, as IOPMLib.h asks repeat callers to do.
static IOReturn breezeDeclareUserActivity(IOPMAssertionID *id) {
    return IOPMAssertionDeclareUserActivity(CFSTR("Breeze remote desktop session"), kIOPMUserActiveLocal, id);
}

static IOReturn breezePreventDisplaySleep(IOPMAssertionID *id) {
    return IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleDisplaySleep,
        kIOPMAssertionLevelOn, CFSTR("Breeze remote desktop session"), id);
}

static IOReturn breezeReleaseAssertion(IOPMAssertionID id) {
    return IOPMAssertionRelease(id);
}
*/
import "C"

import (
	"fmt"
	"sync"
)

// darwinDisplayPower is the IOKit power-management and CoreGraphics
// display-list implementation of displayPowerOps (#10874). In-process cgo,
// not a `caffeinate` child: the assertion dies with the helper, so a crashed
// helper can never leave a customer's display pinned on.
type darwinDisplayPower struct {
	mu         sync.Mutex
	activityID C.IOPMAssertionID // reused across declarations, per IOPMLib.h
}

func newPlatformDisplayPower() displayPowerOps { return &darwinDisplayPower{} }

func (d *darwinDisplayPower) counts() (displayCounts, bool) {
	var online, active, asleep C.uint32_t
	if C.breezeDisplayCounts(&online, &active, &asleep) != 0 {
		return displayCounts{}, false
	}
	return displayCounts{online: int(online), active: int(active), asleep: int(asleep)}, true
}

func (d *darwinDisplayPower) declareUserActivity() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if rc := C.breezeDeclareUserActivity(&d.activityID); rc != 0 {
		return fmt.Errorf("IOPMAssertionDeclareUserActivity failed: IOReturn 0x%x", uint32(rc))
	}
	return nil
}

func (d *darwinDisplayPower) preventDisplaySleep() (func() error, error) {
	var id C.IOPMAssertionID
	if rc := C.breezePreventDisplaySleep(&id); rc != 0 {
		return nil, fmt.Errorf("IOPMAssertionCreateWithName(PreventUserIdleDisplaySleep) failed: IOReturn 0x%x", uint32(rc))
	}
	return func() error {
		if rc := C.breezeReleaseAssertion(id); rc != 0 {
			return fmt.Errorf("IOPMAssertionRelease failed: IOReturn 0x%x", uint32(rc))
		}
		return nil
	}, nil
}
