//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"syscall"
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
		slog.Warn("DXGI device manager ResetDevice failed, using CPU path", "error", err.Error())
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
		slog.Warn("MFT SET_D3D_MANAGER failed, using CPU path", "error", err.Error())
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

// resetForCPUFallback destroys the current MFT, reinitializes a fresh one,
// and primes it with blank frames so it's immediately ready to encode.
// The software H264 MFT needs 2-3 frames for stream-change negotiation;
// on a static desktop with few dirty rects this warm-up may never complete
// naturally. Preserves gpuFailed and d3d11Device/Context so the capture loop
// knows GPU is permanently disabled.
func (m *mftEncoder) resetForCPUFallback() {
	if !m.inited {
		return
	}
	savedGPUFailed := m.gpuFailed
	savedDevice := m.d3d11Device
	savedContext := m.d3d11Context
	savedWidth := m.width
	savedHeight := m.height
	savedStride := m.stride
	savedCfg := m.cfg
	savedPixelFormat := m.pixelFormat

	m.shutdown() // resets gpuFailed, gpuEnabled, releases COM handles

	m.gpuFailed = savedGPUFailed
	m.d3d11Device = savedDevice
	m.d3d11Context = savedContext
	m.width = savedWidth
	m.height = savedHeight
	m.stride = savedStride
	m.cfg = savedCfg
	m.pixelFormat = savedPixelFormat
	m.consecutiveNilOutputs = 0 // fresh encoder, reset diagnostic counter

	// Reinitialize immediately so we can prime with blank frames.
	if savedWidth == 0 || savedHeight == 0 {
		slog.Info("MFT encoder reset for CPU fallback (deferred reinit, no dimensions)")
		return
	}
	if err := m.initialize(savedWidth, savedHeight, savedStride); err != nil {
		slog.Warn("MFT reinit for CPU fallback failed; will retry on next Encode() call",
			"error", err.Error(), "width", savedWidth, "height", savedHeight)
		return
	}

	// Prime the encoder: feed blank NV12 frames to get past the
	// MF_E_TRANSFORM_STREAM_CHANGE warm-up. The software H264 MFT returns
	// STREAM_CHANGE on its first output, requiring type renegotiation, then
	// typically needs 2-3 more frames before producing encoded output. We feed
	// 5 frames as a safety margin for slower MFT implementations. Without this,
	// a static desktop may never generate enough dirty rects to prime naturally.
	nv12Size := savedWidth * savedHeight * 3 / 2
	blank := make([]byte, nv12Size)
	// Y plane = 16 (limited-range black), UV plane = 128 (neutral chroma)
	for i := 0; i < savedWidth*savedHeight; i++ {
		blank[i] = 16
	}
	for i := savedWidth * savedHeight; i < nv12Size; i++ {
		blank[i] = 128
	}

	primed := 0
	for i := 0; i < 5; i++ {
		sample, err := m.createSample(blank)
		if err != nil {
			slog.Warn("MFT prime: createSample failed", "error", err.Error())
			break
		}
		ret, _, _ := syscall.SyscallN(
			m.vtblFn(vtblProcessInput),
			m.transform, 0, sample, 0,
		)
		if uint32(ret) == mfENotAccepting {
			// MFT input buffer full — drain and retry this frame
			comRelease(sample)
			out, drainErr := m.drainOutput()
			if drainErr != nil || !m.inited {
				slog.Warn("MFT prime: drain failed or encoder shutdown", "error", fmt.Sprintf("%v", drainErr))
				return
			}
			if out != nil {
				primed++
			}
			continue
		}
		comRelease(sample)
		if int32(ret) < 0 {
			slog.Warn("MFT prime: ProcessInput failed", "hr", fmt.Sprintf("0x%08X", uint32(ret)))
			break
		}
		out, drainErr := m.drainOutput()
		if drainErr != nil || !m.inited {
			slog.Warn("MFT prime: drain failed or encoder shutdown", "error", fmt.Sprintf("%v", drainErr))
			return
		}
		if out != nil {
			primed++
		}
	}

	slog.Info("MFT encoder reset and primed for CPU fallback",
		"width", savedWidth, "height", savedHeight, "primedFrames", primed)
}

func (m *mftEncoder) SupportsGPUInput() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gpuFailed {
		return false
	}
	return m.gpuEnabled || m.d3d11Device != 0
}

// createDXGISurfaceSample wraps a D3D11 NV12 texture as an IMFSample backed
// by a DXGI surface buffer. The MFT reads directly from GPU memory — no CPU
// readback required. Returns (sample, cleanup, error). Caller must call
// cleanup() after ProcessInput returns to release the COM objects.
func createDXGISurfaceSample(nv12Texture uintptr, timestamp int64) (uintptr, func(), error) {
	// MFCreateDXGISurfaceBuffer(riid, surface, subresourceIndex, bottomUpWhenFalse) → IMFMediaBuffer
	var mediaBuffer uintptr
	hr, _, _ := procMFCreateDXGISurfaceBuffer.Call(
		uintptr(unsafe.Pointer(&iidID3D11Texture2D)),
		nv12Texture,
		0, // subresource index 0
		0, // bottomUpWhenFalse = FALSE
		uintptr(unsafe.Pointer(&mediaBuffer)),
	)
	if int32(hr) < 0 {
		return 0, nil, fmt.Errorf("MFCreateDXGISurfaceBuffer: 0x%08X", uint32(hr))
	}

	// MFCreateSample → IMFSample
	var sample uintptr
	hr, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&sample)))
	if int32(hr) < 0 {
		comRelease(mediaBuffer)
		return 0, nil, fmt.Errorf("MFCreateSample: 0x%08X", uint32(hr))
	}

	// IMFSample::AddBuffer(mediaBuffer)
	_, err := comCall(sample, vtblAddBuffer, mediaBuffer)
	if err != nil {
		comRelease(sample)
		comRelease(mediaBuffer)
		return 0, nil, fmt.Errorf("AddBuffer: %w", err)
	}

	// Set sample timestamp (100ns units)
	comCall(sample, vtblSetSampleTime, uintptr(timestamp))

	// Set sample duration (100ns units, ~60fps default)
	comCall(sample, vtblSetSampleDuration, uintptr(166667))

	cleanup := func() {
		comRelease(mediaBuffer)
		// Note: do NOT release sample here — MFT owns it after ProcessInput
	}

	return sample, cleanup, nil
}
