//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"syscall"
	"unsafe"
)

// DXGI_OUTPUT_DESC layout:
//   WCHAR DeviceName[32]  — 64 bytes (UTF-16)
//   RECT  DesktopCoordinates — 16 bytes (left, top, right, bottom int32)
//   BOOL  AttachedToDesktop  — 4 bytes
//   DXGI_MODE_ROTATION — 4 bytes
//   HMONITOR — 8 bytes (pointer)
// Total: 96 bytes
type dxgiOutputDesc struct {
	DeviceName         [32]uint16
	Left               int32
	Top                int32
	Right              int32
	Bottom             int32
	AttachedToDesktop  int32
	Rotation           uint32
	Monitor            uintptr
}

const (
	dxgiOutputGetDesc = 7 // IDXGIOutput::GetDesc (IUnknown=3, IDXGIObject=4 more, GetDesc=next)
)

// ListMonitors enumerates connected displays via DXGI.
func ListMonitors() ([]MonitorInfo, error) {
	// Create a temporary D3D11 device to enumerate outputs.
	var device, context uintptr
	featureLevel := uint32(d3dFeatureLevel11_0)
	var actualLevel uint32

	hr, _, _ := procD3D11CreateDevice.Call(
		0,
		uintptr(d3dDriverTypeHardware),
		0,
		0, // No special flags needed for enumeration
		uintptr(unsafe.Pointer(&featureLevel)),
		1,
		uintptr(d3d11SDKVersion),
		uintptr(unsafe.Pointer(&device)),
		uintptr(unsafe.Pointer(&actualLevel)),
		uintptr(unsafe.Pointer(&context)),
	)
	if int32(hr) < 0 {
		return nil, fmt.Errorf("D3D11CreateDevice failed: 0x%08X", uint32(hr))
	}
	defer comRelease(context)
	defer comRelease(device)

	// QueryInterface → IDXGIDevice
	var dxgiDevice uintptr
	_, err := comCall(device, vtblQueryInterface,
		uintptr(unsafe.Pointer(&iidIDXGIDevice)),
		uintptr(unsafe.Pointer(&dxgiDevice)),
	)
	if err != nil {
		return nil, fmt.Errorf("QueryInterface IDXGIDevice: %w", err)
	}
	defer comRelease(dxgiDevice)

	// GetAdapter
	var adapter uintptr
	_, err = comCall(dxgiDevice, dxgiDeviceGetAdapter, uintptr(unsafe.Pointer(&adapter)))
	if err != nil {
		return nil, fmt.Errorf("IDXGIDevice::GetAdapter: %w", err)
	}
	defer comRelease(adapter)

	// Enumerate outputs
	var monitors []MonitorInfo
	for i := 0; ; i++ {
		var output uintptr
		hr, _, _ := syscall.SyscallN(
			comVtblFn(adapter, dxgiAdapterEnumOutputs),
			adapter,
			uintptr(i),
			uintptr(unsafe.Pointer(&output)),
		)
		if int32(hr) < 0 {
			if uint32(hr) != 0x887A0002 { // not DXGI_ERROR_NOT_FOUND
				slog.Warn("DXGI EnumOutputs failed", "index", i, "hr", fmt.Sprintf("0x%08X", uint32(hr)))
			}
			break
		}

		var desc dxgiOutputDesc
		hr, _, _ = syscall.SyscallN(
			comVtblFn(output, dxgiOutputGetDesc),
			output,
			uintptr(unsafe.Pointer(&desc)),
		)
		comRelease(output)

		if int32(hr) < 0 {
			slog.Warn("DXGI GetDesc failed", "index", i, "hr", fmt.Sprintf("0x%08X", uint32(hr)))
			continue
		}

		if desc.AttachedToDesktop == 0 {
			continue
		}

		name := syscall.UTF16ToString(desc.DeviceName[:])
		w := int(desc.Right - desc.Left)
		h := int(desc.Bottom - desc.Top)

		monitors = append(monitors, MonitorInfo{
			Index:     i,
			Name:      name,
			Width:     w,
			Height:    h,
			X:         int(desc.Left),
			Y:         int(desc.Top),
			IsPrimary: desc.Left == 0 && desc.Top == 0,
		})
	}

	if len(monitors) == 0 {
		return nil, fmt.Errorf("no monitors found")
	}

	return monitors, nil
}
