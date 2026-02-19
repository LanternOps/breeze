//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"syscall"
	"unsafe"
)

// Encode takes RGBA or BGRA pixel data (per SetPixelFormat), converts to NV12, and encodes to H264.
// Returns nil, nil when the MFT is buffering (no output yet).
func (m *mftEncoder) Encode(frame []byte) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(frame) == 0 {
		return nil, fmt.Errorf("empty frame")
	}

	// Lazy init: need dimensions to configure MFT
	if !m.inited {
		// Infer dimensions from RGBA frame size
		// frame is from img.Pix where img is width*height*4 bytes
		pixelCount := len(frame) / 4
		if m.width == 0 || m.height == 0 {
			// Can't initialize without known dimensions
			return nil, fmt.Errorf("MFT encoder: call SetDimensions before Encode")
		}
		if pixelCount != m.width*m.height {
			return nil, fmt.Errorf("frame size %d doesn't match %dx%d", pixelCount, m.width, m.height)
		}
		if err := m.initialize(m.width, m.height, m.width*4); err != nil {
			return nil, err
		}
	}

	// Convert pixels → NV12
	var nv12 []byte
	if m.pixelFormat == PixelFormatBGRA {
		nv12 = bgraToNV12(frame, m.width, m.height, m.stride)
	} else {
		nv12 = rgbaToNV12(frame, m.width, m.height, m.stride)
	}
	defer putNV12Buffer(nv12)

	// Create MF sample with NV12 data
	sample, err := m.createSample(nv12)
	if err != nil {
		return nil, fmt.Errorf("create sample: %w", err)
	}
	defer comRelease(sample)

	// If requested, force an IDR as early as possible in this stream.
	if m.forceKeyframePending {
		_ = m.forceKeyframeLocked()
	}

	// Feed to encoder
	ret, _, _ := syscall.SyscallN(
		m.vtblFn(vtblProcessInput),
		m.transform,
		0, // stream ID
		sample,
		0, // flags
	)

	if uint32(ret) == mfENotAccepting {
		// Drain output first, then retry
		out, err := m.drainOutput()
		if err != nil {
			return nil, err
		}
		ret, _, _ = syscall.SyscallN(
			m.vtblFn(vtblProcessInput),
			m.transform,
			0,
			sample,
			0,
		)
		if int32(ret) < 0 {
			return out, nil // Return what we drained
		}
		if out != nil {
			return out, nil
		}
	} else if int32(ret) < 0 {
		return nil, fmt.Errorf("ProcessInput failed: 0x%08X", uint32(ret))
	}

	// Try to get output
	return m.drainOutput()
}

func (m *mftEncoder) vtblFn(idx int) uintptr {
	vtablePtr := *(*uintptr)(unsafe.Pointer(m.transform))
	return *(*uintptr)(unsafe.Pointer(vtablePtr + uintptr(idx)*unsafe.Sizeof(uintptr(0))))
}

func (m *mftEncoder) createSample(nv12 []byte) (uintptr, error) {
	nv12Size := len(nv12)

	// Create memory buffer
	var pBuffer uintptr
	hr, _, _ := procMFCreateMemoryBuffer.Call(
		uintptr(uint32(nv12Size)),
		uintptr(unsafe.Pointer(&pBuffer)),
	)
	if int32(hr) < 0 {
		return 0, fmt.Errorf("MFCreateMemoryBuffer: 0x%08X", uint32(hr))
	}

	// Lock buffer, copy NV12 data, unlock
	var pData uintptr
	_, err := comCall(pBuffer, vtblBufLock, uintptr(unsafe.Pointer(&pData)), 0, 0)
	if err != nil {
		comRelease(pBuffer)
		return 0, fmt.Errorf("buffer Lock: %w", err)
	}

	// Copy NV12 data into the buffer
	dst := unsafe.Slice((*byte)(unsafe.Pointer(pData)), nv12Size)
	copy(dst, nv12)

	comCall(pBuffer, vtblBufUnlock)
	comCall(pBuffer, vtblBufSetCurrentLength, uintptr(uint32(nv12Size)))

	// Create sample
	var pSample uintptr
	hr, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&pSample)))
	if int32(hr) < 0 {
		comRelease(pBuffer)
		return 0, fmt.Errorf("MFCreateSample: 0x%08X", uint32(hr))
	}

	// Set timing
	fps := m.cfg.FPS
	if fps <= 0 {
		fps = 30
	}
	frameDuration100ns := int64(10_000_000 / fps) // 100ns units
	sampleTime := int64(m.frameIdx) * frameDuration100ns
	m.frameIdx++

	if _, err := comCall(pSample, vtblSetSampleTime, uintptr(sampleTime)); err != nil {
		slog.Debug("SetSampleTime failed (non-fatal)", "error", err)
	}
	if _, err := comCall(pSample, vtblSetSampleDuration, uintptr(frameDuration100ns)); err != nil {
		slog.Debug("SetSampleDuration failed (non-fatal)", "error", err)
	}

	// Add buffer to sample
	_, err = comCall(pSample, vtblAddBuffer, pBuffer)
	comRelease(pBuffer) // sample now owns the buffer
	if err != nil {
		comRelease(pSample)
		return 0, fmt.Errorf("AddBuffer: %w", err)
	}

	return pSample, nil
}

