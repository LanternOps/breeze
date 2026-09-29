//go:build windows

package desktop

import (
	"log/slog"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	dpiShcore                         = windows.NewLazySystemDLL("shcore.dll")
	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDpiAwarenessShcore  = dpiShcore.NewProc("SetProcessDpiAwareness")
	procSetProcessDPIAwareLegacy      = user32.NewProc("SetProcessDPIAware")

	procGetDpiAwarenessContextForProcess    = user32.NewProc("GetDpiAwarenessContextForProcess")
	procGetThreadDpiAwarenessContext        = user32.NewProc("GetThreadDpiAwarenessContext")
	procGetAwarenessFromDpiAwarenessContext = user32.NewProc("GetAwarenessFromDpiAwarenessContext")
	procAreDpiAwarenessContextsEqual        = user32.NewProc("AreDpiAwarenessContextsEqual")
	procGetProcessDpiAwarenessShcore        = dpiShcore.NewProc("GetProcessDpiAwareness")
)

// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is the pseudo-handle (HANDLE)-4.
// A negative constant cannot be converted to uintptr directly, so go through a
// signed variable and let the two's-complement bit pattern carry over.
var dpiAwarenessContextPerMonitorAwareV2 = func() uintptr {
	v := int64(-4)
	return uintptr(v)
}()

// PROCESS_PER_MONITOR_DPI_AWARE for shcore!SetProcessDpiAwareness (Win 8.1+).
const processPerMonitorDPIAware = 2

// The DPI mode must be fixed before any user32 call that depends on it
// (GetSystemMetrics, SetCursorPos, GetCursorInfo, monitor enumeration), so it
// runs in package init like the SetProcessDPIAware call it replaces.
//
// Shipped breeze-agent/breeze-user-helper binaries declare per-monitor-v2 in
// their manifest, which fixes the mode before init runs; the set calls are the
// fallback for binaries built without it (dev builds). The reported mode is
// always read back from Windows when a query API exists — see
// resolveDPIAwareness.
func init() {
	processDPIMode, processDPISource = resolveDPIAwareness(
		func() (string, bool) { return queryEffectiveDPIMode(windowsDPIQueryAPIs()) },
		elevateDPIAwareness,
	)
	if !dpiModeMisplacesInput(processDPIMode) {
		slog.Debug("Process DPI awareness", "mode", processDPIMode, "source", processDPISource)
		return
	}
	// Anything weaker means multi-monitor input/cursor coordinates will be
	// DPI-virtualized on monitors whose scale differs from the primary.
	slog.Warn("Process DPI awareness is not per-monitor; input on secondary monitors with a different scale factor will be misplaced",
		"mode", processDPIMode, "source", processDPISource)
}

// elevateDPIAwareness tries the per-monitor-v2, per-monitor and system set
// calls in order and returns the mode of the first that succeeded.
func elevateDPIAwareness() string {
	return chooseDPIAwareness(
		func() bool {
			if procSetProcessDpiAwarenessContext.Find() != nil {
				return false // pre-1607 Windows 10
			}
			// 1607 exports the API but rejects the V2 context (added in 1703);
			// that surfaces as a FALSE return and falls through to shcore.
			ret, _, _ := procSetProcessDpiAwarenessContext.Call(dpiAwarenessContextPerMonitorAwareV2)
			return ret != 0
		},
		func() bool {
			if procSetProcessDpiAwarenessShcore.Find() != nil {
				return false // pre-8.1
			}
			hr, _, _ := procSetProcessDpiAwarenessShcore.Call(uintptr(processPerMonitorDPIAware))
			return hresultSucceeded(hr) // S_OK; E_ACCESSDENIED if already set
		},
		func() bool {
			if procSetProcessDPIAwareLegacy.Find() != nil {
				return false
			}
			ret, _, _ := procSetProcessDPIAwareLegacy.Call()
			return ret != 0
		},
	)
}

// windowsDPIQueryAPIs binds dpiQueryAPIs to the Win32 exports this build of
// Windows has, leaving the rest nil.
func windowsDPIQueryAPIs() dpiQueryAPIs {
	var apis dpiQueryAPIs
	// All three context helpers arrived together in 1607.
	if procGetAwarenessFromDpiAwarenessContext.Find() == nil &&
		procAreDpiAwarenessContextsEqual.Find() == nil &&
		procGetThreadDpiAwarenessContext.Find() == nil {
		apis.awarenessFromContext = func(ctx uintptr) int32 {
			r, _, _ := procGetAwarenessFromDpiAwarenessContext.Call(ctx)
			return int32(uint32(r)) // DPI_AWARENESS is an int enum; -1 = invalid
		}
		apis.isPerMonitorV2 = func(ctx uintptr) bool {
			r, _, _ := procAreDpiAwarenessContextsEqual.Call(ctx, dpiAwarenessContextPerMonitorAwareV2)
			return r != 0
		}
		apis.threadContext = func() (uintptr, bool) {
			r, _, _ := procGetThreadDpiAwarenessContext.Call()
			return r, r != 0
		}
		if procGetDpiAwarenessContextForProcess.Find() == nil { // 1803+
			apis.processContext = func() (uintptr, bool) {
				r, _, _ := procGetDpiAwarenessContextForProcess.Call(0) // NULL = current process
				return r, r != 0
			}
		}
	}
	if procGetProcessDpiAwarenessShcore.Find() == nil { // 8.1+
		apis.processAwareness = func() (uint32, bool) {
			var v uint32
			hr, _, _ := procGetProcessDpiAwarenessShcore.Call(0, uintptr(unsafe.Pointer(&v))) // NULL = current process
			return v, hresultSucceeded(hr)
		}
	}
	return apis
}
