package desktop

// Process DPI-awareness mode names, reported once at startup so a helper log
// shows which coordinate space Win32 input/cursor calls are operating in.
const (
	dpiModePerMonitorV2 = "per-monitor-v2"
	dpiModePerMonitor   = "per-monitor"
	dpiModeSystem       = "system"
	dpiModeUnaware      = "unaware"
)

// processDPIMode is the awareness mode that took effect at init on Windows
// (empty elsewhere); logged with the display offset so a helper log shows which
// coordinate space input and cursor calls used.
var processDPIMode string

// chooseDPIAwareness elevates the process to the strongest available DPI
// awareness and returns the mode that took effect.
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
	if perMonitorV2 != nil && perMonitorV2() {
		return dpiModePerMonitorV2
	}
	if perMonitor != nil && perMonitor() {
		return dpiModePerMonitor
	}
	if system != nil && system() {
		return dpiModeSystem
	}
	return dpiModeUnaware
}
