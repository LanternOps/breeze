//go:build windows

package desktop

import (
	"image"
)

type windowsCapturer struct {
	mode          CaptureMode
	region        image.Rectangle
	activeMonitor int
}

func newPlatformCapturer(mode CaptureMode, region image.Rectangle) (PlatformCapturer, error) {
	// TODO: Implement DXGI Desktop Duplication capture with D3D11 texture staging.
	return &windowsCapturer{
		mode:   mode,
		region: region,
	}, nil
}

func (c *windowsCapturer) CaptureFrame() (*Frame, error) {
	return nil, ErrNotImplemented
}

func (c *windowsCapturer) GetMonitors() ([]Monitor, error) {
	return nil, ErrNotImplemented
}

func (c *windowsCapturer) SetActiveMonitor(id int) error {
	c.activeMonitor = id
	return nil
}

func (c *windowsCapturer) Close() error {
	return nil
}
