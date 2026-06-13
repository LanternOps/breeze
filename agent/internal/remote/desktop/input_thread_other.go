//go:build !windows

package desktop

// runOnInputThread runs fn inline on non-Windows platforms. Only Windows'
// BlockInput has the thread-affinity constraint that requires a dedicated
// serializer thread; macOS (CGEvent, and an unsupported v1 block stub) and
// Linux/other (no-op block) have nothing to serialize, so the closure runs
// directly on the caller's goroutine. See input_thread.go for details.
func runOnInputThread(fn func()) {
	fn()
}