func (m *mftEncoder) drainOutput() ([]byte, error) {
	var allNALs []byte
	streamChangeRetries := 0

	for {
		// Build output data buffer. If the MFT provides its own samples
		// (common for the software H264 encoder), we must NOT provide one.
		var callerSample uintptr
		outputData := mftOutputDataBuffer{dwStreamID: 0}

		if !m.providesSamples {
			// Caller must allocate the output sample + buffer
			var pOutputBuffer uintptr
			hr, _, _ := procMFCreateMemoryBuffer.Call(
				uintptr(uint32(m.outputBufSize)),
				uintptr(unsafe.Pointer(&pOutputBuffer)),
			)
			if int32(hr) < 0 {
				return allNALs, fmt.Errorf("MFCreateMemoryBuffer for output: 0x%08X", uint32(hr))
			}

			hr, _, _ = procMFCreateSample.Call(uintptr(unsafe.Pointer(&callerSample)))
			if int32(hr) < 0 {
				comRelease(pOutputBuffer)
				return allNALs, fmt.Errorf("MFCreateSample for output: 0x%08X", uint32(hr))
			}
			comCall(callerSample, vtblAddBuffer, pOutputBuffer)
			comRelease(pOutputBuffer)
			outputData.pSample = callerSample
		}
		// else: pSample stays 0 — MFT will fill it in

		var status uint32

		ret, _, _ := syscall.SyscallN(
			m.vtblFn(vtblProcessOutput),
			m.transform,
			0, // flags
			1, // output buffer count
			uintptr(unsafe.Pointer(&outputData)),
			uintptr(unsafe.Pointer(&status)),
		)

		// Determine which sample to use (MFT-provided or caller-provided)
		resultSample := outputData.pSample
		callerOwned := !m.providesSamples

		if uint32(ret) == mfETransformNeedInput || uint32(ret) == eUnexpected {
			// MF_E_TRANSFORM_NEED_INPUT: encoder needs more input before producing output.
			// E_UNEXPECTED: async hardware MFTs return this when output isn't ready yet.
			if callerOwned && callerSample != 0 {
				comRelease(callerSample)
			}
			if len(allNALs) > 0 {
				return allNALs, nil
			}
			return nil, nil
		}
		if uint32(ret) == mfETransformStreamChange {
			// Software H264 encoder signals this on its first output to
			// report chosen codec params (profile/level). Per MFT docs we
			// must renegotiate the output type, then re-check stream info.
			if callerOwned && callerSample != 0 {
				comRelease(callerSample)
			}
			streamChangeRetries++
			if streamChangeRetries > 5 {
				m.shutdown()
				return allNALs, fmt.Errorf("too many stream changes (%d), encoder reset", streamChangeRetries)
			}
			// Renegotiate: query the MFT's preferred output type and re-set it
			var newType uintptr
			hr, _, _ := syscall.SyscallN(
				m.vtblFn(vtblGetOutputAvailType),
				m.transform,
				0, // stream ID
				0, // type index
				uintptr(unsafe.Pointer(&newType)),
			)
			if int32(hr) >= 0 && newType != 0 {
				syscall.SyscallN(
					m.vtblFn(vtblSetOutputType),
					m.transform,
					0, // stream ID
					newType,
					0, // flags
				)
				comRelease(newType)
			}
			// Re-check if MFT now provides samples (can change after stream change)
			var streamInfo mftOutputStreamInfo
			hr2, _, _ := syscall.SyscallN(
				m.vtblFn(vtblGetOutputStreamInfo),
				m.transform,
				0,
				uintptr(unsafe.Pointer(&streamInfo)),
			)
			if int32(hr2) >= 0 {
				m.providesSamples = (streamInfo.dwFlags & mftOutputStreamProvidesSamples) != 0
				if int(streamInfo.cbSize) > m.outputBufSize {
					m.outputBufSize = int(streamInfo.cbSize)
				}
			}
			slog.Debug("MFT stream change, renegotiated output type",
				"attempt", streamChangeRetries,
				"providesSamples", m.providesSamples,
				"outputBufSize", m.outputBufSize,
			)
			continue
		}
		if uint32(ret) == mfEBufferTooSmall {
			// Output buffer too small — grow it and retry
			if callerOwned && callerSample != 0 {
				comRelease(callerSample)
			}
			m.outputBufSize *= 2
			slog.Info("MFT output buffer too small, growing", "newSize", m.outputBufSize)
			continue
		}
		if int32(ret) < 0 {
			if callerOwned && callerSample != 0 {
				comRelease(callerSample)
			}
			return allNALs, fmt.Errorf("ProcessOutput: 0x%08X", uint32(ret))
		}

		// Extract encoded data from whichever sample has the output
		if resultSample == 0 {
			return allNALs, fmt.Errorf("ProcessOutput succeeded but no output sample")
		}
		nalChunk, err := m.extractSampleData(resultSample)
		// Release: MFT-provided samples must be released by us too
		if m.providesSamples {
			comRelease(resultSample)
		} else if callerSample != 0 {
			comRelease(callerSample)
		}
		if err != nil {
			return allNALs, err
		}

		allNALs = append(allNALs, nalChunk...)

		if outputData.dwStatus&mftOutputDataBufferIncomplete == 0 {
			break
		}
	}

	return allNALs, nil
}

