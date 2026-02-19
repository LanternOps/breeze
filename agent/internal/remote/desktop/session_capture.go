package desktop

import (
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v3/pkg/media"
)

const secureDesktopMinFPS = 8

func secureDesktopMinInterval() time.Duration {
	return time.Second / secureDesktopMinFPS
}

func (s *Session) cacheEncodedFrame(data []byte) {
	if len(data) == 0 {
		return
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	s.lastEncodedMu.Lock()
	s.lastEncodedFrame = cp
	s.lastEncodedMu.Unlock()
}

func (s *Session) noteVideoWrite() {
	s.lastVideoWriteUnixNano.Store(time.Now().UnixNano())
}

func (s *Session) maybeResendCachedFrameOnSecureDesktop(cap ScreenCapturer, frameDuration time.Duration) bool {
	dsn, ok := cap.(DesktopSwitchNotifier)
	if !ok || !dsn.OnSecureDesktop() {
		return false
	}

	minInterval := secureDesktopMinInterval()
	last := s.lastVideoWriteUnixNano.Load()
	if last != 0 && time.Since(time.Unix(0, last)) < minInterval {
		return false
	}

	s.lastEncodedMu.RLock()
	cached := s.lastEncodedFrame
	if len(cached) == 0 {
		s.lastEncodedMu.RUnlock()
		return false
	}
	data := make([]byte, len(cached))
	copy(data, cached)
	s.lastEncodedMu.RUnlock()

	sample := media.Sample{
		Data:     data,
		Duration: frameDuration,
	}
	if err := s.videoTrack.WriteSample(sample); err != nil {
		slog.Debug("Failed to resend cached secure-desktop frame", "session", s.id, "error", err)
		return false
	}
	s.metrics.RecordSend(len(data))
	s.noteVideoWrite()
	return true
}

// captureLoop continuously captures and sends encoded H264 frames.
// Dispatches between DXGI tight-loop and ticker-paced modes. Mode switches
// return to this function instead of calling each other recursively, avoiding
// unbounded stack growth on repeated desktop switches.
func (s *Session) captureLoop() {
	s.mu.RLock()
	cap := s.capturer
	s.mu.RUnlock()

	mode := captureModeTicker
	if h, ok := cap.(TightLoopHint); ok && h.TightLoop() {
		mode = captureModeDXGI
	}

	for mode != captureModeStopped {
		switch mode {
		case captureModeDXGI:
			mode = s.captureLoopDXGI()
		case captureModeTicker:
			mode = s.captureLoopTicker()
		}
	}
}

// captureLoopDXGI runs a tight loop driven by DXGI's AcquireNextFrame blocking.
// No ticker — capture calls block until a new frame is available or timeout.
// Returns the next captureMode when a mode switch is needed.
func (s *Session) captureLoopDXGI() captureMode {
	fps := s.getFPS()
	frameDuration := time.Second / time.Duration(fps)
	hwChecked := false
	s.mu.RLock()
	initCap := s.capturer
	s.mu.RUnlock()
	tp, hasTP := initCap.(TextureProvider)
	gpuDisabled := false

	// Dynamic FPS scaling: track consecutive "no new frame" iterations.
	// After idleThreshold consecutive skips (~3s of static screen), enter idle
	// mode with longer sleep to save CPU/GPU. Reset on first new frame or input.
	const idleThreshold = 180               // ~3s at 60fps
	const idleSleep = 16 * time.Millisecond // one frame at 60fps — responsive wake-up
	consecutiveSkips := 0
	wasIdle := false

	// Post-switch repaint counter: after a monitor switch, keep forcing desktop
	// repaints so the browser decoder receives enough frames at the new resolution
	// to fully initialize. Without this, a static display goes idle after 2-3
	// frames, which may not be enough for the decoder to stabilize.
	postSwitchRepaints := 0
	var lastRepaintTime time.Time
	var lastSecureKeyframe time.Time

	for {
		loopStart := time.Now()
		select {
		case <-s.done:
			return captureModeStopped
		default:
		}

		// If a mouse click occurred, flush the encoder pipeline to drop stale
		// buffered frames and force an IDR so the click result appears instantly.
		if s.clickFlush.CompareAndSwap(true, false) {
			s.encoder.Flush()
			consecutiveSkips = 0 // exit idle on click
		}

		// Any input event (mouse_move, key_down, scroll, etc.) exits idle mode
		// so the capture loop polls at full speed while the user is interacting.
		if s.inputActive.CompareAndSwap(true, false) {
			if consecutiveSkips >= idleThreshold {
				wasIdle = false
			}
			consecutiveSkips = 0
		}

		// Monitor switch: re-read capturer and reinitialize GPU pipeline state.
		if s.capturerSwapped.CompareAndSwap(true, false) {
			// Close old capturers now that we're safely outside captureAndSendFrameGPU.
			s.mu.Lock()
			pending := s.oldCapturers
			s.oldCapturers = nil
			newCap := s.capturer
			s.mu.Unlock()
			for _, oc := range pending {
				oc.Close()
			}
			tp, hasTP = newCap.(TextureProvider)
			gpuDisabled = false
			hwChecked = false
			consecutiveSkips = 0
			wasIdle = false
			s.gpuEncodeErrors = 0
			s.frameIdx = 0 // reset so first frames after switch are logged
			// Pass new D3D11 device to encoder
			if hasTP && s.encoder != nil {
				s.encoder.SetD3D11Device(tp.GetD3D11Device(), tp.GetD3D11Context())
			}
			// Update encoder dimensions for the new monitor
			if w, h, err := newCap.GetScreenBounds(); err == nil && s.encoder != nil {
				if dimErr := s.encoder.SetDimensions(w, h); dimErr != nil {
					slog.Warn("Failed to set encoder dimensions after monitor switch", "session", s.id, "error", dimErr)
				}
				if kfErr := s.encoder.ForceKeyframe(); kfErr != nil {
					slog.Warn("Failed to force keyframe after monitor switch", "session", s.id, "error", kfErr)
				}
			}
			// Second repaint nudge — the first (in handleControlMessage) may
			// have been consumed by a stale capture iteration on the old capturer.
			forceDesktopRepaint()
			// Keep forcing repaints for ~2s so the browser decoder gets enough
			// frames at the new resolution to fully stabilize. Critical for
			// static displays where DXGI produces zero dirty rects naturally.
			postSwitchRepaints = 5 // a few nudges to seed dirty rects
		}

		// Check for desktop switch (Default ↔ Winlogon) and adjust offsets/keyframe
		s.handleDesktopSwitch()

		// Force repaints on the secure desktop — static screens (lock, UAC,
		// security options) don't generate dirty rects naturally.
		// Also send a zero-delta input nudge to trigger secure UI paint.
		// Throttled to once per 500ms to avoid hammering the compositor.
		s.mu.RLock()
		currentCap := s.capturer
		s.mu.RUnlock()
		if dsn, ok := currentCap.(DesktopSwitchNotifier); ok && dsn.OnSecureDesktop() {
			if time.Since(lastRepaintTime) >= 500*time.Millisecond {
				nudgeSecureDesktop()
				forceDesktopRepaint()
				lastRepaintTime = time.Now()
			}
			// Secure desktop transitions can leave the browser decoder on stale
			// predicted frames until a fresh IDR arrives. Periodic keyframes avoid
			// "content appears only after click/input" behavior.
			if s.encoder != nil && time.Since(lastSecureKeyframe) >= time.Second {
				_ = s.encoder.ForceKeyframe()
				lastSecureKeyframe = time.Now()
			}
		}

		// If the capturer falls back to a non-blocking mode (e.g. DXGI→GDI),
		// switch to the ticker loop to avoid spinning.
		if h, ok := currentCap.(TightLoopHint); ok && !h.TightLoop() {
			slog.Info("Capturer no longer supports tight loop, switching to ticker loop", "session", s.id)
			return captureModeTicker
		}

		if !hwChecked && s.encoder.BackendIsHardware() {
			hwChecked = true
			targetFPS := maxFrameRate
			if fps < targetFPS {
				fps = targetFPS
				s.mu.Lock()
				s.fps = targetFPS
				s.mu.Unlock()
				s.encoder.SetFPS(targetFPS)
				frameDuration = time.Second / time.Duration(fps)
				slog.Info("Uncapped FPS for hardware encoder",
					"session", s.id, "fps", fps)
			}
		}

		onSecure := false
		if dsn, ok := currentCap.(DesktopSwitchNotifier); ok {
			onSecure = dsn.OnSecureDesktop()
		}
		newFPS := s.getFPS()
		if onSecure && newFPS < secureDesktopMinFPS {
			newFPS = secureDesktopMinFPS
		}
		if newFPS != fps {
			fps = newFPS
			frameDuration = time.Second / time.Duration(fps)
		}

		// Prefer the GPU path when it works; fall back to CPU on any GPU error.
		frameSent := false
		if hasTP && !gpuDisabled && s.encoder.SupportsGPUInput() {
			handled, disable, sent := s.captureAndSendFrameGPU(tp, frameDuration)
			if disable {
				gpuDisabled = true
				slog.Warn("GPU capture disabled, falling back to CPU Capture() path", "session", s.id)
			}
			if handled {
				frameSent = sent
				sleepDur := frameDuration
				if !frameSent {
					if onSecure {
						frameSent = s.maybeResendCachedFrameOnSecureDesktop(currentCap, frameDuration)
					}
					consecutiveSkips++
					// After a monitor switch, keep nudging the display so
					// DXGI picks up dirty rects on an otherwise static screen.
					if postSwitchRepaints > 0 {
						postSwitchRepaints--
						forceDesktopRepaint()
					} else if consecutiveSkips >= idleThreshold {
						sleepDur = idleSleep // idle mode: poll less often
					}
				} else {
					// Scene change keyframe: if screen was static for a while and
					// we just got a new frame, force IDR for fast decoder recovery.
					if wasIdle || consecutiveSkips >= 30 {
						_ = s.encoder.ForceKeyframe()
					}
					consecutiveSkips = 0
				}
				wasIdle = consecutiveSkips >= idleThreshold
				if elapsed := time.Since(loopStart); elapsed < sleepDur {
					time.Sleep(sleepDur - elapsed)
				}
				continue
			}
		}
		s.captureAndSendFrame(frameDuration)
		// CPU path: approximate skip tracking via metrics
		sleepDur := frameDuration
		if elapsed := time.Since(loopStart); elapsed < sleepDur {
			time.Sleep(sleepDur - elapsed)
		}
	}
}

// captureLoopTicker uses a ticker for non-DXGI capturers (GDI, macOS, Linux).
// Returns the next captureMode when a mode switch is needed.
func (s *Session) captureLoopTicker() captureMode {
	fps := s.getFPS()
	frameDuration := time.Second / time.Duration(fps)
	ticker := time.NewTicker(frameDuration)
	defer ticker.Stop()

	hwChecked := false
	var lastTickerRepaint time.Time
	var lastSecureKeyframe time.Time

	for {
		select {
		case <-s.done:
			return captureModeStopped
		case <-ticker.C:
			// Check for desktop switch (Default ↔ Winlogon) and adjust offsets/keyframe.
			// Also check if the capturer regained DXGI — switch back to tight loop.
			s.handleDesktopSwitch()
			s.mu.RLock()
			currentCap := s.capturer
			s.mu.RUnlock()
			// Force repaints on the secure desktop — static screens need dirty rects.
			// Also send a zero-delta input nudge to trigger secure UI paint.
			// Throttled to once per 500ms to avoid compositor overhead.
			if dsn, ok := currentCap.(DesktopSwitchNotifier); ok && dsn.OnSecureDesktop() {
				if time.Since(lastTickerRepaint) >= 500*time.Millisecond {
					nudgeSecureDesktop()
					forceDesktopRepaint()
					lastTickerRepaint = time.Now()
				}
				if s.encoder != nil && time.Since(lastSecureKeyframe) >= time.Second {
					_ = s.encoder.ForceKeyframe()
					lastSecureKeyframe = time.Now()
				}
			}
			if h, ok := currentCap.(TightLoopHint); ok && h.TightLoop() {
				slog.Info("Capturer supports tight loop again, switching to DXGI loop", "session", s.id)
				return captureModeDXGI
			}

			// Don't uncap FPS when on a secure desktop — GDI capture is
			// CPU-heavy and running at 60fps would degrade performance.
			onSecure := false
			if dsn, ok2 := currentCap.(DesktopSwitchNotifier); ok2 {
				onSecure = dsn.OnSecureDesktop()
			}
			if !hwChecked && s.encoder.BackendIsHardware() && !onSecure {
				hwChecked = true
				targetFPS := maxFrameRate
				if fps < targetFPS {
					fps = targetFPS
					s.mu.Lock()
					s.fps = targetFPS
					s.mu.Unlock()
					s.encoder.SetFPS(targetFPS)
					frameDuration = time.Second / time.Duration(fps)
					ticker.Reset(frameDuration)
					slog.Info("Uncapped FPS for hardware encoder",
						"session", s.id, "fps", fps)
				}
			}

			newFPS := s.getFPS()
			if onSecure && newFPS < secureDesktopMinFPS {
				newFPS = secureDesktopMinFPS
			}
			if newFPS != fps {
				fps = newFPS
				frameDuration = time.Second / time.Duration(fps)
				ticker.Reset(frameDuration)
			}
			s.captureAndSendFrame(frameDuration)
		}
	}
}

// captureAndSendFrame captures, encodes H264, and sends via WebRTC
func (s *Session) captureAndSendFrame(frameDuration time.Duration) {
	s.mu.RLock()
	if !s.isActive {
		s.mu.RUnlock()
		return
	}
	cap := s.capturer
	s.mu.RUnlock()

	// 1. Capture screen
	t0 := time.Now()
	img, err := cap.Capture()
	if err != nil {
		slog.Warn("Screen capture error (CPU path)", "session", s.id, "error", err.Error())
		return
	}
	if img == nil {
		// DXGI: no new frame available (AccumulatedFrames==0)
		_ = s.maybeResendCachedFrameOnSecureDesktop(cap, frameDuration)
		s.metrics.RecordSkip()
		return
	}
	s.metrics.RecordCapture(time.Since(t0))

	// Diagnostic: check BGRA pixel data for non-black content.
	// BGRA: 4 bytes per pixel [B,G,R,A]. Black = R+G+B == 0.
	s.frameIdx++
	if s.frameIdx <= 5 || s.frameIdx%300 == 0 {
		nonBlack := 0
		totalPx := len(img.Pix) / 4
		for i := 0; i < len(img.Pix); i += 4 {
			if img.Pix[i] != 0 || img.Pix[i+1] != 0 || img.Pix[i+2] != 0 {
				nonBlack++
			}
		}
		slog.Warn("BGRA content check (CPU path)",
			"frame", s.frameIdx,
			"nonBlackPixels", nonBlack,
			"totalPixels", totalPx,
			"pixLen", len(img.Pix),
			"imgW", img.Rect.Dx(),
			"imgH", img.Rect.Dy(),
		)
	}

	// Keep the encoder's expected byte order in sync with the capturer.
	desiredPF := PixelFormatRGBA
	if bgraCap, ok := cap.(BGRAProvider); ok && bgraCap.IsBGRA() {
		desiredPF = PixelFormatBGRA
	}
	if desiredPF != s.encoderPF {
		s.encoder.SetPixelFormat(desiredPF)
		s.encoderPF = desiredPF
	}

	// DXGI capturers already skip unchanged frames (Capture() returns nil,nil).
	dxgiActive := false
	if h, ok := cap.(TightLoopHint); ok && h.TightLoop() {
		dxgiActive = true
	}
	onSecure := false
	if dsn, ok := cap.(DesktopSwitchNotifier); ok {
		onSecure = dsn.OnSecureDesktop()
	}

	// 2. Frame differencing — skip if unchanged.
	// DXGI capturers already filter via AccumulatedFrames in Capture(),
	// so we only need CRC32 for non-DXGI capturers.
	// On secure desktop, avoid CRC skipping so the encoder keeps receiving
	// frames even when UI is static; otherwise video can appear "stuck" until
	// the next input event changes pixels.
	if !dxgiActive && !onSecure {
		if !s.differ.HasChanged(img.Pix) {
			captureImagePool.Put(img)
			_ = s.maybeResendCachedFrameOnSecureDesktop(cap, frameDuration)
			s.metrics.RecordSkip()
			return
		}
	}

	// 3. Cursor compositing — skip for DXGI since the viewer renders its own cursor.
	// This saves a full-frame read+write pass at high resolutions.
	if !dxgiActive && desiredPF == PixelFormatRGBA {
		s.cursor.CompositeCursor(img)
	}

	// 4. Encode to H264 via MFT (RGBA→NV12→H264 internally)
	t1 := time.Now()
	h264Data, err := s.encoder.Encode(img.Pix)
	encodeTime := time.Since(t1)
	captureImagePool.Put(img)

	if err != nil {
		slog.Warn("H264 encode error", "session", s.id, "error", err)
		return
	}
	if h264Data == nil {
		// MFT is buffering, no output yet
		return
	}

	s.metrics.RecordEncode(encodeTime, len(h264Data))

	// 5. Write as pion media.Sample
	sample := media.Sample{
		Data:     h264Data,
		Duration: frameDuration,
	}
	if err := s.videoTrack.WriteSample(sample); err != nil {
		slog.Warn("Failed to write H264 sample", "session", s.id, "error", err)
		s.metrics.RecordDrop()
		return
	}

	s.cacheEncodedFrame(h264Data)
	s.noteVideoWrite()
	s.metrics.RecordSend(len(h264Data))
}

// captureAndSendFrameGPU captures a GPU texture and encodes via the zero-copy pipeline.
// Returns handled=true if the GPU path handled this iteration (captured, encoded, or skipped),
// disableGPU=true if the caller should stop trying the GPU path for this session,
// and sent=true if a frame was actually encoded and sent to the viewer.
func (s *Session) captureAndSendFrameGPU(tp TextureProvider, frameDuration time.Duration) (handled bool, disableGPU bool, sent bool) {
	s.mu.RLock()
	if !s.isActive {
		s.mu.RUnlock()
		return true, false, false
	}
	s.mu.RUnlock()

	t0 := time.Now()
	texture, err := tp.CaptureTexture()
	if err != nil {
		slog.Warn("GPU capture error", "session", s.id, "error", err.Error())
		return false, true, false
	}
	if texture == 0 {
		s.mu.RLock()
		cap := s.capturer
		s.mu.RUnlock()
		_ = s.maybeResendCachedFrameOnSecureDesktop(cap, frameDuration)
		s.metrics.RecordSkip()
		return true, false, false
	}
	defer tp.ReleaseTexture()
	s.metrics.RecordCapture(time.Since(t0))

	t1 := time.Now()
	h264Data, err := s.encoder.EncodeTexture(texture)
	encodeTime := time.Since(t1)

	if err != nil {
		s.gpuEncodeErrors++
		slog.Warn("GPU encode error", "session", s.id, "error", err.Error(),
			"consecutive", s.gpuEncodeErrors)
		// Allow up to 3 retries for MFT warm-up after monitor switch.
		// First frame often fails because the hardware MFT needs a warm-up cycle.
		if s.gpuEncodeErrors >= 3 {
			// Force a repaint so the CPU fallback has dirty rects to capture.
			forceDesktopRepaint()
			return true, true, false // permanently disable GPU
		}
		// Force repaint so next CaptureTexture has something to work with.
		forceDesktopRepaint()
		return true, false, false // retry next frame
	}
	s.gpuEncodeErrors = 0
	if h264Data == nil {
		return true, false, false
	}

	s.metrics.RecordEncode(encodeTime, len(h264Data))

	s.frameIdx++
	// Log the first 5 frames sent (catches monitor switch + encoder re-init)
	if s.frameIdx <= 5 {
		slog.Warn("H264 frame sent",
			"session", s.id,
			"frameIdx", s.frameIdx,
			"bytes", len(h264Data),
			"encodeMs", encodeTime.Milliseconds(),
			"nalus", describeH264NALUs(h264Data),
		)
	}

	sample := media.Sample{
		Data:     h264Data,
		Duration: frameDuration,
	}
	if err := s.videoTrack.WriteSample(sample); err != nil {
		slog.Warn("Failed to write H264 sample", "session", s.id, "error", err)
		s.metrics.RecordDrop()
		return true, false, false
	}

	s.cacheEncodedFrame(h264Data)
	s.noteVideoWrite()
	s.metrics.RecordSend(len(h264Data))
	return true, false, true
}

// handleDesktopSwitch checks if the capturer detected a desktop transition
// (Default ↔ Winlogon/Screen-saver) and adjusts cursor/input offsets and
// forces a keyframe for fast viewer recovery.
func (s *Session) handleDesktopSwitch() {
	s.mu.RLock()
	cap := s.capturer
	s.mu.RUnlock()

	dsn, ok := cap.(DesktopSwitchNotifier)
	if !ok || !dsn.ConsumeDesktopSwitch() {
		return
	}

	if dsn.OnSecureDesktop() {
		// Secure desktop is always at origin — reset offsets
		slog.Info("Desktop switch: entering secure desktop, resetting offsets", "session", s.id)
		s.inputHandler.SetDisplayOffset(0, 0)
		s.cursorOffsetX.Store(0)
		s.cursorOffsetY.Store(0)
		// Prime secure desktop rendering: some credential/UAC surfaces do not
		// fully paint until they observe input + invalidation.
		for i := 0; i < 3; i++ {
			nudgeSecureDesktop()
			forceDesktopRepaint()
			if i < 2 {
				time.Sleep(30 * time.Millisecond)
			}
		}
	} else {
		// Returning to normal desktop — restore monitor offsets
		slog.Info("Desktop switch: returning to default desktop, restoring offsets", "session", s.id)
		applyDisplayOffset(s.inputHandler, s.displayIndex, &s.cursorOffsetX, &s.cursorOffsetY)
		// Force repaint so DXGI gets dirty rects for the first frame after
		// reinitializing Desktop Duplication on the Default desktop.
		forceDesktopRepaint()
		// CRITICAL: DXGI reinit creates a new D3D11 device. The encoder's MFT
		// and GPU converter hold the OLD device/context pointers. Without this
		// update, the GPU encode path produces no frames after ~2-3 cycles.
		if tp, ok := cap.(TextureProvider); ok && s.encoder != nil {
			s.encoder.SetD3D11Device(tp.GetD3D11Device(), tp.GetD3D11Context())
			slog.Info("Updated encoder D3D11 device after desktop switch", "session", s.id)
		}
	}

	// Force keyframe so the viewer shows the new desktop content immediately
	if s.encoder != nil {
		// Drop any stale pre-switch compressed frames so the next delivered
		// frame reflects the new desktop (Default <-> Winlogon) immediately.
		s.encoder.Flush()
		_ = s.encoder.ForceKeyframe()
	}
}

// applyDisplayOffset queries the monitor list and sets the input handler's
// coordinate offset so viewer-relative (0,0) maps to the captured monitor's
// top-left corner in virtual screen space. Also stores the offset atomically
// for cursorStreamLoop to convert absolute cursor coords to display-relative.
func applyDisplayOffset(handler InputHandler, displayIndex int, cursorOffX, cursorOffY *atomic.Int32) {
	monitors, err := ListMonitors()
	if err != nil {
		slog.Warn("applyDisplayOffset: ListMonitors failed", "error", err)
		handler.SetDisplayOffset(0, 0)
		cursorOffX.Store(0)
		cursorOffY.Store(0)
		return
	}
	for _, m := range monitors {
		slog.Debug("applyDisplayOffset: monitor",
			"index", m.Index, "name", m.Name,
			"x", m.X, "y", m.Y, "w", m.Width, "h", m.Height,
			"primary", m.IsPrimary)
	}
	for _, m := range monitors {
		if m.Index == displayIndex {
			slog.Debug("applyDisplayOffset: selected",
				"display", displayIndex, "offsetX", m.X, "offsetY", m.Y)
			handler.SetDisplayOffset(m.X, m.Y)
			cursorOffX.Store(int32(m.X))
			cursorOffY.Store(int32(m.Y))
			return
		}
	}
	slog.Warn("applyDisplayOffset: display not found, using 0,0", "display", displayIndex)
	handler.SetDisplayOffset(0, 0)
	cursorOffX.Store(0)
	cursorOffY.Store(0)
}
