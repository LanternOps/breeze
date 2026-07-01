//go:build windows

package desktop

import (
	"fmt"
	"log/slog"
	"runtime"
	"syscall"
	"time"
	"unsafe"
)

// mftStallThreshold is the maximum consecutive nil outputs from the MFT before
// the pipeline is flushed and restarted. Hardware MFTs (Intel Quick Sync, etc.)
// can stall permanently on certain GPUs. Flushing at 8 frames (~133ms at 60fps)
// must trigger before the screen goes idle, otherwise the stall counter freezes.
// breaks the stall with acceptable quality loss (one IDR keyframe).
const mftStallThreshold = 8

// Async-MFT input pacing. When an async MFT has not yet posted a
// METransformNeedInput token, encodeAsync yield-spins up to mftAsyncInputWait
// for one before skipping the captured frame. The wait is strictly bounded so
// a genuinely wedged encoder can only hold the encoder mutex for ~3ms (cf. the
// unbounded pre-fix poll-sleep loop in encoder_amf_windows.go, a different
// backend with the same mutex-pinning hazard) — the stall detector still trips
// and we fall back to software. In steady state the previous frame finished
// long before the next capture arrives, so a credit is already queued and this
// wait is skipped.
//
// A runtime.Gosched() spin is used rather than time.Sleep: Windows' default
// timer granularity is 15.6ms, so a time.Sleep(1ms) here would actually stall
// ~15ms and inflate encode latency (observed as 9–37ms encodeMs and periodic
// capture-loop back-ups). Yielding costs a little CPU for at most a few ms but
// wakes the instant the driver posts the event.
const mftAsyncInputWait = 3 * time.Millisecond

