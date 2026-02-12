//go:build darwin && !cgo

package clipboard

import "errors"

// SystemClipboard provides clipboard access on macOS.
// This is the no-CGO stub that uses pbcopy/pbpaste as fallback.
type SystemClipboard struct{}

// NewSystemClipboard creates a new clipboard accessor for macOS without CGO.
func NewSystemClipboard() *SystemClipboard {
	return &SystemClipboard{}
}

func (s *SystemClipboard) GetContent() (Content, error) {
	return Content{}, errors.New("clipboard: unavailable (built without CGO)")
}

func (s *SystemClipboard) SetContent(content Content) error {
	return errors.New("clipboard: unavailable (built without CGO)")
}