func (m *mftEncoder) extractSampleData(pSample uintptr) ([]byte, error) {
	var pContiguous uintptr
	_, err := comCall(pSample, vtblConvertToContiguous, uintptr(unsafe.Pointer(&pContiguous)))
	if err != nil {
		return nil, fmt.Errorf("ConvertToContiguousBuffer: %w", err)
	}
	defer comRelease(pContiguous)

	var pData uintptr
	var dataLen uint32
	_, err = comCall(pContiguous, vtblBufLock,
		uintptr(unsafe.Pointer(&pData)),
		0,
		uintptr(unsafe.Pointer(&dataLen)),
	)
	if err != nil {
		return nil, fmt.Errorf("output buffer Lock: %w", err)
	}

	nalData := make([]byte, dataLen)
	src := unsafe.Slice((*byte)(unsafe.Pointer(pData)), dataLen)
	copy(nalData, src)

	comCall(pContiguous, vtblBufUnlock)
	return nalData, nil
}

// ForceKeyframe requests the encoder emit an IDR/keyframe as soon as possible.
// Best-effort: if unsupported, it becomes a no-op.
func (m *mftEncoder) ForceKeyframe() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	// If we're not initialized yet, remember the request and apply after init.
	if !m.inited {
		m.forceKeyframePending = true
		return nil
	}
	return m.forceKeyframeLocked()
}

// Flush drops all buffered frames from the MFT encoder pipeline and forces the
// next output to be an IDR keyframe. Used on mouse clicks so the viewer
// immediately shows the result of the click instead of displaying stale
// animation frames queued before the click.
func (m *mftEncoder) Flush() error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.inited || m.transform == 0 {
		return nil
	}

	// 1. Flush all buffered input/output from the MFT pipeline.
	comCall(m.transform, vtblProcessMessage, mftMessageCommandFlush, 0)

	// 2. Restart the streaming session so the MFT accepts new input.
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyBeginStreaming, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyStartOfStream, 0)

	// 3. Force the next output to be an IDR keyframe so the viewer can
	//    decode immediately without waiting for a reference frame.
	m.forceKeyframePending = true
	_ = m.forceKeyframeLocked()

	return nil
}

func (m *mftEncoder) forceKeyframeLocked() error {
	if m.codecAPI == 0 {
		m.forceKeyframePending = false
		return nil
	}

	// ICodecAPI::SetValue(CODECAPI_AVEncVideoForceKeyFrame, VT_UI4=1)
	v := comVariant{vt: vtUI4, val: 1}
	_, err := comCall(m.codecAPI, vtblCodecAPISetValue,
		uintptr(unsafe.Pointer(&codecAPIAVEncVideoForceKeyFrame)),
		uintptr(unsafe.Pointer(&v)),
	)
	if err != nil {
		// Keep it pending; some hardware MFTs are picky during startup.
		m.forceKeyframePending = true
		return err
	}
	m.forceKeyframePending = false
	return nil
}

