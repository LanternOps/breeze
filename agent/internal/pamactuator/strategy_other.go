//go:build !windows

package pamactuator

// newActuatorForStrategy always returns the no-op on non-Windows: UAC and the
// secure desktop only exist on Windows.
func newActuatorForStrategy(_ Strategy) Actuator {
	return &noopActuator{}
}
