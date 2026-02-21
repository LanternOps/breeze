//go:build !windows && !linux && !darwin

package collectors

import "fmt"

func collectServices() ([]ServiceInfo, error) {
	return nil, fmt.Errorf("service collection is not supported on this platform")
}