// EncodeTexture encodes a BGRA GPU texture via the zero-copy GPU pipeline.
// Converts BGRA→NV12 on GPU, wraps as DXGI surface buffer, feeds to MFT.
func (m *mftEncoder) EncodeTexture(bgraTexture uintptr) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if bgraTexture == 0 {
		return nil, fmt.Errorf("nil BGRA texture")
	}

	// Lazy init MFT if needed
	if !m.inited {
		if m.width == 0 || m.height == 0 {
			return nil, fmt.Errorf("MFT encoder: call SetDimensions before EncodeTexture")
		}
		if err := m.initialize(m.width, m.height, m.width*4); err != nil {
			return nil, err
		}
	}

	// Lazy init GPU converter
	if m.gpuConv == nil {
		conv, err := newGPUConverter(m.d3d11Device, m.d3d11Context, bgraTexture, m.width, m.height)
		if err != nil {
			slog.Warn("GPU converter init failed, falling back to CPU path permanently", "error", err)
			m.gpuEnabled = false
			m.gpuFailed = true
			// Tear down DXGI device manager so MFT reverts to CPU buffer mode
			m.teardownDXGIManager()
			return nil, fmt.Errorf("GPU converter init: %w", err)
		}
		m.gpuConv = conv
		m.gpuEnabled = true
		slog.Info("MFT GPU pipeline enabled", "width", m.width, "height", m.height)
	}

	// If requested, force an IDR as early as possible in this stream.
	if m.forceKeyframePending {
		_ = m.forceKeyframeLocked()
	}

	// 1. GPU BGRA→NV12 conversion + readback to CPU memory.
	// We use ConvertAndReadback instead of the DXGI surface buffer path because
	// hardware MFT encoders often have issues reading DXGI surface buffers directly.
	// The GPU still does the expensive BGRA→NV12 color conversion; the only extra
	// cost is a ~5.5MB NV12 GPU→CPU readback (fast over PCIe).
	nv12, err := m.gpuConv.ConvertAndReadback()
	if err != nil {
		return nil, fmt.Errorf("GPU convert: %w", err)
	}
	defer putNV12Buffer(nv12)

	// Diagnostic: check NV12 Y-plane brightness at multiple positions.
	// Y=16 is limited-range black; varied values indicate real content.
	m.gpuFrameCount++
	if m.gpuFrameCount <= 3 || m.gpuFrameCount%300 == 0 {
		yPlaneSize := m.width * m.height
		checkLen := 1000
		if checkLen > yPlaneSize {
			checkLen = yPlaneSize
		}
		// Sample from START of Y plane (top of screen)
		topSum := 0
		for i := 0; i < checkLen; i++ {
			topSum += int(nv12[i])
		}
		// Sample from MIDDLE of Y plane (center of screen, where content is)
		midOffset := yPlaneSize / 2
		midEnd := midOffset + checkLen
		if midEnd > yPlaneSize {
			midEnd = yPlaneSize
		}
		midSum := 0
		for i := midOffset; i < midEnd; i++ {
			midSum += int(nv12[i])
		}
		// Count non-black pixels in entire Y plane (Y != 16)
		nonBlack := 0
		for i := 0; i < yPlaneSize; i++ {
			if nv12[i] != 16 {
				nonBlack++
			}
		}
		slog.Warn("NV12 content check",
			"frame", m.gpuFrameCount,
			"width", m.width, "height", m.height,
			"topYSum", topSum,
			"midYSum", midSum,
			"nonBlackPixels", nonBlack,
			"totalPixels", yPlaneSize,
		)

		// Self-healing: if the GPU Video Processor produces entirely black NV12
		// output (all Y=16, zero non-black pixels), permanently switch to CPU
		// BGRA→NV12 conversion. This occurs with certain monitor configurations
		// (e.g., portrait 1080x1920) due to driver-level issues.
		if m.gpuFrameCount <= 3 && nonBlack == 0 && yPlaneSize > 0 {
			slog.Warn("GPU converter producing all-black NV12, disabling GPU pipeline",
				"frame", m.gpuFrameCount,
				"width", m.width, "height", m.height,
			)
			m.gpuConv.Close()
			m.gpuConv = nil
			m.gpuEnabled = false
			m.gpuFailed = true
			return nil, fmt.Errorf("GPU converter produced all-black frame (display %dx%d)", m.width, m.height)
		}
	}

	// 2. Create MF sample with NV12 data (same path as CPU Encode)
	sample, err := m.createSample(nv12)
	if err != nil {
		return nil, fmt.Errorf("create sample: %w", err)
	}
	defer comRelease(sample)

	// 3. Feed to encoder
	ret, _, _ := syscall.SyscallN(
		m.vtblFn(vtblProcessInput),
		m.transform,
		0, // stream ID
		sample,
		0, // flags
	)

	if uint32(ret) == mfENotAccepting {
		out, err := m.drainOutput()
		if err != nil {
			return nil, err
		}
		ret, _, _ = syscall.SyscallN(
			m.vtblFn(vtblProcessInput),
			m.transform,
			0,
			sample,
			0,
		)
		if int32(ret) < 0 {
			return out, nil
		}
		if out != nil {
			return out, nil
		}
	} else if int32(ret) < 0 {
		return nil, fmt.Errorf("ProcessInput (GPU): 0x%08X", uint32(ret))
	}

	return m.drainOutput()
}
