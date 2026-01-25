//go:build linux

package desktop

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

// LinuxInputHandler handles input on Linux using xdotool
type LinuxInputHandler struct{}

// NewInputHandler creates a Linux input handler
func NewInputHandler() InputHandler {
	return &LinuxInputHandler{}
}

func (h *LinuxInputHandler) SendMouseMove(x, y int) error {
	return exec.Command("xdotool", "mousemove", strconv.Itoa(x), strconv.Itoa(y)).Run()
}

func (h *LinuxInputHandler) SendMouseClick(x, y int, button string) error {
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}

	btn := "1" // left
	switch button {
	case "right":
		btn = "3"
	case "middle":
		btn = "2"
	}

	return exec.Command("xdotool", "click", btn).Run()
}

func (h *LinuxInputHandler) SendMouseDown(x, y int, button string) error {
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}

	btn := "1"
	switch button {
	case "right":
		btn = "3"
	case "middle":
		btn = "2"
	}

	return exec.Command("xdotool", "mousedown", btn).Run()
}

func (h *LinuxInputHandler) SendMouseUp(x, y int, button string) error {
	btn := "1"
	switch button {
	case "right":
		btn = "3"
	case "middle":
		btn = "2"
	}

	return exec.Command("xdotool", "mouseup", btn).Run()
}

func (h *LinuxInputHandler) SendMouseScroll(x, y int, delta int) error {
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}

	direction := "4" // scroll up
	if delta < 0 {
		direction = "5" // scroll down
		delta = -delta
	}

	for i := 0; i < delta; i++ {
		if err := exec.Command("xdotool", "click", direction).Run(); err != nil {
			return err
		}
	}

	return nil
}

func (h *LinuxInputHandler) SendKeyPress(key string, modifiers []string) error {
	keyStr := h.translateKey(key)

	// Build key combination
	if len(modifiers) > 0 {
		mods := make([]string, 0, len(modifiers))
		for _, m := range modifiers {
			switch strings.ToLower(m) {
			case "ctrl", "control":
				mods = append(mods, "ctrl")
			case "alt":
				mods = append(mods, "alt")
			case "shift":
				mods = append(mods, "shift")
			case "meta", "super", "win", "cmd":
				mods = append(mods, "super")
			}
		}
		keyStr = strings.Join(append(mods, keyStr), "+")
	}

	return exec.Command("xdotool", "key", keyStr).Run()
}

func (h *LinuxInputHandler) SendKeyDown(key string) error {
	return exec.Command("xdotool", "keydown", h.translateKey(key)).Run()
}

func (h *LinuxInputHandler) SendKeyUp(key string) error {
	return exec.Command("xdotool", "keyup", h.translateKey(key)).Run()
}

func (h *LinuxInputHandler) translateKey(key string) string {
	switch strings.ToLower(key) {
	case "enter", "return":
		return "Return"
	case "tab":
		return "Tab"
	case "space":
		return "space"
	case "backspace":
		return "BackSpace"
	case "escape", "esc":
		return "Escape"
	case "delete", "del":
		return "Delete"
	case "home":
		return "Home"
	case "end":
		return "End"
	case "pageup":
		return "Page_Up"
	case "pagedown":
		return "Page_Down"
	case "up":
		return "Up"
	case "down":
		return "Down"
	case "left":
		return "Left"
	case "right":
		return "Right"
	default:
		return key
	}
}

func (h *LinuxInputHandler) HandleEvent(event InputEvent) error {
	switch event.Type {
	case "mouse_move":
		return h.SendMouseMove(event.X, event.Y)
	case "mouse_click":
		return h.SendMouseClick(event.X, event.Y, event.Button)
	case "mouse_down":
		return h.SendMouseDown(event.X, event.Y, event.Button)
	case "mouse_up":
		return h.SendMouseUp(event.X, event.Y, event.Button)
	case "mouse_scroll":
		return h.SendMouseScroll(event.X, event.Y, event.Delta)
	case "key_press":
		return h.SendKeyPress(event.Key, event.Modifiers)
	case "key_down":
		return h.SendKeyDown(event.Key)
	case "key_up":
		return h.SendKeyUp(event.Key)
	default:
		return fmt.Errorf("unknown event type: %s", event.Type)
	}
}
