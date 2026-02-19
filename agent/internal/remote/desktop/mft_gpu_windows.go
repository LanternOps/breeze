//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"unsafe"
)

// tryInitGPUPipeline attempts to set up DXGI device manager + GPU color converter.
// On failure, logs a warning and falls back to CPU path.
func (m *mftEncoder) tryInitGPUPipeline() {
	// 1. Create DXGI device manager
	var token uint32
	var manager uintptr
	hr, _, _ := procMFCreateDXGIDeviceManager.Call(
		uintptr(unsafe.Pointer(&token)),
		uintptr(unsafe.Pointer(&manager)),
	)
	if int32(hr) < 0 {
		slog.Warn("MFCreateDXGIDeviceManager failed, using CPU path", "hr", fmt.Sprintf("0x%08X", uint32(hr)))
		return
	}

	// 2. ResetDevice(d3d11Device, token)
	_, err := comCall(manager, vtblDXGIManagerResetDevice, m.d3d11Device, uintptr(token))
	if err != nil {
		comRelease(manager)
		slog.Warn("DXGI device manager ResetDevice failed, using CPU path", "error", err)
		return
	}

	// 3. Set MF_SA_D3D11_AWARE = TRUE on MFT attributes
	var attrs uintptr
	_, err = comCall(m.transform, vtblGetAttributes, uintptr(unsafe.Pointer(&attrs)))
	if err == nil && attrs != 0 {
		comCall(attrs, vtblSetUINT32,
			uintptr(unsafe.Pointer(&mfSAD3D11Aware)),
			uintptr(uint32(1)),
		)
		comRelease(attrs)
	}

	// 4. ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager)
	_, err = comCall(m.transform, vtblProcessMessage, uintptr(mftMessageSetD3DManager), manager)
	if err != nil {
		comRelease(manager)
		slog.Warn("MFT SET_D3D_MANAGER failed, using CPU path", "error", err)
		return
	}

	m.dxgiManager = manager
	m.dxgiResetToken = token

	slog.Info("DXGI device manager configured for MFT")
	// gpuConv will be initialized lazily on first EncodeTexture call
	// since we need the BGRA staging texture handle at that point
}

// teardownDXGIManager removes the DXGI device manager from the MFT,
// reverting it to CPU buffer mode. Called when GPU converter init fails.
func (m *mftEncoder) teardownDXGIManager() {
	if m.dxgiManager == 0 {
		return
	}
	// Tell MFT to stop using the D3D manager (pass NULL)
	comCall(m.transform, vtblProcessMessage, uintptr(mftMessageSetD3DManager), 0)
	comRelease(m.dxgiManager)
	m.dxgiManager = 0

	// Some hardware MFTs appear to get "stuck" after switching D3D manager state.
	// A flush + restart messages help restore CPU buffer mode.
	comCall(m.transform, vtblProcessMessage, mftMessageCommandFlush, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyBeginStreaming, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyStartOfStream, 0)

	slog.Info("DXGI device manager removed from MFT (GPU converter failed)")
}

func (m *mftEncoder) SetD3D11Device(device, context uintptr) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if device != m.d3d11Device && m.gpuConv != nil {
		// D3D11 device changed (monitor switch) — the GPU converter holds video
		// processor and texture resources bound to the old device. Close it so
		// EncodeTexture lazily re-creates it with the new device.
		m.gpuConv.Close()
		m.gpuConv = nil
		m.gpuFrameCount = 0
		m.gpuEnabled = false
		m.gpuFailed = false
		slog.Info("GPU converter reset for new D3D11 device (monitor switch)")
	}
	m.d3d11Device = device
	m.d3d11Context = context
}

func (m *mftEncoder) SupportsGPUInput() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gpuFailed {
		return false
	}
	return m.gpuEnabled || m.d3d11Device != 0
}
