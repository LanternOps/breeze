//go:build linux && cgo

package desktop

/*
#cgo CFLAGS: -I/usr/include
#cgo LDFLAGS: -lX11 -lXfixes

#include <X11/Xlib.h>
#include <X11/extensions/Xfixes.h>
#include <stdlib.h>
#include <string.h>

// CursorQueryCtx holds a separate X11 connection dedicated to cursor queries
// so that cursor polling doesn't contend with the capture mutex.
typedef struct {
	Display* display;
	Window   root;
	int      xfixesOK;   // 1 if XFixes 4.0+ is available
	int      initialized;
} CursorQueryCtx;

static CursorQueryCtx g_curCtx = {0};

// initCursorCtx opens an independent X11 connection for cursor queries.
// Returns 0 on success.
int initCursorCtx(int displayIndex) {
	if (g_curCtx.initialized) {
		return 0;
	}

	g_curCtx.display = XOpenDisplay(NULL);
	if (g_curCtx.display == NULL) {
		return 1;
	}

	int screen = displayIndex;
	if (screen >= ScreenCount(g_curCtx.display)) {
		screen = DefaultScreen(g_curCtx.display);
	}
	g_curCtx.root = RootWindow(g_curCtx.display, screen);

	// Check XFixes 4.0+ for cursor name support.
	int eventBase, errorBase;
	if (XFixesQueryExtension(g_curCtx.display, &eventBase, &errorBase)) {
		int major = 4, minor = 0;
		XFixesQueryVersion(g_curCtx.display, &major, &minor);
		if (major >= 4) {
			g_curCtx.xfixesOK = 1;
		}
	}

	g_curCtx.initialized = 1;
	return 0;
}

// cleanupCursorCtx closes the cursor query connection.
void cleanupCursorCtx() {
	if (g_curCtx.display != NULL) {
		XCloseDisplay(g_curCtx.display);
		g_curCtx.display = NULL;
	}
	g_curCtx.initialized = 0;
	g_curCtx.xfixesOK = 0;
}

// queryCursorInfo queries cursor position via XQueryPointer and cursor shape
// name via XFixesGetCursorImage on the dedicated cursor connection.
// Caller must free *outName with free() when non-NULL.
// Returns 0 on success.
int queryCursorInfo(int* outX, int* outY, int* outVisible, char** outName) {
	*outX = 0;
	*outY = 0;
	*outVisible = 1;
	*outName = NULL;

	if (!g_curCtx.initialized || g_curCtx.display == NULL) {
		return 1;
	}

	// Query pointer position.
	Window rootRet, childRet;
	int rootX, rootY, winX, winY;
	unsigned int mask;
	Bool ok = XQueryPointer(g_curCtx.display, g_curCtx.root,
		&rootRet, &childRet, &rootX, &rootY, &winX, &winY, &mask);
	if (!ok) {
		return 2;
	}
	*outX = rootX;
	*outY = rootY;

	// Query cursor shape name via XFixes (if available).
	if (g_curCtx.xfixesOK) {
		XFixesCursorImage* ci = XFixesGetCursorImage(g_curCtx.display);
		if (ci != NULL) {
			if (ci->name != NULL && ci->name[0] != '\0') {
				*outName = strdup(ci->name);
			}
			XFree(ci);
		}
	}

	return 0;
}
*/
import "C"

import (
	"strings"
	"sync"
	"unsafe"
)

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

// cursorCtxOnce ensures the cursor X11 connection is initialized once.
var cursorCtxOnce sync.Once

// closeCursorCtx releases the dedicated cursor X11 connection.
// Called by linuxCapturer.Close() from capture_linux.go.
func closeCursorCtx() {
	C.cleanupCursorCtx()
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

// CursorPosition implements CursorProvider for the Linux X11 capturer.
// Uses a dedicated X11 connection so it doesn't contend with the capture mutex.
// Also updates cursorShape as a side effect (same pattern as Windows).
func (c *linuxCapturer) CursorPosition() (x, y int32, visible bool) {
	cursorCtxOnce.Do(func() {
		C.initCursorCtx(C.int(c.config.DisplayIndex))
	})

	var cx, cy, cv C.int
	var cname *C.char

	ret := C.queryCursorInfo(&cx, &cy, &cv, &cname)
	if ret != 0 {
		return 0, 0, false
	}

	if cname != nil {
		goName := C.GoString(cname)
		C.free(unsafe.Pointer(cname))
		c.cursorShape.Store(mapX11CursorToCSS(goName))
	}

	return int32(cx), int32(cy), cv != 0
}

// CursorShape implements CursorShapeProvider. Returns the CSS cursor name
// matching the current system cursor. The shape is updated as a side effect
// of CursorPosition(), so callers should call CursorPosition first.
func (c *linuxCapturer) CursorShape() string {
	if v := c.cursorShape.Load(); v != nil {
		return v.(string)
	}
	return "default"
}

var _ CursorProvider = (*linuxCapturer)(nil)
var _ CursorShapeProvider = (*linuxCapturer)(nil)
