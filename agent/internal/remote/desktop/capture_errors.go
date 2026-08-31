package desktop

import "fmt"

// Capture error codes returned by the macOS C shims (capture_darwin.go,
// capture_darwin_cg.go, capture_darwin_displaystream.go).
//
// Deliberately in a platform-NEUTRAL file. The shims are behind
// `//go:build darwin && cgo`, and the Test Agent CI job runs on ubuntu-latest,
// so anything tagged darwin compiles out and its tests never execute. Keeping
// the code→message mapping here is what lets it be covered by CI at all.
const (
	captureErrDisplayList        = 1
	captureErrContentUnavailable = 2
	captureErrPermissionDenied   = 3
	captureErrAllocFailed        = 4
	captureErrBitmapContext      = 5
	captureErrNotInitialized     = 6
	captureErrTimeout            = 7
	captureErrBackendUnavailable = 8
	captureErrStreamCreate       = 9
	captureErrStreamStart        = 10
	// captureErrNoDisplayAttached is distinct from captureErrContentUnavailable
	// on purpose (#4042). Both used to be code 2, so "there is no display to
	// capture" and "the content request failed, e.g. Screen Recording denied"
	// produced the same error — with opposite remediations. That cost four
	// rounds of production intervention on #3380: the operator was told to
	// check permissions on a host whose grants were correct and whose real
	// problem was an Apple Silicon Mac with no framebuffer after its Screen
	// Sharing session ended.
	captureErrNoDisplayAttached = 11
)

// translateCaptureError converts a C shim error code into a Go error.
//
// Rule for every message here: report what was OBSERVED, and enumerate the
// causes that produce it. Do not name a single cause. A message that guesses
// sends every reader down that path, including the ones it is wrong for.
func translateCaptureError(code int) error {
	switch code {
	case captureErrDisplayList:
		return fmt.Errorf("failed to get display list")
	case captureErrNoDisplayAttached:
		return fmt.Errorf("%w: the system reported zero displays — nothing is attached to capture "+
			"(on a headless Mac this is normal once a Screen Sharing session ends; "+
			"attach a display or a dummy plug). This is NOT a permissions failure",
			ErrDisplayNotFound)
	case captureErrContentUnavailable:
		return fmt.Errorf("%w: the shareable-content request failed. Causes: Screen Recording "+
			"not granted to this process; the requested display index no longer exists; "+
			"the window server rejected the request", ErrDisplayNotFound)
	case captureErrPermissionDenied:
		return ErrPermissionDenied
	case captureErrAllocFailed:
		return fmt.Errorf("memory allocation failed")
	case captureErrBitmapContext:
		return fmt.Errorf("failed to create bitmap context")
	case captureErrNotInitialized:
		return fmt.Errorf("capturer not initialized — call initCapture first")
	case captureErrTimeout:
		// Previously asserted "process may lack Screen Recording permission
		// (check System Settings > Privacy > Screen Recording)". It is a plain
		// semaphore expiry; a no-display host and a wedged window server produce
		// it too. Naming one cause is what sent #3380 into System Settings.
		return fmt.Errorf("ScreenCaptureKit did not answer within the timeout. Causes: no display " +
			"attached; Screen Recording not granted to this process; the window server is not " +
			"responding. Check the attached display count before changing any permission")
	case captureErrBackendUnavailable:
		return fmt.Errorf("macOS capture backend not available")
	case captureErrStreamCreate:
		return fmt.Errorf("failed to create CGDisplayStream")
	case captureErrStreamStart:
		return fmt.Errorf("failed to start CGDisplayStream")
	default:
		return fmt.Errorf("unknown error: %d", code)
	}
}
