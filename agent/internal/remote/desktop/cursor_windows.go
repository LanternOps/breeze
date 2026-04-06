//go:build windows

package desktop

import (
	"image"
	"sync"
	"unsafe"
)

var (
	procGetCursorInfo = user32.NewProc("GetCursorInfo")
	procGetIconInfo   = user32.NewProc("GetIconInfo")
	procLoadCursorW   = user32.NewProc("LoadCursorW")
)

const cursorShowing = 0x00000001

// Standard Windows cursor resource IDs (MAKEINTRESOURCE values).
const (
	idcArrow       = 32512
	idcIBeam       = 32513
	idcWait        = 32514
	idcCross       = 32515
	idcSizeNWSE    = 32642
	idcSizeNESW    = 32643
	idcSizeWE      = 32644
	idcSizeNS      = 32645
	idcSizeAll     = 32646
	idcNo          = 32648
	idcHand        = 32649
	idcAppStarting = 32650
	idcHelp        = 32651
)

// cursorShapeEntry maps a system cursor handle to its CSS cursor name.
type cursorShapeEntry struct {
	handle uintptr
	css    string
}

// stdCursors is lazily initialized with system cursor handles.
var (
	stdCursors     []cursorShapeEntry
	stdCursorsOnce sync.Once
)

// loadStdCursors populates the stdCursors table by loading each standard
// Windows cursor via LoadCursorW(NULL, IDC_*). Called once on first use.
func loadStdCursors() {
	type pair struct {
		id  uintptr
		css string
	}
	pairs := []pair{
		{idcArrow, "default"},
		{idcIBeam, "text"},
		{idcWait, "wait"},
		{idcCross, "crosshair"},
		{idcSizeNWSE, "nwse-resize"},
		{idcSizeNESW, "nesw-resize"},
		{idcSizeWE, "ew-resize"},
		{idcSizeNS, "ns-resize"},
		{idcSizeAll, "move"},
		{idcNo, "not-allowed"},
		{idcHand, "pointer"},
		{idcAppStarting, "progress"},
		{idcHelp, "help"},
	}
	for _, p := range pairs {
		h, _, _ := procLoadCursorW.Call(0, p.id)
		if h != 0 {
			stdCursors = append(stdCursors, cursorShapeEntry{handle: h, css: p.css})
		}
	}
}

// cursorShapeFromHandle returns the CSS cursor name for a system cursor handle.
// Returns "default" if the handle doesn't match any known standard cursor.
func cursorShapeFromHandle(hCursor uintptr) string {
	stdCursorsOnce.Do(loadStdCursors)
	for _, entry := range stdCursors {
		if entry.handle == hCursor {
			return entry.css
		}
	}
	return "default"
}

type cursorInfoW struct {
	CbSize      uint32
	Flags       uint32
	HCursor     uintptr
	PtScreenPos struct{ X, Y int32 }
}

type iconInfoW struct {
	FIcon    int32
	XHotspot uint32
	YHotspot uint32
	HbmMask  uintptr
	HbmColor uintptr
}

// CursorPosition implements CursorProvider for real-time cursor streaming.
// Uses GetCursorInfo (independent of DXGI) so it works even when the desktop
// is static and AcquireNextFrame times out.
//
// When the calling goroutine is on a different OS thread than the capture
// thread (which has called SetThreadDesktop for secure desktops),
// GetCursorInfo fails. In that case, return values sampled by the capture
// thread via sampleCursorForCrossThread().
func (c *dxgiCapturer) CursorPosition() (x, y int32, visible bool) {
	var ci cursorInfoW
	ci.CbSize = uint32(unsafe.Sizeof(ci))
	ret, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if ret != 0 {
		// Also update shape for CursorShape() — avoids a second syscall.
		c.cursorShape.Store(cursorShapeFromHandle(ci.HCursor))
		return ci.PtScreenPos.X, ci.PtScreenPos.Y, ci.Flags&cursorShowing != 0
	}
	// GetCursorInfo failed — cursor goroutine is on a different desktop
	// than the capture thread. Return values sampled by capture thread.
	return c.cursorX.Load(), c.cursorY.Load(), c.cursorVis.Load()
}

// CursorShape implements CursorShapeProvider. Returns the CSS cursor name
// matching the current system cursor (e.g. "default", "pointer", "text").
// The shape is updated as a side effect of CursorPosition() or
// sampleCursorForCrossThread(), so callers should call CursorPosition first.
func (c *dxgiCapturer) CursorShape() string {
	if v := c.cursorShape.Load(); v != nil {
		return v.(string)
	}
	return "default"
}

var _ CursorProvider = (*dxgiCapturer)(nil)
var _ CursorShapeProvider = (*dxgiCapturer)(nil)

type cursorOverlay struct{}

func newCursorOverlay() *cursorOverlay {
	return &cursorOverlay{}
}

// CompositeCursor draws the system cursor onto the captured frame.
func (c *cursorOverlay) CompositeCursor(img *image.RGBA) {
	var ci cursorInfoW
	ci.CbSize = uint32(unsafe.Sizeof(ci))

	ret, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if ret == 0 || ci.Flags&cursorShowing == 0 {
		return
	}

	// Get hotspot offset
	var ii iconInfoW
	ret, _, _ = procGetIconInfo.Call(ci.HCursor, uintptr(unsafe.Pointer(&ii)))
	if ret != 0 {
		// Clean up bitmaps from GetIconInfo
		if ii.HbmMask != 0 {
			procDeleteObject.Call(ii.HbmMask)
		}
		if ii.HbmColor != 0 {
			procDeleteObject.Call(ii.HbmColor)
		}
	}

	curX := int(ci.PtScreenPos.X) - int(ii.XHotspot)
	curY := int(ci.PtScreenPos.Y) - int(ii.YHotspot)

	drawCursorSprite(img, curX, curY)
}

// drawCursorSprite renders a 12x20 standard arrow cursor into the image Pix slice.
func drawCursorSprite(img *image.RGBA, cx, cy int) {
	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	pix := img.Pix
	stride := img.Stride

	// 0=transparent, 1=black border, 2=white fill
	cursor := [20][12]byte{
		{1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
		{1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
		{1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0},
		{1, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0},
		{1, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0},
		{1, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0},
		{1, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0},
		{1, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0, 0},
		{1, 2, 2, 2, 2, 2, 2, 2, 1, 0, 0, 0},
		{1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 0, 0},
		{1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 0},
		{1, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1},
		{1, 2, 2, 2, 1, 2, 2, 1, 0, 0, 0, 0},
		{1, 2, 2, 1, 0, 1, 2, 2, 1, 0, 0, 0},
		{1, 2, 1, 0, 0, 1, 2, 2, 1, 0, 0, 0},
		{1, 1, 0, 0, 0, 0, 1, 2, 2, 1, 0, 0},
		{1, 0, 0, 0, 0, 0, 1, 2, 2, 1, 0, 0},
		{0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 1, 0},
		{0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 1, 0},
		{0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0},
	}

	for dy := 0; dy < 20; dy++ {
		py := cy + dy
		if py < 0 || py >= h {
			continue
		}
		for dx := 0; dx < 12; dx++ {
			px := cx + dx
			if px < 0 || px >= w {
				continue
			}
			v := cursor[dy][dx]
			if v == 0 {
				continue
			}
			off := py*stride + px*4
			if v == 1 {
				pix[off+0] = 0
				pix[off+1] = 0
				pix[off+2] = 0
				pix[off+3] = 255
			} else {
				pix[off+0] = 255
				pix[off+1] = 255
				pix[off+2] = 255
				pix[off+3] = 255
			}
		}
	}
}
