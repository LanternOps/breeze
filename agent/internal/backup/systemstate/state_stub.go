//go:build !windows && !darwin && !linux

package systemstate

import "errors"

// ErrUnsupportedPlatform is returned on platforms without a system state collector.
var ErrUnsupportedPlatform = errors.New("systemstate: unsupported platform")

// StubCollector satisfies the Collector interface on unsupported platforms.
type StubCollector struct{}

// NewCollector returns a StubCollector on unsupported platforms.
func NewCollector() Collector {
	return &StubCollector{}
}

func (c *StubCollector) CollectState(_ string) (*SystemStateManifest, error) {
	return nil, ErrUnsupportedPlatform
}

func (c *StubCollector) CollectHardwareProfile() (*HardwareProfile, error) {
	return nil, ErrUnsupportedPlatform
}
