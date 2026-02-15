//go:build windows

package desktop

import (
	"image"
	"unsafe"
)

var (
	procGetCursorInfo = user32.NewProc("GetCursorInfo")
	procGetIconInfo   = user32.NewProc("GetIconInfo")
)

const cursorShowing = 0x00000001

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
func (c *dxgiCapturer) CursorPosition() (x, y int32, visible bool) {
	var ci cursorInfoW
	ci.CbSize = uint32(unsafe.Sizeof(ci))
	ret, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci)))
	if ret == 0 {
		return 0, 0, false
	}
	return ci.PtScreenPos.X, ci.PtScreenPos.Y, ci.Flags&cursorShowing != 0
}

var _ CursorProvider = (*dxgiCapturer)(nil)

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
