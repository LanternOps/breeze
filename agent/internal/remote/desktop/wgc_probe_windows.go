//go:build windows && !cgo

package desktop

// WGC (Windows.Graphics.Capture) diagnostic probe.
//
// This is a single-shot, short-lived probe that runs when DXGI Desktop
// Duplication fails to initialize in the helper's current session/desktop
// context. It exercises the exact sequence a full WGC capturer would need,
// logging the result of each step so we can tell — from the helper's real
// process/thread/desktop context — whether the Windows Graphics Capture API
// can see and pump frames for the physical monitor that DXGI couldn't.
//
// The probe uses only syscall + vtable dispatch (no cgo, no new deps) to
// stay compatible with the shipping `windows && !cgo` build tag. It is gated
// behind probeWGCOnDXGIFail so the cost is zero on prod builds when flipped
// off.
//
// IMPORTANT: must be called while the OS thread is still pinned (runtime.
// LockOSThread) and still attached to the input desktop that initDXGI just
// failed on. Otherwise we're probing a different context and the signal is
// meaningless.

import (
	"fmt"
	"log/slog"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Build-time toggle. Off by default; flip to true locally when investigating
// a DXGI Desktop Duplication failure to gather WGC probe diagnostics.
const probeWGCOnDXGIFail = false

// --- WinRT + D3D11 interop proc imports ---

var (
	combaseDLL = syscall.NewLazyDLL("combase.dll")

	procRoInitialize                 = combaseDLL.NewProc("RoInitialize")
	procRoUninitialize               = combaseDLL.NewProc("RoUninitialize")
	procRoGetActivationFactory       = combaseDLL.NewProc("RoGetActivationFactory")
	procWindowsCreateStringReference = combaseDLL.NewProc("WindowsCreateStringReference")

	procCreateDirect3D11DeviceFromDXGIDevice = d3d11DLL.NewProc("CreateDirect3D11DeviceFromDXGIDevice")

	procEnumDisplayMonitors = user32.NewProc("EnumDisplayMonitors")
	procMonitorFromPoint    = user32.NewProc("MonitorFromPoint")
	procMonitorFromWindow   = user32.NewProc("MonitorFromWindow")
	procGetDesktopWindow    = user32.NewProc("GetDesktopWindow")
	procGetMonitorInfoW     = user32.NewProc("GetMonitorInfoW")
)

// --- RO_INIT_TYPE ---

const (
	roInitMultiThreaded = 1 // RO_INIT_MULTITHREADED

	// Windows.Graphics.DirectX.DirectXPixelFormat.B8G8R8A8UIntNormalized
	directXPixelFormatB8G8R8A8UIntNormalized = 87

	// MonitorFromPoint / MonitorFromWindow flags
	monitorDefaultToPrimary = 0x00000001
	monitorDefaultToNearest = 0x00000002

	// D3D_DRIVER_TYPE_HARDWARE. Kept local to the probe so the main DXGI
	// path can stay on the explicit-adapter pattern without exporting this
	// constant package-wide.
	wgcD3DDriverTypeHardware = 1
)

// --- Vtable indices ---
//
// Critical distinction:
//   * IGraphicsCaptureItemInterop is a Win32 interop interface that derives
//     directly from IUnknown. Its method table is IUnknown(0..2) + methods
//     starting at index 3.
//   * IGraphicsCaptureItem, IDirect3D11CaptureFramePool(Statics2),
//     IGraphicsCaptureSession, IDirect3D11CaptureFrame are WinRT runtime-
//     class interfaces that derive from IInspectable. Their vtables are
//     IUnknown(0..2) + IInspectable(3..5) + methods starting at index 6.

const (
	// IGraphicsCaptureItemInterop : IUnknown
	wgcInteropCreateForWindow  = 3
	wgcInteropCreateForMonitor = 4

	// IGraphicsCaptureItem : IInspectable
	wgcItemGetDisplayName = 6
	wgcItemGetSize        = 7

	// IDirect3D11CaptureFramePoolStatics2 : IInspectable
	//   6 = CreateFreeThreaded(IDirect3DDevice*, DirectXPixelFormat, INT32, SizeInt32, Pool**)
	wgcFramePoolStatics2CreateFreeThreaded = 6

	// IDirect3D11CaptureFramePool : IInspectable
	//   6  Recreate
	//   7  TryGetNextFrame (HRESULT(IDirect3D11CaptureFrame**))
	//   8  add_FrameArrived
	//   9  remove_FrameArrived
	//   10 CreateCaptureSession(IGraphicsCaptureItem*, IGraphicsCaptureSession**)
	//   11 get_DispatcherQueue
	wgcFramePoolTryGetNextFrame      = 7
	wgcFramePoolCreateCaptureSession = 10

	// IGraphicsCaptureSession : IInspectable
	//   6 StartCapture
	wgcSessionStartCapture = 6

	// IDirect3D11CaptureFrame : IInspectable
	//   6 get_Surface
	//   7 get_SystemRelativeTime
	//   8 get_ContentSize
	wgcFrameGetContentSize = 8
)

// --- IIDs (from Windows SDK headers) ---

var (
	// IGraphicsCaptureItemInterop {3628E81B-3CAC-4C60-B7F4-23CE0E0C3356}
	iidIGraphicsCaptureItemInterop = comGUID{
		0x3628e81b, 0x3cac, 0x4c60,
		[8]byte{0xb7, 0xf4, 0x23, 0xce, 0x0e, 0x0c, 0x33, 0x56},
	}

	// IGraphicsCaptureItem {79C3F95B-31F7-4EC2-A464-632EF5D30760}
	iidIGraphicsCaptureItem = comGUID{
		0x79c3f95b, 0x31f7, 0x4ec2,
		[8]byte{0xa4, 0x64, 0x63, 0x2e, 0xf5, 0xd3, 0x07, 0x60},
	}

	// IDirect3D11CaptureFramePoolStatics2 {589b103f-6bbc-5df5-a991-02e28b3b66d5}
	iidIDirect3D11CaptureFramePoolStatics2 = comGUID{
		0x589b103f, 0x6bbc, 0x5df5,
		[8]byte{0xa9, 0x91, 0x02, 0xe2, 0x8b, 0x3b, 0x66, 0xd5},
	}
)

// --- WinRT string helpers ---

// hstringHeader is Windows' HSTRING_HEADER: 24 bytes, 8-byte aligned.
// We declare it as [3]uintptr so Go aligns it to 8 on x64. Must be
// caller-provided and live for the lifetime of the HSTRING reference.
type hstringHeader [3]uintptr

// makeHStringRef builds a fast-pass HSTRING reference backed by the caller's
// header + utf16 buffer. The returned HSTRING is only valid while `buf` and
// `hdr` remain alive and unchanged. No WindowsDeleteString needed.
func makeHStringRef(utf16 []uint16, hdr *hstringHeader) (uintptr, error) {
	if len(utf16) == 0 || utf16[len(utf16)-1] != 0 {
		return 0, fmt.Errorf("makeHStringRef: utf16 must be NUL-terminated")
	}
	var hstring uintptr
	// Length excludes the trailing NUL per WindowsCreateStringReference docs.
	hr, _, _ := procWindowsCreateStringReference.Call(
		uintptr(unsafe.Pointer(&utf16[0])),
		uintptr(len(utf16)-1),
		uintptr(unsafe.Pointer(hdr)),
		uintptr(unsafe.Pointer(&hstring)),
	)
	if int32(hr) < 0 {
		return 0, fmt.Errorf("WindowsCreateStringReference: 0x%08X", uint32(hr))
	}
	return hstring, nil
}

// getActivationFactoryFor returns the activation factory for the given
// runtime class name, cast to the requested interface IID.
func getActivationFactoryFor(runtimeClass string, iid *comGUID) (uintptr, error) {
	utf16Name, err := syscall.UTF16FromString(runtimeClass)
	if err != nil {
		return 0, fmt.Errorf("UTF16FromString(%q): %w", runtimeClass, err)
	}
	var hdr hstringHeader
	hstr, err := makeHStringRef(utf16Name, &hdr)
	if err != nil {
		return 0, err
	}
	var factory uintptr
	hr, _, _ := procRoGetActivationFactory.Call(
		hstr,
		uintptr(unsafe.Pointer(iid)),
		uintptr(unsafe.Pointer(&factory)),
	)
	if int32(hr) < 0 {
		return 0, fmt.Errorf("RoGetActivationFactory(%s): 0x%08X", runtimeClass, uint32(hr))
	}
	return factory, nil
}

// --- Monitor enumeration ---

// monitorInfoExW matches Win32 MONITORINFOEXW (104 bytes).
type monitorInfoExW struct {
	CbSize    uint32
	RcMonitor [4]int32 // left, top, right, bottom
	RcWork    [4]int32
	DwFlags   uint32
	SzDevice  [32]uint16
}

type probeMonitor struct {
	Handle  uintptr
	Left    int32
	Top     int32
	Right   int32
	Bottom  int32
	Primary bool
	Device  string
}

// enumerateMonitors returns every HMONITOR visible to the current process/
// session, with basic descriptive metadata. Returns an empty slice if no
// monitors are reachable (which is itself a useful probe signal).
func enumerateMonitors() ([]probeMonitor, error) {
	var monitors []probeMonitor
	callback := syscall.NewCallback(func(hMon, hdc, rect, lparam uintptr) uintptr {
		var info monitorInfoExW
		info.CbSize = uint32(unsafe.Sizeof(info))
		ret, _, _ := procGetMonitorInfoW.Call(
			hMon,
			uintptr(unsafe.Pointer(&info)),
		)
		if ret == 0 {
			return 1 // continue enumeration even if we can't describe one
		}
		monitors = append(monitors, probeMonitor{
			Handle:  hMon,
			Left:    info.RcMonitor[0],
			Top:     info.RcMonitor[1],
			Right:   info.RcMonitor[2],
			Bottom:  info.RcMonitor[3],
			Primary: info.DwFlags&1 != 0, // MONITORINFOF_PRIMARY
			Device:  syscall.UTF16ToString(info.SzDevice[:]),
		})
		return 1
	})
	ret, _, err := procEnumDisplayMonitors.Call(
		0, // hdc (null = entire virtual screen)
		0, // clip rect (null = all monitors)
		callback,
		0, // lparam
	)
	if ret == 0 {
		return monitors, fmt.Errorf("EnumDisplayMonitors failed: %w", err)
	}
	return monitors, nil
}

// fallbackMonitorFromPoint tries MonitorFromPoint(0,0) and MonitorFromWindow
// on the desktop HWND as two extra ways to reach an HMONITOR when
// EnumDisplayMonitors returns empty. Returns the first non-zero handle it
// can find.
func fallbackMonitorFromPoint() uintptr {
	// POINT { LONG x; LONG y } — passed by value (8 bytes on x64, in a
	// single register). Pack as a uintptr.
	var point uintptr // {0, 0}
	hmon, _, _ := procMonitorFromPoint.Call(point, monitorDefaultToPrimary)
	if hmon != 0 {
		return hmon
	}
	hdesk, _, _ := procGetDesktopWindow.Call()
	if hdesk == 0 {
		return 0
	}
	hmon, _, _ = procMonitorFromWindow.Call(hdesk, monitorDefaultToPrimary)
	return hmon
}

// --- The probe itself ---

// probeWGC runs once, synchronously, on the caller's pinned OS thread.
// Every stage is logged individually so a partial failure still produces
// useful signal.
//
// Returns no error (all errors are logged). The caller does not need to
// branch on the outcome — the probe is diagnostic only.
func probeWGC() {
	slog.Info("WGC probe: starting",
		"build", "dev-probe",
		"hint", "runs only after DXGI Desktop Duplication init fails",
	)

	// --- Session + thread context baseline ---
	pid := windows.GetCurrentProcessId()
	var sessionID uint32
	if err := windows.ProcessIdToSessionId(pid, &sessionID); err == nil {
		slog.Info("WGC probe: process session", "pid", pid, "sessionId", sessionID)
	} else {
		slog.Warn("WGC probe: ProcessIdToSessionId failed", "error", err.Error())
	}
	slog.Info("WGC probe: thread desktop", "desktop", threadDesktopName())

	// --- Monitor enumeration ---
	monitors, enumErr := enumerateMonitors()
	if enumErr != nil {
		slog.Warn("WGC probe: EnumDisplayMonitors error", "error", enumErr.Error())
	}
	slog.Info("WGC probe: monitors via EnumDisplayMonitors", "count", len(monitors))
	for i, m := range monitors {
		slog.Info("WGC probe: monitor",
			"index", i,
			"handle", fmt.Sprintf("0x%x", m.Handle),
			"bounds", fmt.Sprintf("%d,%d,%d,%d", m.Left, m.Top, m.Right, m.Bottom),
			"primary", m.Primary,
			"device", m.Device,
		)
	}

	// If EnumDisplayMonitors gave us nothing, try the fallback paths.
	if len(monitors) == 0 {
		if h := fallbackMonitorFromPoint(); h != 0 {
			slog.Info("WGC probe: fallback MonitorFromPoint/Window returned handle",
				"handle", fmt.Sprintf("0x%x", h))
			monitors = []probeMonitor{{Handle: h, Device: "(fallback)"}}
		} else {
			slog.Warn("WGC probe: no HMONITOR reachable from this session — nothing to probe against")
			return
		}
	}

	// --- WinRT apartment init (pinned thread) ---
	hrInit, _, _ := procRoInitialize.Call(uintptr(roInitMultiThreaded))
	// RPC_E_CHANGED_MODE (0x80010106) is non-fatal: somebody else already
	// initialized this apartment with a different mode. We still proceed,
	// but we must NOT call RoUninitialize on that path (we didn't own the
	// init).
	ownsRoInit := int32(hrInit) >= 0
	if !ownsRoInit && uint32(hrInit) != 0x80010106 {
		slog.Warn("WGC probe: RoInitialize failed",
			"hr", fmt.Sprintf("0x%08X", uint32(hrInit)))
		return
	}
	if ownsRoInit {
		defer procRoUninitialize.Call()
	}
	slog.Info("WGC probe: WinRT apartment ready",
		"ownsRoInit", ownsRoInit,
		"hr", fmt.Sprintf("0x%08X", uint32(hrInit)),
	)

	// --- Independent D3D11 device (do NOT assume a DXGI adapter was selected) ---
	d3dDevice, d3dCtx, d3dInspectable, cleanupD3D, err := buildWGCDevice()
	if err != nil {
		slog.Warn("WGC probe: could not build D3D11/WinRT device", "error", err.Error())
		return
	}
	defer cleanupD3D()
	slog.Info("WGC probe: D3D11 device + IDirect3DDevice ready",
		"d3dDevice", fmt.Sprintf("0x%x", d3dDevice),
		"d3dContext", fmt.Sprintf("0x%x", d3dCtx),
		"winrtDevice", fmt.Sprintf("0x%x", d3dInspectable),
	)

	// --- GraphicsCaptureItem interop factory ---
	interop, err := getActivationFactoryFor(
		"Windows.Graphics.Capture.GraphicsCaptureItem",
		&iidIGraphicsCaptureItemInterop,
	)
	if err != nil {
		slog.Warn("WGC probe: failed to get IGraphicsCaptureItemInterop", "error", err.Error())
		return
	}
	defer comRelease(interop)
	slog.Info("WGC probe: IGraphicsCaptureItemInterop ready",
		"interop", fmt.Sprintf("0x%x", interop))

	// --- Frame pool statics (Statics2 for CreateFreeThreaded) ---
	framePoolStatics, err := getActivationFactoryFor(
		"Windows.Graphics.Capture.Direct3D11CaptureFramePool",
		&iidIDirect3D11CaptureFramePoolStatics2,
	)
	if err != nil {
		slog.Warn("WGC probe: failed to get IDirect3D11CaptureFramePoolStatics2",
			"error", err.Error())
		return
	}
	defer comRelease(framePoolStatics)
	slog.Info("WGC probe: IDirect3D11CaptureFramePoolStatics2 ready",
		"statics", fmt.Sprintf("0x%x", framePoolStatics))

	// --- Per-monitor attempt ---
	for i, m := range monitors {
		slog.Info("WGC probe: trying monitor", "index", i,
			"handle", fmt.Sprintf("0x%x", m.Handle))
		probeOneMonitor(i, m, interop, framePoolStatics, d3dInspectable)
	}

	slog.Info("WGC probe: finished")
}

// probeOneMonitor runs the full capture-item → frame pool → session →
// first-frame sequence for a single HMONITOR and logs the outcome.
func probeOneMonitor(index int, m probeMonitor, interop, framePoolStatics, d3dInspectable uintptr) {
	// --- CreateForMonitor(hmon, IID_IGraphicsCaptureItem, &item) ---
	var item uintptr
	_, err := comCall(interop, wgcInteropCreateForMonitor,
		m.Handle,
		uintptr(unsafe.Pointer(&iidIGraphicsCaptureItem)),
		uintptr(unsafe.Pointer(&item)),
	)
	if err != nil {
		slog.Warn("WGC probe: IGraphicsCaptureItemInterop::CreateForMonitor failed",
			"index", index, "error", err.Error())
		return
	}
	defer comRelease(item)

	// --- item.get_Size → SizeInt32 ---
	var size struct {
		Width, Height int32
	}
	_, err = comCall(item, wgcItemGetSize, uintptr(unsafe.Pointer(&size)))
	if err != nil {
		slog.Warn("WGC probe: IGraphicsCaptureItem::get_Size failed",
			"index", index, "error", err.Error())
		return
	}
	slog.Info("WGC probe: capture item created",
		"index", index,
		"width", size.Width,
		"height", size.Height,
	)

	if size.Width <= 0 || size.Height <= 0 {
		slog.Warn("WGC probe: capture item reports zero/negative size, skipping frame pool",
			"index", index, "width", size.Width, "height", size.Height)
		return
	}

	// --- CreateFreeThreaded(d3dDevice, B8G8R8A8, numBuffers=2, SizeInt32{w,h}) ---
	// SizeInt32 is 8 bytes, passed by value in a single register on x64.
	// Pack width (low 32 bits) and height (high 32 bits).
	sizePacked := uintptr(uint32(size.Width)) | (uintptr(uint32(size.Height)) << 32)
	var framePool uintptr
	_, err = comCall(framePoolStatics, wgcFramePoolStatics2CreateFreeThreaded,
		d3dInspectable,
		uintptr(directXPixelFormatB8G8R8A8UIntNormalized),
		uintptr(2), // numberOfBuffers
		sizePacked, // SizeInt32 by value
		uintptr(unsafe.Pointer(&framePool)),
	)
	if err != nil {
		slog.Warn("WGC probe: Direct3D11CaptureFramePoolStatics2::CreateFreeThreaded failed",
			"index", index, "error", err.Error())
		return
	}
	defer comRelease(framePool)
	slog.Info("WGC probe: frame pool created", "index", index,
		"framePool", fmt.Sprintf("0x%x", framePool))

	// --- framePool.CreateCaptureSession(item, &session) ---
	var session uintptr
	_, err = comCall(framePool, wgcFramePoolCreateCaptureSession,
		item,
		uintptr(unsafe.Pointer(&session)),
	)
	if err != nil {
		slog.Warn("WGC probe: framePool::CreateCaptureSession failed",
			"index", index, "error", err.Error())
		return
	}
	defer comRelease(session)

	// --- session.StartCapture() ---
	_, err = comCall(session, wgcSessionStartCapture)
	if err != nil {
		slog.Warn("WGC probe: session::StartCapture failed",
			"index", index, "error", err.Error())
		return
	}
	slog.Info("WGC probe: capture session started", "index", index)

	// --- Poll TryGetNextFrame for up to 2 seconds ---
	started := time.Now()
	deadline := started.Add(2 * time.Second)
	var gotFrame bool
	var lastHRErr error
	pollCount := 0
	for time.Now().Before(deadline) {
		pollCount++
		var frame uintptr
		_, lastHRErr = comCall(framePool, wgcFramePoolTryGetNextFrame,
			uintptr(unsafe.Pointer(&frame)),
		)
		if lastHRErr == nil && frame != 0 {
			// Got a frame. Pull content size for sanity check, then release.
			var contentSize struct {
				Width, Height int32
			}
			_, cErr := comCall(frame, wgcFrameGetContentSize,
				uintptr(unsafe.Pointer(&contentSize)),
			)
			elapsed := time.Since(started)
			if cErr == nil {
				slog.Info("WGC probe: FIRST FRAME RECEIVED",
					"index", index,
					"elapsedMs", elapsed.Milliseconds(),
					"pollCount", pollCount,
					"contentWidth", contentSize.Width,
					"contentHeight", contentSize.Height,
					"itemWidth", size.Width,
					"itemHeight", size.Height,
				)
			} else {
				slog.Info("WGC probe: FIRST FRAME RECEIVED (content size query failed)",
					"index", index,
					"elapsedMs", elapsed.Milliseconds(),
					"pollCount", pollCount,
					"contentSizeError", cErr.Error(),
				)
			}
			comRelease(frame)
			gotFrame = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !gotFrame {
		hrMsg := "nil"
		if lastHRErr != nil {
			hrMsg = lastHRErr.Error()
		}
		slog.Warn("WGC probe: no frame within 2s",
			"index", index,
			"pollCount", pollCount,
			"lastHR", hrMsg,
		)
	}
}

// buildWGCDevice creates a plain D3D11 device (NULL adapter, HARDWARE driver,
// with the BGRA flag WGC requires) and wraps its IDXGIDevice in a WinRT
// IDirect3DDevice via CreateDirect3D11DeviceFromDXGIDevice. Returns a cleanup
// closure that releases everything in reverse order.
func buildWGCDevice() (d3dDevice, d3dCtx, inspectableDevice uintptr, cleanup func(), err error) {
	cleanup = func() {} // no-op until something is allocated
	var device, ctx uintptr
	featureLevel := uint32(d3dFeatureLevel11_0)
	var actualLevel uint32

	// BGRA_SUPPORT flag is required by WGC (the DXGI format we request for
	// the frame pool is B8G8R8A8 so the device needs BGRA support).
	flags := uintptr(d3d11CreateDeviceBGRASupport)
	hr, _, _ := procD3D11CreateDevice.Call(
		0, // pAdapter = NULL (let Windows pick)
		uintptr(wgcD3DDriverTypeHardware),
		0, // software module
		flags,
		uintptr(unsafe.Pointer(&featureLevel)),
		1,
		uintptr(d3d11SDKVersion),
		uintptr(unsafe.Pointer(&device)),
		uintptr(unsafe.Pointer(&actualLevel)),
		uintptr(unsafe.Pointer(&ctx)),
	)
	if int32(hr) < 0 {
		return 0, 0, 0, cleanup, fmt.Errorf("D3D11CreateDevice for WGC: 0x%08X", uint32(hr))
	}

	// QI → IDXGIDevice
	var dxgiDevice uintptr
	if _, qiErr := comCall(device, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidIDXGIDeviceForWGC)),
		uintptr(unsafe.Pointer(&dxgiDevice)),
	); qiErr != nil {
		comRelease(ctx)
		comRelease(device)
		return 0, 0, 0, cleanup, fmt.Errorf("QueryInterface IDXGIDevice for WGC: %w", qiErr)
	}

	// CreateDirect3D11DeviceFromDXGIDevice → IInspectable (WinRT IDirect3DDevice)
	var inspectable uintptr
	hr, _, _ = procCreateDirect3D11DeviceFromDXGIDevice.Call(
		dxgiDevice,
		uintptr(unsafe.Pointer(&inspectable)),
	)
	comRelease(dxgiDevice)
	if int32(hr) < 0 {
		comRelease(ctx)
		comRelease(device)
		return 0, 0, 0, cleanup, fmt.Errorf("CreateDirect3D11DeviceFromDXGIDevice: 0x%08X", uint32(hr))
	}

	cleanup = func() {
		comRelease(inspectable)
		comRelease(ctx)
		comRelease(device)
	}
	return device, ctx, inspectable, cleanup, nil
}

// threadDesktopName returns the name of the calling thread's current desktop,
// for diagnostic logging. Wraps the existing desktopName helper.
func threadDesktopName() string {
	hDesk, _, _ := procGetThreadDesktop.Call(
		uintptr(getCurrentThreadIDForProbe()),
	)
	if hDesk == 0 {
		return "(GetThreadDesktop failed)"
	}
	name := desktopName(hDesk)
	if name == "" {
		return "(empty)"
	}
	return name
}

// getCurrentThreadIDForProbe wraps GetCurrentThreadId without colliding with
// any existing helper that may be in another file.
func getCurrentThreadIDForProbe() uint32 {
	id, _, _ := procGetCurrentThreadId.Call()
	return uint32(id)
}

// iidIDXGIDeviceForWGC is a local copy of the IDXGIDevice IID. The file-level
// iidIDXGIDevice was removed in the DXGI adapter fix so we carry our own.
var iidIDXGIDeviceForWGC = comGUID{
	0x54ec77fa, 0x1377, 0x44e6,
	[8]byte{0x8c, 0x32, 0x88, 0xfd, 0x5f, 0x44, 0xc8, 0x4c},
}
