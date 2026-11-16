package wayland

import "strings"

// buttonCode maps a viewer button name to an evdev BTN_* code.
func buttonCode(name string) uint32 {
	switch strings.ToLower(name) {
	case "right":
		return 0x111
	case "middle":
		return 0x112
	case "back":
		return 0x113
	case "forward":
		return 0x114
	default:
		return 0x110
	}
}
