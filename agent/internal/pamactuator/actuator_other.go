//go:build !windows

package pamactuator

import "context"

// noopActuator is the stub returned on Linux/macOS. UAC + consent.exe
// only exist on Windows; on other platforms Trigger returns immediately
// with success=false so the server-side approval flow can record the
// outcome and never block waiting on a host that cannot do the work.
type noopActuator struct{}

func newActuator() Actuator { return &noopActuator{} }

func (*noopActuator) Trigger(_ context.Context, _ Request) Result {
	return Result{
		Success:       false,
		Reason:        "unsupported_platform",
		DetailMessage: "pamactuator: not implemented for this platform",
	}
}
