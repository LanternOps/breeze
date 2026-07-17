//go:build linux

package desktop

import "strings"

// x11CursorNameToCSS maps X11/Xcursor theme names to CSS cursor values.
var x11CursorNameToCSS = map[string]string{
	// Standard arrow
	"left_ptr": "default",
	"default":  "default",
	"arrow":    "default",

	// Text selection
	"xterm": "text",
	"text":  "text",
	"ibeam": "text",

	// Pointer/hand (clickable)
	"hand2":         "pointer",
	"hand1":         "pointer",
	"pointer":       "pointer",
	"pointing_hand": "pointer",

	// Crosshair
	"crosshair": "crosshair",
	"cross":     "crosshair",
	"tcross":    "crosshair",

	// Move/grab
	"fleur":      "move",
	"move":       "move",
	"grab":       "move",
	"grabbing":   "move",
	"all_scroll": "move",

	// Horizontal resize
	"sb_h_double_arrow": "ew-resize",
	"ew-resize":         "ew-resize",
	"col-resize":        "ew-resize",
	"left_side":         "ew-resize",
	"right_side":        "ew-resize",
	"h_double_arrow":    "ew-resize",

	// Vertical resize
	"sb_v_double_arrow": "ns-resize",
	"ns-resize":         "ns-resize",
	"row-resize":        "ns-resize",
	"top_side":          "ns-resize",
	"bottom_side":       "ns-resize",
	"v_double_arrow":    "ns-resize",

	// Diagonal resize (NW-SE)
	"top_left_corner":     "nwse-resize",
	"bottom_right_corner": "nwse-resize",
	"nwse-resize":         "nwse-resize",
	"size_fdiag":          "nwse-resize",
	"nw-resize":           "nwse-resize",
	"se-resize":           "nwse-resize",

	// Diagonal resize (NE-SW)
	"top_right_corner":   "nesw-resize",
	"bottom_left_corner": "nesw-resize",
	"nesw-resize":        "nesw-resize",
	"size_bdiag":         "nesw-resize",
	"ne-resize":          "nesw-resize",
	"sw-resize":          "nesw-resize",

	// Wait/busy
	"watch":    "wait",
	"wait":     "wait",
	"progress": "progress",

	// Not allowed
	"not-allowed":    "not-allowed",
	"crossed_circle": "not-allowed",
	"forbidden":      "not-allowed",
	"no-drop":        "not-allowed",
	"circle":         "not-allowed",

	// Help
	"help":           "help",
	"question_arrow": "help",
	"whats_this":     "help",

	// Context menu
	"context-menu": "context-menu",

	// Cell/plus
	"cell": "cell",
	"plus": "cell",
}

// mapX11CursorToCSS converts an X11 cursor theme name to a CSS cursor value.
// Returns "default" for unknown names.
func mapX11CursorToCSS(name string) string {
	if css, ok := x11CursorNameToCSS[name]; ok {
		return css
	}
	// Some themes use prefixed names (e.g., "Adwaita/left_ptr").
	if idx := strings.LastIndex(name, "/"); idx >= 0 && idx+1 < len(name) {
		if css, ok := x11CursorNameToCSS[name[idx+1:]]; ok {
			return css
		}
	}
	// Try lowercase (some themes use mixed case).
	lower := strings.ToLower(name)
	if css, ok := x11CursorNameToCSS[lower]; ok {
		return css
	}
	return "default"
}
