//go:build darwin && cgo

package yarac

/*
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecTask.h>

// csops is exported by libSystem but has no public header (xnu
// bsd/sys/codesign.h). CS_OPS_STATUS = 0.
extern int csops(pid_t pid, unsigned int ops, void *useraddr, size_t usersize);

static int breeze_cs_status(uint32_t *flags) {
	return csops(getpid(), 0, flags, sizeof(*flags));
}

// 1: the entitlement is present and boolean true; 0: absent or not true;
// -1: SecTask could not be created.
static int breeze_entitlement_true(const char *name) {
	SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
	if (task == NULL) {
		return -1;
	}
	CFStringRef key = CFStringCreateWithCString(kCFAllocatorDefault, name, kCFStringEncodingUTF8);
	if (key == NULL) {
		CFRelease(task);
		return -1;
	}
	int out = 0;
	CFTypeRef value = SecTaskCopyValueForEntitlement(task, key, NULL);
	if (value != NULL) {
		if (CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value)) {
			out = 1;
		}
		CFRelease(value);
	}
	CFRelease(key);
	CFRelease(task);
	return out;
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// xnu bsd/sys/codesign.h. CS_KILL (0x200) is deliberately not one of them:
// arm64 sets it on every linker-signed `go build` binary (csops status
// 0x22020201), and those run the engine fine. What gets an anonymous r-x page
// killed is enforcement — CS_HARD / CS_ENFORCEMENT, which the hardened
// runtime turns on (0x22011311 for the same binary re-signed with
// --options runtime).
const (
	csHard        = 0x00000100
	csEnforcement = 0x00001000
	csRuntime     = 0x00010000
)

func platformCodeSigning() (codeSigning, error) {
	var flags C.uint32_t
	if rc, err := C.breeze_cs_status(&flags); rc != 0 {
		return codeSigning{}, fmt.Errorf("csops(CS_OPS_STATUS) failed: %v", err)
	}
	cs := codeSigning{enforced: uint32(flags)&(csRuntime|csHard|csEnforcement) != 0}
	for name, dst := range map[string]*bool{
		EntitlementAllowUnsignedExecutableMemory:   &cs.allowUnsignedExecutableMemory,
		entitlementDisableExecutablePageProtection: &cs.disableExecutablePageProtection,
		entitlementAllowJIT:                        &cs.allowJIT,
	} {
		v, err := entitlementTrue(name)
		if err != nil {
			return codeSigning{}, err
		}
		*dst = v
	}
	return cs, nil
}

func entitlementTrue(name string) (bool, error) {
	cname := C.CString(name)
	defer C.free(unsafe.Pointer(cname))
	switch C.breeze_entitlement_true(cname) {
	case 1:
		return true, nil
	case 0:
		return false, nil
	default:
		return false, fmt.Errorf("SecTaskCreateFromSelf failed reading %s", name)
	}
}
