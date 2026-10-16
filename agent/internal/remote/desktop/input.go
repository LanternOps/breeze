package desktop

// InputEvent represents a mouse or keyboard input event
type InputEvent struct {
	Type      string   `json:"type"` // "mouse_move", "mouse_click", "mouse_scroll", "key_press", "key_release"
	X         int      `json:"x,omitempty"`
	Y         int      `json:"y,omitempty"`
	Button    string   `json:"button,omitempty"`    // "left", "right", "middle"; W2c: "back", "forward"
	Key       string   `json:"key,omitempty"`       // Key code or character
	Modifiers []string `json:"modifiers,omitempty"` // "ctrl", "alt", "shift", "meta"
	Delta     int      `json:"delta,omitempty"`     // Scroll delta

	// CapsLock is the viewer's Caps Lock state at the moment this event was
	// produced. A pointer, because "the viewer did not say" (nil) has to be
	// distinguishable from "the viewer says Caps Lock is off" (false): only the
	// latter lets the agent take ownership of the AlphaShift bit. Viewers that
	// predate issue #3595 never set it, and those sessions keep the platform
	// handler's original behaviour.
	CapsLock *bool `json:"capsLock,omitempty"`

	// W2c key/pointer coverage (spec §3). All zero for viewers that predate
	// it; a viewer sends them only after the agent advertised keyCodes.
	//
	// Code is the DOM KeyboardEvent.code of the physical key (e.g.
	// "ControlRight", "NumpadEnter"). The Windows agent injects a fixed subset
	// of codes by scancode (see winCodeKeys); every other code, and every
	// other platform, falls back to Key. Code never reaches a syscall as text.
	Code string `json:"code,omitempty"`
	// NumLock is the viewer's Num Lock state; a pointer for the same reason
	// as CapsLock.
	NumLock *bool `json:"numLock,omitempty"`
	// DeltaX is the horizontal scroll in steps, positive = right. Delta may
	// be 0 when DeltaX is set.
	DeltaX int `json:"deltaX,omitempty"`

	// W2b ordering fields (spec §1–2). All zero for viewers that predate them.
	// A zero Seq means "legacy": the event is handled exactly as before W2b
	// (see inputOrder). The WebSocket relay (heartbeat/handlers_desktop.go)
	// rebuilds events field by field and deliberately does not copy these, so WS
	// input always stays legacy.
	Seq      uint64 `json:"seq,omitempty"`      // per-session, strictly increasing across both channels
	After    uint64 `json:"after,omitempty"`    // mouse_move only: seq of the last discrete event sent before it
	Epoch    uint32 `json:"epoch,omitempty"`    // reset epoch the viewer believes is current
	GeoEpoch uint32 `json:"geoEpoch,omitempty"` // geometry epoch from the last monitor_switched
}

// InputHandler processes input events
type InputHandler interface {
	// SetDisplayOffset sets the virtual screen offset of the captured monitor.
	// All mouse coordinates from the viewer are relative to the captured monitor;
	// this offset translates them to virtual screen coordinates.
	SetDisplayOffset(x, y int)

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

	// InputAvailable reports whether the handler can actually inject input.
	// Returns false when running in login_window context on macOS without
	// IOHIDSystem — CGEvent is silently blocked at the login window.
	InputAvailable() bool

	// SetAtLoginWindow toggles login-window input mode. On macOS, when true
	// and IOHIDSystem is available, input uses IOHIDPostEvent instead of CGEvent
	// (CGEvent clicks/keyboard are blocked at the macOS login window).
	// No-op on Windows.
	SetAtLoginWindow(atLoginWindow bool)
}

// TypeCharHandler is an optional interface for input handlers that support
// typing arbitrary Unicode characters directly (e.g., via KEYEVENTF_UNICODE
// on Windows). Used by the "type" action for characters that don't have VK
// code mappings (like ":", "!", "@", non-ASCII characters).
type TypeCharHandler interface {
	TypeChar(ch rune) error
}

// TextTyper is an optional interface for input handlers that can inject a whole
// literal string in one operation (macOS CGEventKeyboardSetUnicodeString,
// Windows KEYEVENTF_UNICODE batched into a single SendInput call). Preferred
// over TypeCharHandler because it is both faster and layout-independent: the
// string is delivered verbatim regardless of the remote machine's active
// keyboard layout. See InjectText in input_text.go.
type TextTyper interface {
	TypeText(text string) error
}

// NewInputHandler creates a platform-specific input handler.
// desktopContext is "user_session" or "login_window" — on macOS, login_window
// uses IOHIDPostEvent instead of CGEvent for input at the login screen.
// Implementation is in input_*.go files
