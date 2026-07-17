//go:build !linux

package x11

// ProbeCapture is unsupported off Linux.
func ProbeCapture() error { return ErrNoDisplay }
