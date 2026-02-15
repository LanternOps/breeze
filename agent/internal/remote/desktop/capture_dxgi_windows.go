//go:build windows && !cgo

package desktop

import (
	"fmt"
	"image"
	"log/slog"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// DXGI/D3D11 DLL procs
var (
	d3d11DLL   = syscall.NewLazyDLL("d3d11.dll")
	kernel32   = syscall.NewLazyDLL("kernel32.dll")

	procD3D11CreateDevice = d3d11DLL.NewProc("D3D11CreateDevice")

	// Desktop switching — needed to follow UAC/lock screen secure desktop.
	procOpenInputDesktop  = user32.NewProc("OpenInputDesktop")
	procSetThreadDesktop  = user32.NewProc("SetThreadDesktop")
	procGetThreadDesktop  = user32.NewProc("GetThreadDesktop")
	procCloseDesktop      = user32.NewProc("CloseDesktop")
	procGetCurrentThreadId = kernel32.NewProc("GetCurrentThreadId")
)

// D3D11/DXGI constants
const (
	d3dDriverTypeHardware = 1
	d3dFeatureLevel11_0   = 0xb000
	d3d11SDKVersion       = 7

	// D3D11CreateDevice flags
	d3d11CreateDeviceBGRASupport  = 0x20
	d3d11CreateDeviceVideoSupport = 0x800

	d3d11UsageStaging  = 3
	d3d11CPUAccessRead = 0x20000
	dxgiFormatB8G8R8A8 = 87

	dxgiErrWaitTimeout   = 0x887A0027
	dxgiErrAccessLost    = 0x887A0026
	dxgiErrDeviceRemoved = 0x887A0005
	dxgiErrDeviceReset   = 0x887A0007

	// Desktop access rights for OpenInputDesktop (GENERIC_ALL).
	// Required to attach to the secure desktop (UAC, lock screen).
	desktopGenericAll = 0x10000000

	// DXGI/D3D11 COM vtable indices
	dxgiDeviceGetAdapter       = 7  // IDXGIDevice (after IUnknown+IDXGIObject)
	dxgiAdapterEnumOutputs     = 7  // IDXGIAdapter
	dxgiOutput1DuplicateOutput = 22 // IDXGIOutput1
	dxgiDuplGetDesc            = 7  // IDXGIOutputDuplication
	dxgiDuplAcquireNextFrame   = 8  // IDXGIOutputDuplication
	dxgiDuplReleaseFrame       = 14 // IDXGIOutputDuplication
	d3d11DeviceCreateTexture2D = 5  // ID3D11Device
	d3d11CtxMap                = 14 // ID3D11DeviceContext
	d3d11CtxUnmap              = 15 // ID3D11DeviceContext
	d3d11CtxCopyResource       = 47 // ID3D11DeviceContext
)

// COM GUIDs for DXGI interfaces
var (
	iidIDXGIDevice     = comGUID{0x54ec77fa, 0x1377, 0x44e6, [8]byte{0x8c, 0x32, 0x88, 0xfd, 0x5f, 0x44, 0xc8, 0x4c}}
	iidID3D11Texture2D = comGUID{0x6f15aaf2, 0xd208, 0x4e89, [8]byte{0x9a, 0xb4, 0x48, 0x95, 0x35, 0xd3, 0x4f, 0x9c}}
	iidIDXGIOutput1    = comGUID{0x00cddea8, 0x939b, 0x4b83, [8]byte{0xa3, 0x40, 0xa6, 0x85, 0x22, 0x66, 0x66, 0xcc}}
)

// d3d11Texture2DDesc matches D3D11_TEXTURE2D_DESC (44 bytes).
type d3d11Texture2DDesc struct {
	Width          uint32
	Height         uint32
	MipLevels      uint32
	ArraySize      uint32
	Format         uint32
	SampleCount    uint32 // DXGI_SAMPLE_DESC.Count
	SampleQuality  uint32 // DXGI_SAMPLE_DESC.Quality
	Usage          uint32
	BindFlags      uint32
	CPUAccessFlags uint32
	MiscFlags      uint32
}

// d3d11MappedSubresource matches D3D11_MAPPED_SUBRESOURCE.
type d3d11MappedSubresource struct {
	PData      uintptr
	RowPitch   uint32
	DepthPitch uint32
}

type dxgiRational struct {
	Numerator   uint32
	Denominator uint32
}

// dxgiModeDesc matches DXGI_MODE_DESC.
type dxgiModeDesc struct {
	Width            uint32
	Height           uint32
	RefreshRate      dxgiRational
	Format           uint32
	ScanlineOrdering uint32
	Scaling          uint32
}

// dxgiOutDuplDesc matches DXGI_OUTDUPL_DESC.
type dxgiOutDuplDesc struct {
	ModeDesc                   dxgiModeDesc
	Rotation                   uint32
	DesktopImageInSystemMemory int32 // BOOL
}

// dxgiOutDuplFrameInfo matches DXGI_OUTDUPL_FRAME_INFO.
type dxgiOutDuplFrameInfo struct {
	LastPresentTime           int64
	LastMouseUpdateTime       int64
	AccumulatedFrames         uint32
	RectsCoalesced            int32
	ProtectedContentMaskedOut int32
	PointerPositionX          int32
	PointerPositionY          int32
	PointerVisible            int32
	TotalMetadataBufferSize   uint32
	PointerShapeBufferSize    uint32
}

// dxgiCapturer implements ScreenCapturer using DXGI Desktop Duplication (pure Go, no CGO).
// Falls back to GDI on init failure.
type dxgiCapturer struct {
	config CaptureConfig
	mu     sync.Mutex

	// D3D11/DXGI COM objects
	device      uintptr // ID3D11Device
	context     uintptr // ID3D11DeviceContext
	duplication uintptr // IDXGIOutputDuplication
	staging     uintptr // ID3D11Texture2D (staging, CPU-readable)
	gpuTexture  uintptr // ID3D11Texture2D (DEFAULT usage, RENDER_TARGET bind, for GPU pipeline)

	width  int
	height int
	inited bool

	// True when CaptureTexture has an in-flight AcquireNextFrame that hasn't been released yet.
	textureFrameAcquired bool

	// Desktop handle opened via OpenInputDesktop for secure desktop capture.
	// Closed on next switch or release. Zero means no explicit desktop switch.
	currentDesktop uintptr

	// Last AcquireNextFrame accumulated count
	lastAccumulatedFrames uint32

	// Failure tracking for GDI fallback
	consecutiveFailures int
	gdiFallback         *gdiCapturer
}

// newPlatformCapturer tries DXGI Desktop Duplication first, falls back to GDI.
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	c := &dxgiCapturer{config: config}
	if err := c.initDXGI(); err != nil {
		slog.Warn("DXGI Desktop Duplication unavailable, falling back to GDI", "error", err)
		return &gdiCapturer{config: config}, nil
	}
	slog.Info("DXGI Desktop Duplication initialized",
		"width", c.width, "height", c.height)
	return c, nil
}

