//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"syscall"
	"unsafe"
)

// tryInitGPUPipeline attempts to set up the DXGI device manager on the MFT so
// it can accept DXGI-surface (GPU texture) input samples. Called from
// initialize() before media-type negotiation, with the transform passed
// explicitly because m.transform is not yet assigned at that point.
// On failure, logs a warning and leaves the CPU-buffer input path in effect.
func (m *mftEncoder) tryInitGPUPipeline(transform uintptr) {
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
	_, err = comCall(transform, vtblGetAttributes, uintptr(unsafe.Pointer(&attrs)))
	if err == nil && attrs != 0 {
		comCall(attrs, vtblSetUINT32,
			uintptr(unsafe.Pointer(&mfSAD3D11Aware)),
			uintptr(uint32(1)),
		)
		comRelease(attrs)
	}

	// 4. ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager)
	_, err = comCall(transform, vtblProcessMessage, uintptr(mftMessageSetD3DManager), manager)
	if err != nil {
		comRelease(manager)
		slog.Warn("MFT SET_D3D_MANAGER failed, using CPU path", "error", err.Error())
		return
	}

	m.dxgiManager = manager
	m.dxgiResetToken = token
	m.useDXGISamples = true

	slog.Info("DXGI device manager configured for MFT (zero-copy input enabled)")
	// gpuConv will be initialized lazily on first EncodeTexture call
	// since we need the BGRA staging texture handle at that point
}

// teardownDXGIManager removes the DXGI device manager from the MFT,
// reverting it to CPU buffer mode. Called when GPU converter init fails or the
// zero-copy input path stalls.
func (m *mftEncoder) teardownDXGIManager() {
	m.useDXGISamples = false
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
	// The flush invalidated queued async input credits / pending output.
	if n := len(m.pendingOutput); n > 0 {
		slog.Debug("DXGI manager teardown discarding buffered async output frames", "frames", n)
	}
	m.needInputCredits = 0
	m.pendingOutput = nil

	slog.Info("DXGI device manager removed from MFT (zero-copy input disabled)")
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
	if device != m.d3d11Device && m.dxgiManager != 0 {
		// The DXGI device manager is bound to the old device; re-point it so
		// zero-copy DXGI-surface samples from the new device stay valid.
		if device != 0 {
			if _, err := comCall(m.dxgiManager, vtblDXGIManagerResetDevice, device, uintptr(m.dxgiResetToken)); err != nil {
				slog.Warn("DXGI manager ResetDevice for new device failed, disabling zero-copy input", "error", err.Error())
				m.teardownDXGIManager()
			}
		} else {
			m.teardownDXGIManager()
		}
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

// createTextureSample wraps a D3D11 NV12 texture as an IMFSample backed by a
// DXGI surface buffer — the MFT reads directly from GPU memory, no CPU
// readback. Timing/ownership semantics mirror createSample: frameIdx-derived
// timestamps, the sample owns the buffer, and the caller releases the sample
// after ProcessInput (the MFT AddRefs what it keeps). Caller holds m.mu.
func (m *mftEncoder) createTextureSample(nv12Texture uintptr) (uintptr, error) {
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
		return 0, fmt.Errorf("MFCreateDXGISurfaceBuffer: 0x%08X", uint32(hr))
	}

	// MFCreateSample → IMFSample
	var sample uintptr
	hr, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&sample)))
	if int32(hr) < 0 {
		comRelease(mediaBuffer)
		return 0, fmt.Errorf("MFCreateSample: 0x%08X", uint32(hr))
	}

	// Timing — same scheme as createSample
	fps := m.cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	frameDuration100ns := int64(10_000_000 / fps)
	sampleTime := int64(m.frameIdx) * frameDuration100ns
	m.frameIdx++
	comCall(sample, vtblSetSampleTime, uintptr(sampleTime))
	comCall(sample, vtblSetSampleDuration, uintptr(frameDuration100ns))

	// IMFSample::AddBuffer(mediaBuffer); the sample owns the buffer afterwards
	_, err := comCall(sample, vtblAddBuffer, mediaBuffer)
	comRelease(mediaBuffer)
	if err != nil {
		comRelease(sample)
		return 0, fmt.Errorf("AddBuffer: %w", err)
	}

	return sample, nil
}
