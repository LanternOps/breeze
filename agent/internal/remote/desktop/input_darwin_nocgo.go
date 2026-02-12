//go:build darwin && !cgo

package desktop

import "fmt"

// darwinInputHandlerNoCgo is a stub input handler for macOS builds without CGO.
// CGEvents require CGO to interact with CoreGraphics.
type darwinInputHandlerNoCgo struct{}

// NewInputHandler creates a stub input handler when built without CGO.
func NewInputHandler() InputHandler {
	return &darwinInputHandlerNoCgo{}
}

func (h *darwinInputHandlerNoCgo) SendMouseMove(x, y int) error {
	return fmt.Errorf("input handler unavailable: built without CGO")
}

func (h *darwinInputHandlerNoCgo) SendMouseClick(x, y int, button string) error {
	return fmt.Errorf("input handler unavailable: built without CGO")
}

func (h *darwinInputHandlerNoCgo) SendMouseDown(x, y int, button string) error {
	return fmt.Errorf("input handler unavailable: built without CGO")
}

func (h *darwinInputHandlerNoCgo) SendMouseUp(x, y int, button string) error {
	return fmt.Errorf("input handler unavailable: built without CGO")
}

func (h *darwinInputHandlerNoCgo) SendMouseScroll(x, y int, delta int) error {
	return fmt.Errorf("input handler unavailable: built without CGO")
}

func (h *darwinInputHandlerNoCgo) SendKeyPress(key string, modifiers []string) error {
	return fmt.Errorf("input handler unavailable: built without CGO")
}

func (h *darwinInputHandlerNoCgo) SendKeyDown(key string) error {
	return fmt.Errorf("input handler unavailable: built without CGO")
}

func (h *darwinInputHandlerNoCgo) SendKeyUp(key string) error {
	return fmt.Errorf("input handler unavailable: built without CGO")
}

func (h *darwinInputHandlerNoCgo) HandleEvent(event InputEvent) error {
	return fmt.Errorf("input handler unavailable: built without CGO")
}
