package desktop

// InputEvent represents a mouse or keyboard input event
type InputEvent struct {
	Type      string   `json:"type"`      // "mouse_move", "mouse_click", "mouse_scroll", "key_press", "key_release"
	X         int      `json:"x,omitempty"`
	Y         int      `json:"y,omitempty"`
	Button    string   `json:"button,omitempty"`    // "left", "right", "middle"
	Key       string   `json:"key,omitempty"`       // Key code or character
	Modifiers []string `json:"modifiers,omitempty"` // "ctrl", "alt", "shift", "meta"
	Delta     int      `json:"delta,omitempty"`     // Scroll delta
}

// InputHandler processes input events
type InputHandler interface {
	// SendMouseMove moves the mouse cursor to the specified position
	SendMouseMove(x, y int) error

	// SendMouseClick performs a mouse click at the specified position
	SendMouseClick(x, y int, button string) error

	// SendMouseDown presses a mouse button
	SendMouseDown(x, y int, button string) error

	// SendMouseUp releases a mouse button
	SendMouseUp(x, y int, button string) error

	// SendMouseScroll performs a scroll action
	SendMouseScroll(x, y int, delta int) error

	// SendKeyPress presses and releases a key
	SendKeyPress(key string, modifiers []string) error

	// SendKeyDown presses a key
	SendKeyDown(key string) error

	// SendKeyUp releases a key
	SendKeyUp(key string) error

	// HandleEvent processes a generic input event
	HandleEvent(event InputEvent) error
}

// NewInputHandler creates a platform-specific input handler
// Implementation is in input_*.go files
