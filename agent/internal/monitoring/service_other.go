//go:build !darwin && !linux && !windows

package monitoring

import "fmt"

func checkService(name string) CheckResult {
	return CheckResult{
		Status:  StatusError,
		Details: map[string]any{"error": "service monitoring not supported on this platform"},
	}
}

func restartService(name string) error {
	return fmt.Errorf("service restart not supported on this platform")
}
