//go:build darwin

package desktop

import (
	"image"
)

type darwinCapturer struct {
	mode          CaptureMode
	region        image.Rectangle
	activeMonitor int
}

func newPlatformCapturer(mode CaptureMode, region image.Rectangle) (PlatformCapturer, error) {
	// TODO: Implement CGDisplayStream capture and Metal-backed pixel buffers.
	return &darwinCapturer{
		mode:   mode,
		region: region,
	}, nil
}

func (c *darwinCapturer) CaptureFrame() (*Frame, error) {
	return nil, ErrNotImplemented
}

func (c *darwinCapturer) GetMonitors() ([]Monitor, error) {
	return nil, ErrNotImplemented
}

func (c *darwinCapturer) SetActiveMonitor(id int) error {
	c.activeMonitor = id
	return nil
}

func (c *darwinCapturer) Close() error {
	return nil
}
