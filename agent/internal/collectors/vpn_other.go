//go:build !windows && !linux && !darwin

package collectors

// vpnServiceSignals has no per-OS service enumeration on unsupported platforms;
// interface + process detection in vpn.go still works.
func vpnServiceSignals() map[string]bool {
	return nil
}