func (c *dxgiCapturer) initDXGI() error {
	// D3D11CreateDevice
	var device, context uintptr
	featureLevel := uint32(d3dFeatureLevel11_0)
	var actualLevel uint32

	flags := uintptr(d3d11CreateDeviceBGRASupport | d3d11CreateDeviceVideoSupport)
	hr, _, _ := procD3D11CreateDevice.Call(
		0,                                      // pAdapter (NULL = default)
		uintptr(d3dDriverTypeHardware),         // DriverType
		0,                                      // Software
		flags,                                  // Flags
		uintptr(unsafe.Pointer(&featureLevel)), // pFeatureLevels
		1,                                      // FeatureLevels count
		uintptr(d3d11SDKVersion),               // SDKVersion
		uintptr(unsafe.Pointer(&device)),       // ppDevice
		uintptr(unsafe.Pointer(&actualLevel)),  // pFeatureLevel
		uintptr(unsafe.Pointer(&context)),      // ppImmediateContext
	)
	if int32(hr) < 0 && flags != 0 {
		// Some systems/drivers reject VIDEO_SUPPORT. Fall back to a plain device.
		hr, _, _ = procD3D11CreateDevice.Call(
			0,
			uintptr(d3dDriverTypeHardware),
			0,
			0,
			uintptr(unsafe.Pointer(&featureLevel)),
			1,
			uintptr(d3d11SDKVersion),
			uintptr(unsafe.Pointer(&device)),
			uintptr(unsafe.Pointer(&actualLevel)),
			uintptr(unsafe.Pointer(&context)),
		)
	}
	if int32(hr) < 0 {
		return fmt.Errorf("D3D11CreateDevice failed: 0x%08X", uint32(hr))
	}

	// QueryInterface → IDXGIDevice
	var dxgiDevice uintptr
	_, err := comCall(device, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidIDXGIDevice)),
		uintptr(unsafe.Pointer(&dxgiDevice)),
	)
	if err != nil {
		comRelease(context)
		comRelease(device)
		return fmt.Errorf("QueryInterface IDXGIDevice: %w", err)
	}
	defer comRelease(dxgiDevice)

	// GetAdapter
	var adapter uintptr
	_, err = comCall(dxgiDevice, dxgiDeviceGetAdapter, uintptr(unsafe.Pointer(&adapter)))
	if err != nil {
		comRelease(context)
		comRelease(device)
		return fmt.Errorf("IDXGIDevice::GetAdapter: %w", err)
	}
	defer comRelease(adapter)

	// EnumOutputs
	var output uintptr
	_, err = comCall(adapter, dxgiAdapterEnumOutputs,
		uintptr(c.config.DisplayIndex),
		uintptr(unsafe.Pointer(&output)),
	)
	if err != nil {
		comRelease(context)
		comRelease(device)
		return fmt.Errorf("IDXGIAdapter::EnumOutputs: %w", err)
	}

	// QueryInterface → IDXGIOutput1
	var output1 uintptr
	_, err = comCall(output, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidIDXGIOutput1)),
		uintptr(unsafe.Pointer(&output1)),
	)
	comRelease(output)
	if err != nil {
		comRelease(context)
		comRelease(device)
		return fmt.Errorf("QueryInterface IDXGIOutput1: %w", err)
	}
	defer comRelease(output1)

	// DuplicateOutput
	var duplication uintptr
	_, err = comCall(output1, dxgiOutput1DuplicateOutput,
		device,
		uintptr(unsafe.Pointer(&duplication)),
	)
	if err != nil {
		comRelease(context)
		comRelease(device)
		return fmt.Errorf("IDXGIOutput1::DuplicateOutput: %w", err)
	}

	// Get output dimensions deterministically from duplication.GetDesc().
	// Avoid AcquireNextFrame probing: it can time out during init (no desktop updates yet),
	// and fallbacks like GetSystemMetrics are wrong for non-primary displays.
	var duplDesc dxgiOutDuplDesc
	hrGetDesc, _, _ := syscall.SyscallN(
		comVtblFn(duplication, dxgiDuplGetDesc),
		duplication,
		uintptr(unsafe.Pointer(&duplDesc)),
	)
	if int32(hrGetDesc) < 0 {
		comRelease(duplication)
		comRelease(context)
		comRelease(device)
		return fmt.Errorf("IDXGIOutputDuplication::GetDesc failed: 0x%08X", uint32(hrGetDesc))
	}
	width := int(duplDesc.ModeDesc.Width)
	height := int(duplDesc.ModeDesc.Height)
	if width <= 0 || height <= 0 {
		comRelease(duplication)
		comRelease(context)
		comRelease(device)
		return fmt.Errorf("invalid duplication dimensions: %dx%d", width, height)
	}

	// Create persistent staging texture
	stagingDesc := d3d11Texture2DDesc{
		Width:          uint32(width),
		Height:         uint32(height),
		MipLevels:      1,
		ArraySize:      1,
		Format:         dxgiFormatB8G8R8A8,
		SampleCount:    1,
		SampleQuality:  0,
		Usage:          d3d11UsageStaging,
		BindFlags:      0,
		CPUAccessFlags: d3d11CPUAccessRead,
		MiscFlags:      0,
	}
	var staging uintptr
	_, err = comCall(device, d3d11DeviceCreateTexture2D,
		uintptr(unsafe.Pointer(&stagingDesc)),
		0, // pInitialData
		uintptr(unsafe.Pointer(&staging)),
	)
	if err != nil {
		comRelease(duplication)
		comRelease(context)
		comRelease(device)
		return fmt.Errorf("CreateTexture2D staging: %w", err)
	}

	// Create GPU-only texture for zero-copy pipeline (video processor input).
	// Must have DEFAULT usage and RENDER_TARGET bind for CreateVideoProcessorInputView.
	gpuDesc := d3d11Texture2DDesc{
		Width:          uint32(width),
		Height:         uint32(height),
		MipLevels:      1,
		ArraySize:      1,
		Format:         dxgiFormatB8G8R8A8,
		SampleCount:    1,
		SampleQuality:  0,
		Usage:          0, // D3D11_USAGE_DEFAULT
		BindFlags:      d3d11BindRenderTarget,
		CPUAccessFlags: 0,
		MiscFlags:      0,
	}
	var gpuTexture uintptr
	_, err = comCall(device, d3d11DeviceCreateTexture2D,
		uintptr(unsafe.Pointer(&gpuDesc)),
		0, // pInitialData
		uintptr(unsafe.Pointer(&gpuTexture)),
	)
	if err != nil {
		// Non-fatal: GPU pipeline won't work but CPU path is fine
		slog.Warn("Failed to create GPU texture for video processor pipeline", "error", err)
	}

	c.device = device
	c.context = context
	c.duplication = duplication
	c.staging = staging
	c.gpuTexture = gpuTexture
	c.width = width
	c.height = height
	c.inited = true

	return nil
}

