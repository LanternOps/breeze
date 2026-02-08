//go:build !windows

package desktop

import "image"

type cursorOverlay struct{}

func newCursorOverlay() *cursorOverlay { return &cursorOverlay{} }

func (c *cursorOverlay) CompositeCursor(img *image.RGBA) {}
