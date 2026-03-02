//go:build !darwin && !windows

package peripheral

// DetectPeripherals is a stub for unsupported platforms. Returns an empty slice.
func DetectPeripherals() ([]DetectedPeripheral, error) {
	return nil, nil
}
