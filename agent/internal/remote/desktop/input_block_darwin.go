//go:build darwin

package desktop

import "errors"

// darwinInputBlockBackend is a deliberate stub for macOS.
//
// macOS local-input blocking is feasible via a CGEventTap created at
// kCGHIDEventTap / kCGSessionEventTap that returns NULL from its callback to
// swallow physical key/mouse events, but a correct, safe implementation needs:
//
//   - Accessibility (and, for some event types, Input Monitoring) permission —
//     the agent must already hold these (see project_macos_permissions); a tap
//     created without them silently fails or is auto-disabled.
//   - A dedicated CFRunLoop on a locked OS thread to service the tap. The Go
//     agent has no such runloop in this package today; the existing CGEvent
//     INJECTION path (input_darwin.go) does not need one, but a TAP does.
//   - Robust handling of kCGEventTapDisabledByTimeout /
//     kCGEventTapDisabledByUserInput, which macOS fires under load and which
//     would otherwise leave the tap silently dead (the "finicky under load"
//     caveat called out in issue #966).
//   - A guarantee that the operator's INJECTED CGEvents are not also swallowed
//     by our own tap. CGEventTap sees synthetic events too, so injected input
//     must be tagged (e.g. CGEventSetIntegerValueField with a sentinel in
//     kCGEventSourceUserData / a custom field) and the tap callback must let
//     tagged events through. Getting this wrong blocks the remote operator too.
//
// That is a self-contained subsystem with its own runloop lifecycle and crash
// semantics, so per the issue ("worth scoping separately ... may want to land
// Windows first") it is intentionally deferred. Reporting Supported()==false
// here means the control-channel handler replies block_local_input_result with
// supported:false, and the viewer surfaces "not available on macOS" rather than
// a false "blocked".
//
// TODO(#966 follow-up): implement CGEventTap-based blocking on a dedicated
// CFRunLoop thread, gate on Accessibility/Input-Monitoring permission, tag and
// pass through injected events, and re-enable the tap on
// kCGEventTapDisabledBy* notifications.
type darwinInputBlockBackend struct{}

func newInputBlockBackend() inputBlockBackend {
	return &darwinInputBlockBackend{}
}

func (b *darwinInputBlockBackend) Supported() bool { return false }

func (b *darwinInputBlockBackend) Block() error {
	return errors.New("local input blocking not yet implemented on macOS")
}

func (b *darwinInputBlockBackend) Unblock() error { return nil }
