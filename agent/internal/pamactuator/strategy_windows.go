//go:build windows

package pamactuator

// newActuatorForStrategy dispatches to the concrete Windows actuator. Unknown
// strategies fall back to the sendinput default.
func newActuatorForStrategy(s Strategy) Actuator {
	switch s {
	case StrategyTokenLaunch:
		return newTokenLaunchActuator()
	default:
		return &windowsActuator{}
	}
}
