package desktop

// Process DPI-awareness mode names, reported once at startup so a helper log
// shows which coordinate space Win32 input/cursor calls are operating in.
const (
	dpiModePerMonitorV2 = "per-monitor-v2"
	dpiModePerMonitor   = "per-monitor"
	dpiModeSystem       = "system"
	dpiModeUnaware      = "unaware"
)

// processDPIMode is the effective awareness mode at init on Windows (read back
// from Windows, see resolveDPIAwareness); logged with the display offset so a
// helper log shows which coordinate space input and cursor calls used. Other
// platforms have no DPI virtualization.
var processDPIMode = "n/a"

// chooseDPIAwareness elevates the process to the strongest available DPI
// awareness and returns the mode of the first set call that succeeded. That is
// only an inference: when a manifest already fixed the mode every call fails,
// so resolveDPIAwareness prefers reading the effective mode back.
//
// Why this matters for remote desktop: DXGI Desktop Duplication reports every
// output's geometry in PHYSICAL pixels, and that geometry is what
// applyDisplayOffset feeds into SetDisplayOffset. But SetCursorPos, SendInput
// (MOUSEEVENTF_ABSOLUTE), GetCursorPos and GetSystemMetrics are DPI-virtualized
// for any process that is not per-monitor aware: a system-DPI-aware process
// gets physical coordinates only on monitors whose scale matches the primary.
// On a 150% laptop panel driving a 100% external monitor, input aimed at the
// external monitor lands ~1.5x off and the streamed cursor drifts the same way
// — the primary works perfectly, the secondary is unusable (JONAH, 2026-09-10).
// Per-monitor awareness (v2 preferred) makes all of those APIs physical on
// every monitor, matching DXGI.
//
// Each attempt is a func so the ordering is unit-testable without Win32. The
// first success wins: once the process mode is set, later calls fail with
// ERROR_ACCESS_DENIED, so we must not keep trying.
func chooseDPIAwareness(perMonitorV2, perMonitor, system func() bool) string {
	if perMonitorV2() {
		return dpiModePerMonitorV2
	}
	if perMonitor() {
		return dpiModePerMonitor
	}
	if system() {
		return dpiModeSystem
	}
	return dpiModeUnaware
}

// hresultSucceeded reports SUCCEEDED(hr) for a 32-bit HRESULT that came back
// through a uintptr. The sign bit lives in bit 31, so the value must be
// narrowed to int32 first: on amd64 0x80070005 (E_ACCESSDENIED, "awareness
// already set") is a positive int64 and would otherwise read as success.
func hresultSucceeded(hr uintptr) bool { return int32(uint32(hr)) >= 0 }

// dpiModeMisplacesInput reports whether the process runs in a Windows DPI mode
// weaker than per-monitor, where input and cursor coordinates are virtualized
// on mixed-scale monitors. A manifest (e.g. go-winres' default
// <dpiAware>true</dpiAware>) pins the mode before init runs, so this can be
// true even though chooseDPIAwareness asked for per-monitor-v2.
func dpiModeMisplacesInput(mode string) bool {
	return mode == dpiModeSystem || mode == dpiModeUnaware
}

// Where processDPIMode came from, logged next to it so a helper log shows
// whether the manifest or the runtime set calls fixed the mode.
const (
	// dpiSourcePreset: the effective mode was already per-monitor before any
	// set call — in practice the binary's manifest declared it.
	dpiSourcePreset = "preset"
	// dpiSourceSet: read back from Windows after the set calls ran.
	dpiSourceSet = "set"
	// dpiSourceInferred: no query API is available, so the mode is inferred
	// from which set call succeeded. Unreliable when a manifest already fixed
	// the mode (every set call then fails with access denied).
	dpiSourceInferred = "inferred"
)

// processDPISource is the dpiSource* value for processDPIMode ("n/a" off
// Windows).
var processDPISource = "n/a"

// dpiQueryAPIs are the raw Win32 reads of the process's EFFECTIVE DPI
// awareness. A nil func means this Windows build does not export the API.
type dpiQueryAPIs struct {
	// processContext is user32!GetDpiAwarenessContextForProcess(NULL) (1803+).
	processContext func() (ctx uintptr, ok bool)
	// threadContext is user32!GetThreadDpiAwarenessContext (1607+). Nothing in
	// the agent sets a per-thread context, so it equals the process default.
	threadContext func() (ctx uintptr, ok bool)
	// awarenessFromContext is user32!GetAwarenessFromDpiAwarenessContext:
	// DPI_AWARENESS -1 invalid, 0 unaware, 1 system, 2 per-monitor.
	awarenessFromContext func(ctx uintptr) int32
	// isPerMonitorV2 is AreDpiAwarenessContextsEqual(ctx, PER_MONITOR_AWARE_V2).
	// DPI_AWARENESS alone cannot tell per-monitor v1 from v2.
	isPerMonitorV2 func(ctx uintptr) bool
	// processAwareness is shcore!GetProcessDpiAwareness(NULL) (8.1+):
	// PROCESS_DPI_AWARENESS 0 unaware, 1 system, 2 per-monitor. ok=false when
	// the HRESULT failed.
	processAwareness func() (value uint32, ok bool)
}

// queryEffectiveDPIMode reads the awareness Windows actually applies to the
// process, preferring the process context, then the thread context, then
// shcore. ok=false when no source gives a usable answer.
func queryEffectiveDPIMode(apis dpiQueryAPIs) (mode string, ok bool) {
	if apis.awarenessFromContext != nil {
		for _, get := range []func() (uintptr, bool){apis.processContext, apis.threadContext} {
			if get == nil {
				continue
			}
			ctx, ok := get()
			if !ok || ctx == 0 {
				continue
			}
			switch apis.awarenessFromContext(ctx) {
			case 2:
				if apis.isPerMonitorV2 != nil && apis.isPerMonitorV2(ctx) {
					return dpiModePerMonitorV2, true
				}
				return dpiModePerMonitor, true
			case 1:
				return dpiModeSystem, true
			case 0:
				return dpiModeUnaware, true
			}
			// DPI_AWARENESS_INVALID: try the next source.
		}
	}
	if apis.processAwareness != nil {
		if v, ok := apis.processAwareness(); ok {
			switch v {
			case 2:
				// shcore cannot distinguish v2; it is only reached on builds
				// older than 1607, which have no v2 anyway.
				return dpiModePerMonitor, true
			case 1:
				return dpiModeSystem, true
			case 0:
				return dpiModeUnaware, true
			}
		}
	}
	return "", false
}

// resolveDPIAwareness returns the process's effective DPI mode and where it
// came from. If the process is already per-monitor (the manifest declared it)
// no set call is made — they would all fail with access denied and the old
// inference from their results misreported per-monitor-v2 as "system". If it is
// weaker, elevate (chooseDPIAwareness over the set calls) runs for binaries
// without the manifest, and the mode is read back from Windows. Only when no
// query API exists does the set-call inference stand.
func resolveDPIAwareness(query func() (string, bool), elevate func() string) (mode, source string) {
	if mode, ok := query(); ok && !dpiModeMisplacesInput(mode) {
		return mode, dpiSourcePreset
	}
	inferred := elevate()
	if mode, ok := query(); ok {
		return mode, dpiSourceSet
	}
	return inferred, dpiSourceInferred
}
