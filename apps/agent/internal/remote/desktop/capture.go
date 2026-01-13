package desktop

import (
	"errors"
	"image"
	"sync"
	"time"
)

// CaptureMode determines how frames are captured from the desktop.
type CaptureMode int

const (
	CaptureModeFull CaptureMode = iota
	CaptureModePartial
	CaptureModeCursorArea
)

// Monitor describes an available display.
type Monitor struct {
	ID      int
	Name    string
	Bounds  image.Rectangle
	Primary bool
	Scale   float64
}

// Frame contains a raw RGBA snapshot of the desktop.
type Frame struct {
	Width     int
	Height    int
	Stride    int
	Data      []byte
	Timestamp time.Time
}

var (
	ErrInvalidCaptureMode = errors.New("invalid capture mode")
	ErrInvalidRegion      = errors.New("invalid capture region")
	ErrNotSupported       = errors.New("desktop capture not supported")
	ErrNotImplemented     = errors.New("desktop capture not implemented")
)

// PlatformCapturer is implemented per-OS using the best available APIs.
type PlatformCapturer interface {
	CaptureFrame() (*Frame, error)
	GetMonitors() ([]Monitor, error)
	SetActiveMonitor(id int) error
	Close() error
}

// ScreenCapture manages GPU-accelerated capture through a platform implementation.
type ScreenCapture struct {
	mu              sync.RWMutex
	mode            CaptureMode
	region          image.Rectangle
	activeMonitorID int
	impl            PlatformCapturer
}

// NewScreenCapture initializes screen capture for the current platform.
func NewScreenCapture(mode CaptureMode, region image.Rectangle) (*ScreenCapture, error) {
	if mode != CaptureModeFull && mode != CaptureModePartial && mode != CaptureModeCursorArea {
		return nil, ErrInvalidCaptureMode
	}
	if mode == CaptureModePartial && (region.Empty() || region.Dx() <= 0 || region.Dy() <= 0) {
		return nil, ErrInvalidRegion
	}
	impl, err := newPlatformCapturer(mode, region)
	if err != nil {
		return nil, err
	}
	return &ScreenCapture{
		mode:   mode,
		region: region,
		impl:   impl,
	}, nil
}

// CaptureFrame grabs the latest RGBA frame using the active platform implementation.
func (s *ScreenCapture) CaptureFrame() (*Frame, error) {
	s.mu.RLock()
	impl := s.impl
	s.mu.RUnlock()
	if impl == nil {
		return nil, ErrNotSupported
	}
	return impl.CaptureFrame()
}

// GetMonitors returns the current monitor list.
func (s *ScreenCapture) GetMonitors() ([]Monitor, error) {
	s.mu.RLock()
	impl := s.impl
	s.mu.RUnlock()
	if impl == nil {
		return nil, ErrNotSupported
	}
	return impl.GetMonitors()
}

// SetActiveMonitor switches the active monitor used for capture.
func (s *ScreenCapture) SetActiveMonitor(id int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.impl == nil {
		return ErrNotSupported
	}
	if err := s.impl.SetActiveMonitor(id); err != nil {
		return err
	}
	s.activeMonitorID = id
	return nil
}

// Close releases any OS resources held by the platform capture implementation.
func (s *ScreenCapture) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.impl == nil {
		return nil
	}
	err := s.impl.Close()
	s.impl = nil
	return err
}