// Encode takes RGBA or BGRA pixel data (per SetPixelFormat), converts to NV12, and encodes to H264.
// Returns nil, nil when the MFT is buffering (no output yet).
func (m *mftEncoder) Encode(frame []byte) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if len(frame) == 0 {
		return nil, fmt.Errorf("empty frame")
	}

	if m.width == 0 || m.height == 0 {
		return nil, fmt.Errorf("MFT encoder: call SetDimensions before Encode")
	}

	// Defense-in-depth: silently accept a capture buffer that is exactly one
	// row of pixels too tall, so a capturer that forgot to AlignEven its output
	// cannot produce a tight error loop. See dimensions.go.
	var err error
	frame, err = FitRGBAFrame(frame, m.width, m.height)
	if err != nil {
		return nil, err
	}

	// Lazy init: need dimensions to configure MFT
	if !m.inited {
		if err := m.initialize(m.width, m.height, m.width*4); err != nil {
			return nil, err
		}
	}

	// This is the CPU-frame path — if the capture loop dropped to CPU capture
	// while the DXGI manager is still installed, remove it so the MFT isn't
	// mixing DXGI-surface expectations with memory-buffer input.
	if m.useDXGISamples {
		slog.Info("CPU frame received while zero-copy input enabled, removing DXGI manager")
		m.teardownDXGIManager()
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

	// If the MFT is mid-stall, skip feeding to avoid a blocking ProcessInput.
	if m.consecutiveNilOutputs >= mftStallThreshold {
		m.permanentlyStalled = true
		slog.Warn("MFT stall detected before ProcessInput (CPU path), marking permanently stalled",
			"consecutiveNil", m.consecutiveNilOutputs, "frameIdx", m.frameIdx, "isHW", m.isHW)
		return nil, nil
	}

	// Async hardware MFT: drive via the METransformNeedInput/HaveOutput event
	// handshake instead of synchronous ProcessInput/ProcessOutput polling.
	if m.asyncMode {
		out, err := m.encodeAsync(sample)
		if err != nil {
			return out, err
		}
		m.trackNilOutput(out)
		return out, nil
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
			m.trackNilOutput(out)
			return out, nil // Return what we drained
		}
		if out != nil {
			m.trackNilOutput(out)
			return out, nil
		}
	} else if int32(ret) < 0 {
		return nil, fmt.Errorf("ProcessInput failed: 0x%08X", uint32(ret))
	}

	// Try to get output
	out, err := m.drainOutput()
	if err != nil {
		return out, err
	}
	m.trackNilOutput(out)
	return out, nil
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

	if pData == 0 {
		comCall(pBuffer, vtblBufUnlock)
		comRelease(pBuffer)
		return 0, fmt.Errorf("buffer Lock returned nil pointer")
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
		slog.Debug("SetSampleTime failed (non-fatal)", "error", err.Error())
	}
	if _, err := comCall(pSample, vtblSetSampleDuration, uintptr(frameDuration100ns)); err != nil {
		slog.Debug("SetSampleDuration failed (non-fatal)", "error", err.Error())
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

// encodeAsync drives an asynchronous MFT via the IMFMediaEventGenerator event
// handshake: feed one frame per METransformNeedInput token, drain one frame per
// METransformHaveOutput event. It returns the oldest completed frame (≈1-frame
// pipeline latency, like the AMF pipeline), or nil while the pipeline fills or
// when the encoder is applying backpressure. Caller holds m.mu.
//
// This is the fix for the Intel UHD 630 stall: the hardware QuickSync MFT is a
// true async MFT that only produces output through this handshake. The former
// code called ProcessInput then ProcessOutput synchronously every frame, so the
// MFT accepted input but never signalled output → permanent stall → OpenH264.
func (m *mftEncoder) encodeAsync(sample uintptr) ([]byte, error) {
	// Drain events already queued: collect finished frames + NeedInput credits.
	if err := m.pumpEvents(); err != nil {
		return m.popPendingOutput(), err
	}

	// If the MFT isn't asking for input yet, yield-spin briefly (bounded) for a
	// NeedInput token so we don't drop this captured frame at startup or under
	// transient backpressure.
	if m.needInputCredits == 0 {
		deadline := time.Now().Add(mftAsyncInputWait)
		for {
			runtime.Gosched()
			if err := m.pumpEvents(); err != nil {
				return m.popPendingOutput(), err
			}
			if m.needInputCredits > 0 || !time.Now().Before(deadline) {
				break
			}
		}
	}

	if m.needInputCredits > 0 {
		ret, _, _ := syscall.SyscallN(
			m.vtblFn(vtblProcessInput),
			m.transform,
			0, // stream ID
			sample,
			0, // flags
		)
		if uint32(ret) == mfENotAccepting {
			// Should not happen while a NeedInput credit is held. The frame is
			// LOST (the caller releases the sample after we return), so this
			// warrants Warn, not Debug — if a driver hits this repeatedly it
			// must be visible in shipped logs.
			slog.Warn("async ProcessInput returned NOTACCEPTING despite NeedInput credit, frame dropped",
				"frameIdx", m.frameIdx)
		} else if int32(ret) < 0 {
			return m.popPendingOutput(), fmt.Errorf("ProcessInput (async): 0x%08X", uint32(ret))
		} else {
			m.needInputCredits--
		}
	} else {
		// No NeedInput credit arrived within the bounded wait: this captured
		// (and possibly GPU-converted) frame is dropped, NOT buffered. Distinct
		// from "encoder still buffering" — log it so backpressure drops are
		// distinguishable from warm-up in the log stream.
		slog.Debug("async MFT gave no NeedInput credit within bounded wait, dropping captured frame",
			"waitMs", mftAsyncInputWait.Milliseconds(), "frameIdx", m.frameIdx)
	}

	// Feeding input may synchronously post a HaveOutput; drain once more so the
	// completed frame is available to this or the next call.
	if err := m.pumpEvents(); err != nil {
		return m.popPendingOutput(), err
	}

	return m.popPendingOutput(), nil
}

// popPendingOutput returns the oldest drained frame (FIFO) so the P-frame
// reference chain is delivered in order, or nil if none. Caller holds m.mu.
func (m *mftEncoder) popPendingOutput() []byte {
	if len(m.pendingOutput) == 0 {
		return nil
	}
	out := m.pendingOutput[0]
	m.pendingOutput = m.pendingOutput[1:]
	return out
}

// pumpEvents non-blockingly drains the async MFT event queue, servicing
// METransformHaveOutput (ProcessOutput → append to pendingOutput) and counting
// METransformNeedInput credits. It never blocks (MF_EVENT_FLAG_NO_WAIT), so it
// cannot hold the encoder mutex waiting on the driver. Caller holds m.mu.
func (m *mftEncoder) pumpEvents() error {
	genVtbl := *(*uintptr)(unsafe.Pointer(m.eventGen))
	getEventFn := *(*uintptr)(unsafe.Pointer(genVtbl + uintptr(vtblGetEvent)*unsafe.Sizeof(uintptr(0))))
	for {
		var ev uintptr
		ret, _, _ := syscall.SyscallN(getEventFn, m.eventGen, uintptr(mfEventFlagNoWait), uintptr(unsafe.Pointer(&ev)))
		if uint32(ret) == mfENoEvents {
			return nil // queue drained
		}
		if int32(ret) < 0 || ev == 0 {
			// A real GetEvent failure (MF_E_SHUTDOWN, driver fault, ...) is a
			// different animal from an empty queue — if it's swallowed, a dead
			// event generator is indistinguishable from benign buffering in
			// the logs. Surface the HRESULT and propagate so the caller's
			// error path (and ultimately the stall machinery) sees it.
			slog.Warn("Async MFT GetEvent failed (not MF_E_NO_EVENTS)",
				"hr", fmt.Sprintf("0x%08X", uint32(ret)), "frameIdx", m.frameIdx)
			return fmt.Errorf("IMFMediaEventGenerator::GetEvent: 0x%08X", uint32(ret))
		}

		var evType uint32
		evVtbl := *(*uintptr)(unsafe.Pointer(ev))
		getTypeFn := *(*uintptr)(unsafe.Pointer(evVtbl + uintptr(vtblMediaEventGetType)*unsafe.Sizeof(uintptr(0))))
		syscall.SyscallN(getTypeFn, ev, uintptr(unsafe.Pointer(&evType)))
		comRelease(ev)

		switch evType {
		case meTransformNeedInput:
			m.needInputCredits++
		case meTransformHaveOutput:
			// drainOutput performs a single ProcessOutput for this event and
			// reuses all the providesSamples / stream-change / buffer-grow
			// handling. HaveOutput guarantees one frame is ready.
			out, err := m.drainOutput()
			if err != nil {
				return err
			}
			if out != nil {
				m.pendingOutput = append(m.pendingOutput, out)
			}
		}
	}
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

// flushLocked drops all buffered frames and restarts streaming. Caller must hold m.mu.
func (m *mftEncoder) flushLocked() {
	if !m.inited || m.transform == 0 {
		return
	}
	comCall(m.transform, vtblProcessMessage, mftMessageCommandFlush, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyBeginStreaming, 0)
	comCall(m.transform, vtblProcessMessage, mftMessageNotifyStartOfStream, 0)
	// A flush discards queued input/output; drop stale async event state so we
	// don't feed against credits that no longer exist or return dead output.
	// START_OF_STREAM re-arms the MFT to post fresh METransformNeedInput events.
	// Already-encoded frames waiting in pendingOutput are lost here (e.g. a
	// click-flush landing while a drained frame awaits delivery) — log the
	// count so a stutter-after-click has a trace.
	if n := len(m.pendingOutput); n > 0 {
		slog.Debug("MFT flush discarding buffered async output frames",
			"frames", n, "frameIdx", m.frameIdx)
	}
	m.needInputCredits = 0
	m.pendingOutput = nil
	m.forceKeyframePending = true
	_ = m.forceKeyframeLocked()
}

// Flush drops all buffered frames from the MFT encoder pipeline and forces the
// next output to be an IDR keyframe. Used on mouse clicks so the viewer
// immediately shows the result of the click instead of displaying stale
// animation frames queued before the click.
func (m *mftEncoder) Flush() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.flushLocked()
	return nil
}

// trackNilOutput tracks consecutive nil outputs from drainOutput and auto-flushes
// when the MFT appears stalled. Hardware MFTs (Intel Quick Sync, etc.) can
// permanently stall on certain GPUs — accepting input but never producing output.
// Two flush cycles with 2s cooldowns detect this within ~5 seconds, allowing the
// capture loop to swap to OpenH264 before the viewer gives up. Caller must hold m.mu.
func (m *mftEncoder) trackNilOutput(out []byte) {
	if out == nil {
		m.consecutiveNilOutputs++
		if m.consecutiveNilOutputs == 3 || m.consecutiveNilOutputs == 10 {
			slog.Warn("MFT encoder not producing output (buffering)",
				"consecutiveNil", m.consecutiveNilOutputs,
				"frameIdx", m.frameIdx,
				"isHW", m.isHW,
				"gpuFailed", m.gpuFailed,
			)
		}
		threshold := mftStallThreshold
		// After a recent flush, use a lower threshold for faster second recovery.
		if m.lastStallFlush != (time.Time{}) && time.Since(m.lastStallFlush) < 10*time.Second {
			threshold = mftStallThreshold / 2
		}
		if m.consecutiveNilOutputs >= threshold && time.Since(m.lastStallFlush) >= 2*time.Second {
			// Track consecutive flush cycles without output. If the encoder
			// never produces output after multiple flushes, it's permanently
			// broken (common on certain Intel/AMD GPUs with hardware MFTs).
			if !m.outputSinceFlush && m.stallFlushCount > 0 {
				m.stallFlushCount++
			} else {
				m.stallFlushCount = 1
			}
			m.outputSinceFlush = false

			if m.stallFlushCount >= 2 {
				if m.useDXGISamples {
					// Stall began on the zero-copy input path — downgrade to
					// the readback path before declaring the encoder dead.
					// teardownDXGIManager flushes + restarts streaming.
					slog.Warn("MFT stalling with zero-copy input, downgrading to readback path",
						"stallFlushCount", m.stallFlushCount, "frameIdx", m.frameIdx)
					m.teardownDXGIManager()
					m.consecutiveNilOutputs = 0
					m.stallFlushCount = 0
					m.outputSinceFlush = false
					m.lastStallFlush = time.Now()
					m.forceKeyframePending = true
					return
				}
				slog.Error("MFT encoder permanently stalled — flush recovery not working",
					"stallFlushCount", m.stallFlushCount,
					"frameIdx", m.frameIdx,
					"isHW", m.isHW,
				)
				m.permanentlyStalled = true
				return
			}

			slog.Warn("MFT encoder stalled, flushing pipeline to recover",
				"consecutiveNil", m.consecutiveNilOutputs,
				"frameIdx", m.frameIdx,
				"isHW", m.isHW,
				"stallFlushCount", m.stallFlushCount,
			)
			m.flushLocked()
			m.consecutiveNilOutputs = 0
			m.lastStallFlush = time.Now()
		}
	} else {
		if m.consecutiveNilOutputs > 2 {
			slog.Info("MFT encoder resumed output after buffering",
				"nilCount", m.consecutiveNilOutputs)
		}
		m.consecutiveNilOutputs = 0
		m.outputSinceFlush = true
		m.stallFlushCount = 0
	}
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
			slog.Warn("GPU converter init failed, falling back to CPU path permanently", "error", err.Error())
			m.gpuEnabled = false
			m.gpuFailed = true
			m.teardownDXGIManager()
			// Force a full MFT reinit for the CPU path. The MFT can end up
			// in a stuck state (accepts ProcessInput but never produces
			// ProcessOutput) when initialized during a failed GPU pipeline
			// setup. resetForCPUFallback() handles the full teardown, reinit,
			// and encoder priming sequence inline.
			m.resetForCPUFallback()
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

	// Zero-copy: feed the converted NV12 GPU texture straight to the MFT as a
	// DXGI-surface sample — no CPU readback, no sample memcpy. Requires the
	// async event handshake (the historical "hardware MFTs stall on DXGI
	// surface samples" was the async MFT being driven synchronously). The
	// first 3 frames go through the readback path below so the black-frame
	// content check can validate the GPU converter output.
	if m.useDXGISamples && m.asyncMode && m.gpuFrameCount >= 3 {
		if m.consecutiveNilOutputs >= mftStallThreshold {
			// Zero-copy input stalling this MFT — downgrade to the readback
			// path (this same call falls through) instead of giving up on
			// hardware encoding entirely.
			slog.Warn("Zero-copy DXGI input stalling, downgrading to GPU readback path",
				"consecutiveNil", m.consecutiveNilOutputs, "frameIdx", m.frameIdx)
			m.teardownDXGIManager()
			m.consecutiveNilOutputs = 0
			m.stallFlushCount = 0
			m.outputSinceFlush = false
			m.lastStallFlush = time.Now()
			m.forceKeyframePending = true
		} else {
			// Convert/sample-creation failures downgrade to the readback path
			// (fall through below in this same call) rather than returning an
			// error: a hard error here would count against the session's
			// gpuEncodeErrors and, after 3 strikes, disable the ENTIRE GPU
			// pipeline — skipping the readback rung of the ladder that the
			// stall branch above deliberately preserves.
			nv12Tex, convErr := m.gpuConv.Convert()
			if convErr == nil {
				m.gpuFrameCount++
				texSample, sErr := m.createTextureSample(nv12Tex)
				if sErr == nil {
					out, err := m.encodeAsync(texSample)
					comRelease(texSample)
					if err != nil {
						return out, err
					}
					if out != nil && !m.zeroCopyLogged {
						m.zeroCopyLogged = true
						slog.Info("Zero-copy DXGI input active (GPU NV12 → MFT, no readback)",
							"width", m.width, "height", m.height)
					}
					m.trackNilOutput(out)
					return out, nil
				}
				slog.Warn("Zero-copy texture sample creation failed, downgrading to GPU readback path",
					"error", sErr.Error(), "frameIdx", m.frameIdx)
			} else {
				slog.Warn("Zero-copy GPU convert failed, downgrading to GPU readback path",
					"error", convErr.Error(), "frameIdx", m.frameIdx)
			}
			m.teardownDXGIManager()
			m.forceKeyframePending = true
		}
	}

	// GPU BGRA→NV12 conversion + readback to CPU memory.
	// The GPU does the expensive color conversion via VideoProcessorBlt;
	// the NV12 result is read back to CPU and fed as a regular memory buffer.
	// Used for the first 3 frames (content check) and as the fallback when
	// zero-copy DXGI input is unavailable or was downgraded.
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
		// Warn for initial frames (black screen detection), debug afterward
		logFn := slog.Debug
		if m.gpuFrameCount <= 3 {
			logFn = slog.Warn
		}
		logFn("NV12 content check",
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
			m.resetForCPUFallback()
			return nil, fmt.Errorf("GPU converter produced all-black frame (display %dx%d)", m.width, m.height)
		}
	}

	// 2. Create MF sample with NV12 data (same path as CPU Encode)
	sample, err := m.createSample(nv12)
	if err != nil {
		return nil, fmt.Errorf("create sample: %w", err)
	}
	defer comRelease(sample)

	// 3. Feed to encoder. If the MFT is mid-stall (accepting input but not
	// producing output), skip feeding and mark permanently stalled instead
	// of risking a blocking ProcessInput call.
	if m.consecutiveNilOutputs >= mftStallThreshold {
		// NOTE: sample is released by the deferred comRelease above — an
		// explicit release here would double-release (refcount already 1).
		m.permanentlyStalled = true
		slog.Warn("MFT stall detected before ProcessInput, marking permanently stalled",
			"consecutiveNil", m.consecutiveNilOutputs, "frameIdx", m.frameIdx, "isHW", m.isHW)
		return nil, nil
	}

	// Async hardware MFT: drive via the METransformNeedInput/HaveOutput event
	// handshake instead of synchronous ProcessInput/ProcessOutput polling.
	if m.asyncMode {
		out, err := m.encodeAsync(sample)
		if err != nil {
			return out, err
		}
		m.trackNilOutput(out)
		return out, nil
	}

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
			m.trackNilOutput(out)
			return out, nil
		}
		if out != nil {
			m.trackNilOutput(out)
			return out, nil
		}
	} else if int32(ret) < 0 {
		return nil, fmt.Errorf("ProcessInput (GPU): 0x%08X", uint32(ret))
	}

	out, err := m.drainOutput()
	if err != nil {
		return out, err
	}
	m.trackNilOutput(out)
	return out, nil
}