// comVtblFn resolves a COM vtable function pointer by index.
func comVtblFn(obj uintptr, idx int) uintptr {
	vtablePtr := *(*uintptr)(unsafe.Pointer(obj))
	return *(*uintptr)(unsafe.Pointer(vtablePtr + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
}

// Capture acquires the next desktop frame via DXGI.
// Returns nil, nil when no new frame is available (AccumulatedFrames==0).
func (c *dxgiCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// If we've fallen back to GDI, delegate
	if c.gdiFallback != nil {
		return c.gdiFallback.Capture()
	}

	if !c.inited {
		return nil, fmt.Errorf("DXGI capturer not initialized")
	}

	var frameInfo dxgiOutDuplFrameInfo
	var resource uintptr

	// 100ms timeout reduces idle CPU polling from ~62/sec to ~10/sec.
	// AcquireNextFrame returns immediately when a new frame is available
	// (regardless of timeout), so this doesn't add latency for active content.
	hr, _, _ := syscall.SyscallN(
		comVtblFn(c.duplication, dxgiDuplAcquireNextFrame),
		c.duplication,
		uintptr(100),
		uintptr(unsafe.Pointer(&frameInfo)),
		uintptr(unsafe.Pointer(&resource)),
	)

	hresult := uint32(hr)

	if hresult == dxgiErrWaitTimeout {
		c.lastAccumulatedFrames = 0
		return nil, nil // No new frame
	}

	if hresult == dxgiErrAccessLost {
		slog.Warn("DXGI access lost (desktop switch/resolution change), reinitializing")
		c.releaseDXGI()
		// Try switching to the active input desktop. This handles UAC/lock
		// screen transitions where Windows moves to the Secure Desktop.
		c.switchToInputDesktop()
		time.Sleep(200 * time.Millisecond)
		if err := c.initDXGI(); err != nil {
			slog.Warn("DXGI reinit failed, falling back to GDI", "error", err)
			c.switchToGDI()
			return c.gdiFallback.Capture()
		}
		return nil, nil
	}

	if hresult == dxgiErrDeviceRemoved || hresult == dxgiErrDeviceReset {
		c.consecutiveFailures++
		slog.Warn("DXGI device error", "hresult", fmt.Sprintf("0x%08X", hresult),
			"failures", c.consecutiveFailures)
		c.releaseDXGI()
		if c.consecutiveFailures >= 3 {
			slog.Warn("Too many DXGI failures, falling back to GDI permanently")
			c.switchToGDI()
			return c.gdiFallback.Capture()
		}
		c.switchToInputDesktop()
		time.Sleep(500 * time.Millisecond)
		if err := c.initDXGI(); err != nil {
			c.switchToGDI()
			return c.gdiFallback.Capture()
		}
		return nil, nil
	}

	if int32(hr) < 0 {
		return nil, fmt.Errorf("AcquireNextFrame: 0x%08X", hresult)
	}

	// Success — reset failure counter
	c.consecutiveFailures = 0
	c.lastAccumulatedFrames = frameInfo.AccumulatedFrames

	// No new frames accumulated — skip
	if frameInfo.AccumulatedFrames == 0 {
		comRelease(resource)
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return nil, nil
	}

	// QueryInterface → ID3D11Texture2D
	var texture uintptr
	_, err := comCall(resource, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidID3D11Texture2D)),
		uintptr(unsafe.Pointer(&texture)),
	)
	comRelease(resource)
	if err != nil {
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return nil, fmt.Errorf("QueryInterface ID3D11Texture2D: %w", err)
	}

	// CopyResource(staging, texture) — GPU-to-GPU copy
	copyHr, _, _ := syscall.SyscallN(
		comVtblFn(c.context, d3d11CtxCopyResource),
		c.context,
		c.staging,
		texture,
	)
	if int32(copyHr) < 0 {
		comRelease(texture)
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return nil, fmt.Errorf("CopyResource failed: 0x%08X", uint32(copyHr))
	}
	comRelease(texture)

	// Map staging texture
	var mapped d3d11MappedSubresource
	hr, _, _ = syscall.SyscallN(
		comVtblFn(c.context, d3d11CtxMap),
		c.context,
		c.staging,
		0, // Subresource
		1, // D3D11_MAP_READ
		0, // Flags
		uintptr(unsafe.Pointer(&mapped)),
	)
	if int32(hr) < 0 {
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return nil, fmt.Errorf("Map staging texture: 0x%08X", uint32(hr))
	}

	// Copy BGRA data directly into pooled image — single copy, no intermediate buffer.
	img := captureImagePool.Get(c.width, c.height)
	rowPitch := int(mapped.RowPitch)
	rowBytes := c.width * 4
	if rowPitch == rowBytes {
		// Fast path: no padding, single memcpy
		src := unsafe.Slice((*byte)(unsafe.Pointer(mapped.PData)), c.height*rowPitch)
		copy(img.Pix, src)
	} else {
		// Handle RowPitch > width*4 (GPU alignment padding)
		for y := 0; y < c.height; y++ {
			srcRow := unsafe.Slice((*byte)(unsafe.Pointer(mapped.PData+uintptr(y*rowPitch))), rowBytes)
			copy(img.Pix[y*rowBytes:], srcRow)
		}
	}

	// Unmap + ReleaseFrame
	syscall.SyscallN(comVtblFn(c.context, d3d11CtxUnmap), c.context, c.staging, 0)
	syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)

	return img, nil
}

