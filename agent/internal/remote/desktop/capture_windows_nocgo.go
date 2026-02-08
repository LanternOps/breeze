//go:build windows && !cgo

package desktop

import (
	"fmt"
	"image"
	"sync"
	"syscall"
	"unsafe"
)

var (
	// user32 is already declared in input_windows.go (same package)
	gdi32 = syscall.NewLazyDLL("gdi32.dll")

	procGetDC              = user32.NewProc("GetDC")
	procReleaseDC          = user32.NewProc("ReleaseDC")
	procGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	procSetProcessDPIAware = user32.NewProc("SetProcessDPIAware")

	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
)

const (
	smCxScreen   = 0
	smCyScreen   = 1
	srcCopy      = 0x00CC0020
	biRGB        = 0
	dibRGBColors = 0
)

type bitmapInfoHeader struct {
	BiSize          uint32
	BiWidth         int32
	BiHeight        int32
	BiPlanes        uint16
	BiBitCount      uint16
	BiCompression   uint32
	BiSizeImage     uint32
	BiXPelsPerMeter int32
	BiYPelsPerMeter int32
	BiClrUsed       uint32
	BiClrImportant  uint32
}

type bitmapInfo struct {
	BmiHeader bitmapInfoHeader
	BmiColors [1]uint32
}

// gdiCapturer implements ScreenCapturer using Windows GDI (no CGo required).
// GDI handles are created once and reused across frames for performance.
type gdiCapturer struct {
	config CaptureConfig
	mu     sync.Mutex

	// Persistent GDI handles
	screenDC  uintptr
	memDC     uintptr
	hBitmap   uintptr
	oldBitmap uintptr
	bi        bitmapInfo
	width     int
	height    int
	inited    bool

	// Reusable pixel buffer (BGRA from GetDIBits)
	pixBuf []byte
}

func init() {
	if procSetProcessDPIAware.Find() == nil {
		procSetProcessDPIAware.Call()
	}
}

func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	return &gdiCapturer{config: config}, nil
}

// ensureHandles creates or recreates GDI handles if needed.
func (c *gdiCapturer) ensureHandles() error {
	w, _, _ := procGetSystemMetrics.Call(smCxScreen)
	h, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if w == 0 || h == 0 {
		return fmt.Errorf("GetSystemMetrics returned zero dimensions")
	}
	width := int(w)
	height := int(h)

	// If handles exist and resolution hasn't changed, reuse them
	if c.inited && c.width == width && c.height == height {
		return nil
	}

	// Release old handles if resolution changed
	c.releaseHandles()

	// Get screen DC
	hdc, _, _ := procGetDC.Call(0)
	if hdc == 0 {
		return fmt.Errorf("GetDC failed")
	}

	// Create compatible memory DC
	memDC, _, _ := procCreateCompatibleDC.Call(hdc)
	if memDC == 0 {
		procReleaseDC.Call(0, hdc)
		return fmt.Errorf("CreateCompatibleDC failed")
	}

	// Create compatible bitmap
	hBitmap, _, _ := procCreateCompatibleBitmap.Call(hdc, uintptr(width), uintptr(height))
	if hBitmap == 0 {
		procDeleteDC.Call(memDC)
		procReleaseDC.Call(0, hdc)
		return fmt.Errorf("CreateCompatibleBitmap failed")
	}

	// Select bitmap into memory DC
	oldBitmap, _, _ := procSelectObject.Call(memDC, hBitmap)
	if oldBitmap == 0 {
		procDeleteObject.Call(hBitmap)
		procDeleteDC.Call(memDC)
		procReleaseDC.Call(0, hdc)
		return fmt.Errorf("SelectObject failed")
	}

	c.screenDC = hdc
	c.memDC = memDC
	c.hBitmap = hBitmap
	c.oldBitmap = oldBitmap
	c.width = width
	c.height = height
	c.inited = true

	// Pre-allocate pixel buffer and BITMAPINFO
	c.pixBuf = make([]byte, width*height*4)
	c.bi = bitmapInfo{
		BmiHeader: bitmapInfoHeader{
			BiSize:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
			BiWidth:       int32(width),
			BiHeight:      -int32(height), // negative = top-down
			BiPlanes:      1,
			BiBitCount:    32,
			BiCompression: biRGB,
		},
	}

	return nil
}

// releaseHandles frees all persistent GDI handles.
func (c *gdiCapturer) releaseHandles() {
	if !c.inited {
		return
	}
	if c.oldBitmap != 0 && c.memDC != 0 {
		procSelectObject.Call(c.memDC, c.oldBitmap)
	}
	if c.hBitmap != 0 {
		procDeleteObject.Call(c.hBitmap)
	}
	if c.memDC != 0 {
		procDeleteDC.Call(c.memDC)
	}
	if c.screenDC != 0 {
		procReleaseDC.Call(0, c.screenDC)
	}
	c.inited = false
	c.screenDC = 0
	c.memDC = 0
	c.hBitmap = 0
	c.oldBitmap = 0
}

// Capture captures the entire screen using persistent GDI handles.
func (c *gdiCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := c.ensureHandles(); err != nil {
		return nil, err
	}

	// BitBlt the screen into our reusable bitmap
	ret, _, _ := procBitBlt.Call(c.memDC, 0, 0, uintptr(c.width), uintptr(c.height),
		c.screenDC, 0, 0, srcCopy)
	if ret == 0 {
		return nil, fmt.Errorf("BitBlt failed")
	}

	// GetDIBits into reusable pixel buffer
	ret, _, _ = procGetDIBits.Call(
		c.memDC,
		c.hBitmap,
		0,
		uintptr(c.height),
		uintptr(unsafe.Pointer(&c.pixBuf[0])),
		uintptr(unsafe.Pointer(&c.bi)),
		dibRGBColors,
	)
	if ret == 0 {
		return nil, fmt.Errorf("GetDIBits failed")
	}

	// Convert BGRA to RGBA into a pooled image
	img := captureImagePool.Get(c.width, c.height)
	bgraToRGBA(c.pixBuf, img.Pix, c.width*c.height)

	return img, nil
}

// CaptureRegion captures a specific region of the screen.
func (c *gdiCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	fullImg, err := c.Capture()
	if err != nil {
		return nil, err
	}

	bounds := image.Rect(x, y, x+width, y+height)
	if !bounds.In(fullImg.Bounds()) {
		captureImagePool.Put(fullImg)
		return nil, fmt.Errorf("region out of bounds")
	}

	cropped := image.NewRGBA(image.Rect(0, 0, width, height))
	for dy := 0; dy < height; dy++ {
		srcStart := (y+dy)*fullImg.Stride + x*4
		dstStart := dy * cropped.Stride
		copy(cropped.Pix[dstStart:dstStart+width*4], fullImg.Pix[srcStart:srcStart+width*4])
	}

	captureImagePool.Put(fullImg)
	return cropped, nil
}

// GetScreenBounds returns the primary screen dimensions.
func (c *gdiCapturer) GetScreenBounds() (width, height int, err error) {
	w, _, _ := procGetSystemMetrics.Call(smCxScreen)
	h, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if w == 0 || h == 0 {
		return 0, 0, fmt.Errorf("GetSystemMetrics returned zero dimensions")
	}
	return int(w), int(h), nil
}

// Close releases persistent GDI handles.
func (c *gdiCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.releaseHandles()
	return nil
}

var _ ScreenCapturer = (*gdiCapturer)(nil)
