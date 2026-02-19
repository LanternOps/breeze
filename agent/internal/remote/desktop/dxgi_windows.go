//go:build windows && !cgo

package desktop

import (
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
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
	procOpenInputDesktop        = user32.NewProc("OpenInputDesktop")
	procSetThreadDesktop        = user32.NewProc("SetThreadDesktop")
	procGetThreadDesktop        = user32.NewProc("GetThreadDesktop")
	procCloseDesktop            = user32.NewProc("CloseDesktop")
	procGetCurrentThreadId      = kernel32.NewProc("GetCurrentThreadId")
	procGetUserObjectInformationW = user32.NewProc("GetUserObjectInformationW")
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
	dxgiErrInvalidCall   = 0x887A0001
	dxgiErrDeviceRemoved = 0x887A0005
	dxgiErrDeviceReset   = 0x887A0007

	// Desktop access rights for OpenInputDesktop (GENERIC_ALL).
	// Required to attach to the secure desktop (UAC, lock screen).
	desktopGenericAll = 0x10000000

	// GetUserObjectInformation index for desktop name (UOI_NAME).
	uoiName = 2

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
	d3d11CtxFlush              = 111 // ID3D11DeviceContext::Flush (void, no params beyond this)
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

	width    int    // logical desktop dimensions (post-rotation, what the user sees)
	height   int
	texWidth  int   // native texture dimensions (pre-rotation, what DXGI returns)
	texHeight int
	rotation uint32 // DXGI_MODE_ROTATION (0=unspecified, 1=identity, 2=90, 3=180, 4=270)
	inited   bool

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

	// Diagnostic counters for debugging capture failures
	diagTimeouts      int
	diagZeroFrames    int
	diagSuccessFrames int
	diagLogInterval   int // log every N skips

	// Periodic desktop check: detect UAC/lock screen transitions that
	// don't trigger DXGI_ERROR_ACCESS_LOST (Secure Desktop activation
	// may just cause timeouts instead).
	lastDesktopCheck time.Time

	// Desktop switch notification for the session layer.
	desktopSwitchFlag atomic.Bool // set on switch, cleared by ConsumeDesktopSwitch
	secureDesktopFlag atomic.Bool // true when on Winlogon/Screen-saver

	// Cross-thread cursor state: updated by the capture thread (which has the
	// correct desktop via SetThreadDesktop), read by the cursor stream goroutine
	// whose GetCursorInfo would fail on a different-desktop thread.
	cursorX   atomic.Int32
	cursorY   atomic.Int32
	cursorVis atomic.Bool
}

// newPlatformCapturer tries DXGI Desktop Duplication first, falls back to GDI.
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	c := &dxgiCapturer{config: config}
	if err := c.initDXGI(); err != nil {
		slog.Warn("DXGI Desktop Duplication unavailable, falling back to GDI", "error", err)
		return &gdiCapturer{config: config}, nil
	}
	slog.Info("DXGI Desktop Duplication initialized",
		"display", config.DisplayIndex, "width", c.width, "height", c.height)
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

	// DXGI Desktop Duplication returns textures in the NATIVE (pre-rotation)
	// orientation. ModeDesc reports post-rotation (desktop) dimensions, but
	// AcquireNextFrame returns textures at native panel dimensions (swapped
	// for 90°/270°). Staging/GPU textures must match native dims so
	// CopyResource succeeds; we rotate the pixels after CPU readback.
	desktopW, desktopH := width, height                          // logical desktop dimensions (from ModeDesc)
	texW, texH := width, height                                  // native texture dimensions
	rot := duplDesc.Rotation                                     // 1=identity, 2=90°, 3=180°, 4=270°
	if rot == 2 || rot == 4 {                                    // 90° or 270° rotation
		texW, texH = height, width                           // native texture: ModeDesc dims swapped
	}

	// Create persistent staging texture at NATIVE dimensions
	stagingDesc := d3d11Texture2DDesc{
		Width:          uint32(texW),
		Height:         uint32(texH),
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
	// Uses native (pre-rotation) dimensions to match acquired DXGI textures.
	gpuDesc := d3d11Texture2DDesc{
		Width:          uint32(texW),
		Height:         uint32(texH),
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
	c.texWidth = texW
	c.texHeight = texH
	c.width = desktopW
	c.height = desktopH
	c.rotation = rot
	c.inited = true

	slog.Info("DXGI Desktop Duplication initialized",
		"display", c.config.DisplayIndex,
		"desktopW", desktopW, "desktopH", desktopH,
		"texW", texW, "texH", texH,
		"rotation", rot,
	)
	return nil
}

// comVtblFn resolves a COM vtable function pointer by index.
func comVtblFn(obj uintptr, idx int) uintptr {
	vtablePtr := *(*uintptr)(unsafe.Pointer(obj))
	return *(*uintptr)(unsafe.Pointer(vtablePtr + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
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

var (
	_ ScreenCapturer  = (*dxgiCapturer)(nil)
	_ BGRAProvider    = (*dxgiCapturer)(nil)
	_ TightLoopHint   = (*dxgiCapturer)(nil)
	_ FrameChangeHint = (*dxgiCapturer)(nil)
	_ TextureProvider = (*dxgiCapturer)(nil)
)
