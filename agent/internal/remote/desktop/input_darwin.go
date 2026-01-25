//go:build darwin

package desktop

import (
	"fmt"
	"os/exec"
	"strings"
)

// DarwinInputHandler handles input on macOS
type DarwinInputHandler struct{}

// NewInputHandler creates a macOS input handler
func NewInputHandler() InputHandler {
	return &DarwinInputHandler{}
}

func (h *DarwinInputHandler) SendMouseMove(x, y int) error {
	// Use cliclick if available, otherwise use AppleScript
	if _, err := exec.LookPath("cliclick"); err == nil {
		return exec.Command("cliclick", fmt.Sprintf("m:%d,%d", x, y)).Run()
	}

	script := fmt.Sprintf(`
		tell application "System Events"
			set mouseLocation to {%d, %d}
		end tell
	`, x, y)
	return exec.Command("osascript", "-e", script).Run()
}

func (h *DarwinInputHandler) SendMouseClick(x, y int, button string) error {
	if _, err := exec.LookPath("cliclick"); err == nil {
		btn := "c"
		if button == "right" {
			btn = "rc"
		}
		return exec.Command("cliclick", fmt.Sprintf("%s:%d,%d", btn, x, y)).Run()
	}

	script := fmt.Sprintf(`
		tell application "System Events"
			click at {%d, %d}
		end tell
	`, x, y)
	return exec.Command("osascript", "-e", script).Run()
}

func (h *DarwinInputHandler) SendMouseDown(x, y int, button string) error {
	if _, err := exec.LookPath("cliclick"); err == nil {
		btn := "dd"
		if button == "right" {
			btn = "rd"
		}
		return exec.Command("cliclick", fmt.Sprintf("%s:%d,%d", btn, x, y)).Run()
	}
	return nil
}

func (h *DarwinInputHandler) SendMouseUp(x, y int, button string) error {
	if _, err := exec.LookPath("cliclick"); err == nil {
		btn := "du"
		if button == "right" {
			btn = "ru"
		}
		return exec.Command("cliclick", fmt.Sprintf("%s:%d,%d", btn, x, y)).Run()
	}
	return nil
}

func (h *DarwinInputHandler) SendMouseScroll(x, y int, delta int) error {
	// AppleScript scroll
	direction := "down"
	if delta < 0 {
		direction = "up"
		delta = -delta
	}
	script := fmt.Sprintf(`
		tell application "System Events"
			scroll %s by %d
		end tell
	`, direction, delta)
	return exec.Command("osascript", "-e", script).Run()
}

func (h *DarwinInputHandler) SendKeyPress(key string, modifiers []string) error {
	if _, err := exec.LookPath("cliclick"); err == nil {
		keyStr := key
		for _, mod := range modifiers {
			switch mod {
			case "ctrl":
				keyStr = "ctrl+" + keyStr
			case "alt":
				keyStr = "alt+" + keyStr
			case "shift":
				keyStr = "shift+" + keyStr
			case "meta", "cmd":
				keyStr = "cmd+" + keyStr
			}
		}
		return exec.Command("cliclick", "kp:"+keyStr).Run()
	}

	// Build AppleScript
	var modStr string
	if len(modifiers) > 0 {
		mods := make([]string, 0)
		for _, m := range modifiers {
			switch m {
			case "ctrl":
				mods = append(mods, "control down")
			case "alt":
				mods = append(mods, "option down")
			case "shift":
				mods = append(mods, "shift down")
			case "meta", "cmd":
				mods = append(mods, "command down")
			}
		}
		modStr = " using {" + strings.Join(mods, ", ") + "}"
	}

	script := fmt.Sprintf(`
		tell application "System Events"
			keystroke "%s"%s
		end tell
	`, key, modStr)
	return exec.Command("osascript", "-e", script).Run()
}

func (h *DarwinInputHandler) SendKeyDown(key string) error {
	return nil // Not easily supported via osascript
}

func (h *DarwinInputHandler) SendKeyUp(key string) error {
	return nil // Not easily supported via osascript
}

func (h *DarwinInputHandler) HandleEvent(event InputEvent) error {
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