// CaptureRegion captures a specific region via full capture + crop.
func (c *dxgiCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	fullImg, err := c.Capture()
	if err != nil {
		return nil, err
	}
	if fullImg == nil {
		return nil, nil
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

// GetScreenBounds returns the screen dimensions.
func (c *dxgiCapturer) GetScreenBounds() (width, height int, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.gdiFallback != nil {
		return c.gdiFallback.GetScreenBounds()
	}

	if c.inited && c.width > 0 && c.height > 0 {
		return c.width, c.height, nil
	}

	w, _, _ := procGetSystemMetrics.Call(smCxScreen)
	h, _, _ := procGetSystemMetrics.Call(smCyScreen)
	if w == 0 || h == 0 {
		return 0, 0, fmt.Errorf("GetSystemMetrics returned zero dimensions")
	}
	return int(w), int(h), nil
}

// Close releases all DXGI resources.
func (c *dxgiCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.gdiFallback != nil {
		c.closeDesktopHandle()
		return c.gdiFallback.Close()
	}
	c.releaseDXGI()
	c.closeDesktopHandle()
	return nil
}

func (c *dxgiCapturer) releaseDXGI() {
	if !c.inited {
		return
	}
	// Best-effort: ensure we don't leave an acquired frame hanging.
	if c.textureFrameAcquired && c.duplication != 0 {
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
	}
	c.textureFrameAcquired = false
	if c.gpuTexture != 0 {
		comRelease(c.gpuTexture)
		c.gpuTexture = 0
	}
	if c.staging != 0 {
		comRelease(c.staging)
		c.staging = 0
	}
	if c.duplication != 0 {
		comRelease(c.duplication)
		c.duplication = 0
	}
	if c.context != 0 {
		comRelease(c.context)
		c.context = 0
	}
	if c.device != 0 {
		comRelease(c.device)
		c.device = 0
	}
	c.inited = false
}

// closeDesktopHandle closes the desktop handle opened via OpenInputDesktop.
// Called during final cleanup (Close).
func (c *dxgiCapturer) closeDesktopHandle() {
	if c.currentDesktop != 0 {
		procCloseDesktop.Call(c.currentDesktop)
		c.currentDesktop = 0
	}
}

// switchToInputDesktop attempts to switch the calling thread to the currently
// active input desktop. This allows DXGI Desktop Duplication to capture the
// Secure Desktop (UAC prompts, lock screen, Ctrl+Alt+Del) when the agent runs
// as an elevated process. Returns true if the desktop was switched.
//
// Must be called before initDXGI() — DuplicateOutput binds to whichever
// desktop is current on the calling thread.
func (c *dxgiCapturer) switchToInputDesktop() bool {
	// Pin the goroutine to its OS thread. SetThreadDesktop is per-thread,
	// and DXGI COM objects have thread affinity. Safe to call multiple times
	// (increments internal counter). We intentionally never unlock because
	// the capture loop should stay on one thread for the session lifetime.
	runtime.LockOSThread()

	// Open the currently active input desktop.
	hDesk, _, err := procOpenInputDesktop.Call(
		0,                           // dwFlags
		0,                           // fInherit (FALSE)
		uintptr(desktopGenericAll), // dwDesiredAccess
	)
	if hDesk == 0 {
		slog.Warn("OpenInputDesktop failed", "error", err)
		return false
	}

	// Attempt to switch. SetThreadDesktop fails if the thread has any
	// windows or hooks on the current desktop, which shouldn't apply to
	// our capture goroutine.
	ret, _, err := procSetThreadDesktop.Call(hDesk)
	if ret == 0 {
		// Fails with ERROR_INVALID_PARAMETER if already on this desktop,
		// or ACCESS_DENIED if the thread owns windows. Either way, clean up.
		procCloseDesktop.Call(hDesk)
		slog.Debug("SetThreadDesktop failed (may already be on input desktop)", "error", err)
		return false
	}

	// Close the previous desktop handle we opened (if any).
	if c.currentDesktop != 0 {
		procCloseDesktop.Call(c.currentDesktop)
	}
	c.currentDesktop = hDesk

	slog.Info("Switched to input desktop for secure desktop capture",
		"desktop", fmt.Sprintf("0x%X", hDesk))
	return true
}

func (c *dxgiCapturer) switchToGDI() {
	c.releaseDXGI()
	c.gdiFallback = &gdiCapturer{config: c.config}
	slog.Info("Switched to GDI screen capture fallback")
}

// TightLoop implements TightLoopHint.
func (c *dxgiCapturer) TightLoop() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gdiFallback == nil && c.inited
}

// IsBGRA implements BGRAProvider.
//
// When DXGI is active, Capture() returns BGRA bytes stored in image.RGBA.Pix.
// When operating in GDI fallback mode, the underlying gdiCapturer returns true RGBA.
func (c *dxgiCapturer) IsBGRA() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gdiFallback == nil && c.inited
}

