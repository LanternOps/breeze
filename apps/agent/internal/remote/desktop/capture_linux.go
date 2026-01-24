//go:build linux

package desktop

import (
	"image"
)

type linuxCapturer struct {
	mode          CaptureMode
	region        image.Rectangle
	activeMonitor int
}

func newPlatformCapturer(mode CaptureMode, region image.Rectangle) (PlatformCapturer, error) {
	// TODO: Implement X11 shared memory capture and PipeWire DMA-BUF for Wayland.
	return &linuxCapturer{
		mode:   mode,
		region: region,
	}, nil
}

func (c *linuxCapturer) CaptureFrame() (*Frame, error) {
	return nil, ErrNotImplemented
}

func (c *linuxCapturer) GetMonitors() ([]Monitor, error) {
	return nil, ErrNotImplemented
}

func (c *linuxCapturer) SetActiveMonitor(id int) error {
	c.activeMonitor = id
	return nil
}

func (c *linuxCapturer) Close() error {
	return nil
}
