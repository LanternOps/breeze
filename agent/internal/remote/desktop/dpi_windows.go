//go:build windows

package desktop

import (
	"log/slog"

	"golang.org/x/sys/windows"
)

var (
	dpiShcore                         = windows.NewLazySystemDLL("shcore.dll")
	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDpiAwarenessShcore  = dpiShcore.NewProc("SetProcessDpiAwareness")
	procSetProcessDPIAwareLegacy      = user32.NewProc("SetProcessDPIAware")
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
func init() {
	processDPIMode = chooseDPIAwareness(
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
	if processDPIMode == dpiModePerMonitorV2 || processDPIMode == dpiModePerMonitor {
		slog.Debug("Process DPI awareness set", "mode", processDPIMode)
		return
	}
	// Anything weaker means multi-monitor input/cursor coordinates will be
	// DPI-virtualized on monitors whose scale differs from the primary.
	slog.Warn("Process DPI awareness is not per-monitor; input on secondary monitors with a different scale factor will be misplaced",
		"mode", processDPIMode)
}