// AccumulatedFrames implements FrameChangeHint.
func (c *dxgiCapturer) AccumulatedFrames() uint32 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastAccumulatedFrames
}

// CaptureTexture acquires a frame and copies it to the GPU texture
// (DEFAULT usage, RENDER_TARGET bind), returning the handle without
// mapping to CPU memory. Returns 0, nil when no new frame is available.
func (c *dxgiCapturer) CaptureTexture() (uintptr, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.gdiFallback != nil || !c.inited {
		return 0, nil
	}
	if c.textureFrameAcquired {
		// This indicates caller misuse: they didn't call ReleaseTexture().
		// Protect against re-entrancy and overwriting the shared gpuTexture.
		return 0, fmt.Errorf("previous DXGI frame not released")
	}

	// GPU texture is required for the video processor pipeline
	if c.gpuTexture == 0 {
		return 0, fmt.Errorf("GPU texture not available")
	}

	var frameInfo dxgiOutDuplFrameInfo
	var resource uintptr

	hr, _, _ := syscall.SyscallN(
		comVtblFn(c.duplication, dxgiDuplAcquireNextFrame),
		c.duplication,
		uintptr(100),
		uintptr(unsafe.Pointer(&frameInfo)),
		uintptr(unsafe.Pointer(&resource)),
	)

	hresult := uint32(hr)
	if hresult == dxgiErrWaitTimeout {
		c.lastAccumulatedFrames = 0
		return 0, nil
	}
	if hresult == dxgiErrAccessLost {
		slog.Warn("DXGI access lost during GPU capture (desktop switch/resolution change), reinitializing")
		c.releaseDXGI()
		c.switchToInputDesktop()
		time.Sleep(200 * time.Millisecond)
		if err := c.initDXGI(); err != nil {
			slog.Warn("DXGI reinit failed after access lost (GPU capture), falling back to GDI", "error", err)
			c.switchToGDI()
		}
		return 0, nil
	}
	if hresult == dxgiErrDeviceRemoved || hresult == dxgiErrDeviceReset {
		c.consecutiveFailures++
		slog.Warn("DXGI device error during GPU capture", "hresult", fmt.Sprintf("0x%08X", hresult),
			"failures", c.consecutiveFailures)
		c.releaseDXGI()
		if c.consecutiveFailures >= 3 {
			slog.Warn("Too many DXGI failures (GPU capture), falling back to GDI permanently")
			c.switchToGDI()
			return 0, nil
		}
		c.switchToInputDesktop()
		time.Sleep(500 * time.Millisecond)
		if err := c.initDXGI(); err != nil {
			c.switchToGDI()
			return 0, nil
		}
		return 0, nil
	}
	if int32(hr) < 0 {
		return 0, fmt.Errorf("AcquireNextFrame: 0x%08X", hresult)
	}

	c.consecutiveFailures = 0
	c.lastAccumulatedFrames = frameInfo.AccumulatedFrames

	if frameInfo.AccumulatedFrames == 0 {
		comRelease(resource)
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return 0, nil
	}

	// QueryInterface → ID3D11Texture2D
	var texture uintptr
	_, err := comCall(resource, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidID3D11Texture2D)),
		uintptr(unsafe.Pointer(&texture)),
	)
	comRelease(resource)
	if err != nil {
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return 0, fmt.Errorf("QueryInterface ID3D11Texture2D: %w", err)
	}

	// CopyResource(gpuTexture, texture) — GPU-to-GPU copy into DEFAULT-usage texture
	// This texture has RENDER_TARGET bind, compatible with video processor input views.
	copyHr, _, _ := syscall.SyscallN(
		comVtblFn(c.context, d3d11CtxCopyResource),
		c.context,
		c.gpuTexture,
		texture,
	)
	if int32(copyHr) < 0 {
		comRelease(texture)
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
		return 0, fmt.Errorf("CopyResource failed: 0x%08X", uint32(copyHr))
	}
	comRelease(texture)

	// Return GPU texture handle — caller must call ReleaseTexture()
	c.textureFrameAcquired = true
	return c.gpuTexture, nil
}

// ReleaseTexture releases the DXGI frame acquired by CaptureTexture.
func (c *dxgiCapturer) ReleaseTexture() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.textureFrameAcquired {
		return
	}
	if c.duplication != 0 {
		syscall.SyscallN(comVtblFn(c.duplication, dxgiDuplReleaseFrame), c.duplication)
	}
	c.textureFrameAcquired = false
}

// GetD3D11Device returns the D3D11 device handle.
func (c *dxgiCapturer) GetD3D11Device() uintptr {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.device
}

// GetD3D11Context returns the immediate device context handle.
func (c *dxgiCapturer) GetD3D11Context() uintptr {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.context
}

var (
	_ ScreenCapturer  = (*dxgiCapturer)(nil)
	_ BGRAProvider    = (*dxgiCapturer)(nil)
	_ TightLoopHint   = (*dxgiCapturer)(nil)
	_ FrameChangeHint = (*dxgiCapturer)(nil)
	_ TextureProvider = (*dxgiCapturer)(nil)
)
