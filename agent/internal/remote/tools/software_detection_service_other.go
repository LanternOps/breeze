//go:build !windows && !darwin && !linux

package tools

// platformServiceStatus: no service manager integration on this platform, so
// a service_running clause is unsupported (never pass, never fail).
func platformServiceStatus(string) (running bool, supported bool) {
	return false, false
}
