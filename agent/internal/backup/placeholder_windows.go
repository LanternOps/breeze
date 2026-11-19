//go:build windows

package backup

import (
	"runtime"

	"golang.org/x/sys/windows"
)

// Placeholder compatibility mode (#7326). Since Windows 10 1803 a process or
// thread is either shown cloud placeholders as they are
// (PHCM_EXPOSE_PLACEHOLDERS) or shown them disguised as plain files
// (PHCM_DISGUISE_PLACEHOLDER), with the reparse point and the offline and
// sparse bits hidden. Microsoft documents that most applications see
// placeholders exposed and that Windows may disguise them for some
// applications. The CI runner's default resolved to disguised, with only
// RECALL_ON_DATA_ACCESS still visible. The walk sets its own thread to expose
// placeholders, so the policy does not depend on which bits a disguised view
// keeps.
var (
	modNtdll                                       = windows.NewLazySystemDLL("ntdll.dll")
	procRtlSetThreadPlaceholderCompatibilityMode   = modNtdll.NewProc("RtlSetThreadPlaceholderCompatibilityMode")
	procRtlQueryThreadPlaceholderCompatibilityMode = modNtdll.NewProc("RtlQueryThreadPlaceholderCompatibilityMode")
)

const phcmExposePlaceholders = 2

// exposePlaceholdersForWalk locks the calling goroutine to its OS thread and
// sets that thread to expose placeholders until release is called. The walk
// runs synchronously on this goroutine, so every directory listing and stat
// it makes sees placeholders as they are. Before Windows 10 1803 the call does
// not exist, and neither does disguising, so it is a no-op there. release must
// be called on the same goroutine (defer it).
func exposePlaceholdersForWalk() (release func()) {
	if procRtlSetThreadPlaceholderCompatibilityMode.Find() != nil {
		return func() {}
	}
	runtime.LockOSThread()
	r, _, _ := procRtlSetThreadPlaceholderCompatibilityMode.Call(phcmExposePlaceholders)
	prev := int8(uint8(r))
	if prev < 0 {
		runtime.UnlockOSThread()
		log.Warn("could not expose cloud placeholders to the backup scan; an unhydrated placeholder may look like a local file",
			"phcmError", int(prev))
		return func() {}
	}
	return func() {
		_, _, _ = procRtlSetThreadPlaceholderCompatibilityMode.Call(uintptr(uint8(prev)))
		runtime.UnlockOSThread()
	}
}

// threadPlaceholderCompatibilityMode returns the calling thread's placeholder
// compatibility mode, or -1 when the call does not exist. Tests use it.
func threadPlaceholderCompatibilityMode() int8 {
	if procRtlQueryThreadPlaceholderCompatibilityMode.Find() != nil {
		return -1
	}
	r, _, _ := procRtlQueryThreadPlaceholderCompatibilityMode.Call()
	return int8(uint8(r))
}
