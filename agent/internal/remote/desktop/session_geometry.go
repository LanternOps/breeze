package desktop

import (
	"fmt"
	"log/slog"
	"time"
)

// Mid-session resolution changes (#11754).
//
// A display mode change (display settings, an RDP-style resize, a scale change,
// a monitor hot-plug) reaches the session as frames of a new size: DXGI
// re-reads the mode when it reinitialises after ACCESS_LOST, ScreenCaptureKit
// restarts its stream with a rebuilt filter, X11 re-reads the root window size,
// GDI reads the screen size per frame. The capture loop compares every frame it
// is about to encode with the size it last streamed, and on a change:
//
//  1. runs a geometry transition: held input is released and the geometry epoch
//     moves (pointer events mapped against the old size are dropped), the input
//     handler re-reads its screen metrics and the display offset is re-applied,
//     and the viewer is sent monitor_switched with the new size and epochs;
//  2. resizes the encoder in place (every backend re-initialises on a new size
//     in SetDimensions) and forces an IDR, so the first frame at the new size
//     carries fresh SPS/PPS.
//
// The encoder is never handed a frame of the wrong size: the old behaviour was
// FitRGBAFrame failing every frame until the 5-strike software swap happened to
// pick up the new size, and forever when the encoder was already OpenH264.

// encoderResizeRetryBackoff is how long the capture loop drops frames after an
// encoder resize failed before it tries the resize again.
const encoderResizeRetryBackoff = time.Second

// geometryReasonResolutionChange is the reason carried by the monitor_switched
// a resolution change sends. The viewer uses it to hold pointer input until it
// decodes a frame at the announced size.
const geometryReasonResolutionChange = "resolution_change"

// sendGeometryAnnouncement sends a geometry announcement on the control
// channel. A var so tests can record what the viewer would be told.
var sendGeometryAnnouncement = func(s *Session, body map[string]any) { s.sendControlJSON(body) }

// followFrameGeometry runs before a frame of frameW x frameH is encoded. It
// starts a geometry transition when the capture size changed, and makes the
// encoder's size match the frame's. It reports whether the frame may be
// encoded; false means the encoder could not be resized and the frame must be
// dropped rather than fed to an encoder of another size.
//
// Capture goroutine only: captureW/captureH and encoderResizeRetryAt are owned
// by it.
func (s *Session) followFrameGeometry(cap ScreenCapturer, enc *VideoEncoder, frameW, frameH int) bool {
	w, h := AlignEven(frameW, frameH)
	if w == 0 || h == 0 {
		// Nothing sensible to resize to; let the encoder report the frame.
		return true
	}
	switch {
	case s.captureW == 0 && s.captureH == 0:
		// The start size was never recorded: adopt the first frame's.
		s.adoptCaptureSize(cap, w, h)
	case s.captureCap != nil && cap != s.captureCap:
		// First frame from the capturer a monitor switch installed. The switch
		// already ran the geometry transition and announced the monitor; its
		// size is this capturer's starting size, not a resolution change.
		s.adoptCaptureSize(cap, w, h)
	case w != s.captureW || h != s.captureH:
		s.applyCaptureGeometry(cap, w, h, geometryReasonResolutionChange)
	}
	return s.ensureEncoderDimensions(enc, w, h)
}

// adoptCaptureSize records w x h as cap's streamed size without a transition.
func (s *Session) adoptCaptureSize(cap ScreenCapturer, w, h int) {
	s.captureW, s.captureH = w, h
	s.captureCap = cap
}

// followBoundsGeometry is followFrameGeometry for the GPU texture path, where
// no CPU frame exists: the DXGI texture is always the capturer's current mode,
// which GetScreenBounds reports (cached, no syscall).
func (s *Session) followBoundsGeometry(cap ScreenCapturer, enc *VideoEncoder) bool {
	w, h, err := cap.GetScreenBounds()
	if err != nil {
		// DXGI's GetScreenBounds only fails off the DXGI path (no cached mode
		// and GetSystemMetrics returned zero). The texture path then behaves as
		// it did before #11754; a size change still reaches the session through
		// the desktop-switch flag a DXGI re-init sets.
		return true
	}
	return s.followFrameGeometry(cap, enc, w, h)
}

// applyCaptureGeometry is the geometry transition for a capture size change on
// the current monitor. It takes geometryMu, so it is serialised with monitor
// and desktop switches.
func (s *Session) applyCaptureGeometry(cap ScreenCapturer, w, h int, reason string) {
	s.geometryMu.Lock()
	defer s.geometryMu.Unlock()

	s.mu.RLock()
	current, index := s.capturer, s.displayIndex
	s.mu.RUnlock()
	if current != cap {
		// A monitor switch replaced the capturer after this frame was taken.
		// Its own transition announces the new monitor; announcing this
		// frame's size under the new index would tell the viewer the wrong
		// geometry.
		return
	}

	slog.Info("Display resolution changed mid-session",
		"session", s.id, "display", index, "reason", reason,
		"from", fmt.Sprintf("%dx%d", s.captureW, s.captureH),
		"to", fmt.Sprintf("%dx%d", w, h))

	// Coordinates in flight were mapped against the old size: release held
	// input and move the geometry epoch before anything else changes.
	s.resetInputGeometry(reason)
	s.adoptCaptureSize(cap, w, h)
	s.refreshInputGeometry(index)

	body := s.monitorSwitchedMessage(index, w, h)
	body["reason"] = reason
	sendGeometryAnnouncement(s, body)

	// DXGI only delivers a frame when something is redrawn; a static desktop
	// would otherwise keep the viewer on the old picture.
	forceDesktopRepaint()
}

// adoptCaptureBounds records the capturer's current bounds as the streamed
// size and refreshes the input handler's screen metrics, inside a geometry
// transition that already moved the epochs and announces the monitor itself
// (a desktop switch). The encoder follows on the next frame. It reports
// whether the size changed: a DXGI re-init after a display mode change
// arrives as a desktop switch, and the caller then announces the monitor as a
// resolution change so the viewer holds pointer input for the new size.
func (s *Session) adoptCaptureBounds(cap ScreenCapturer) (resized bool) {
	w, h, err := cap.GetScreenBounds()
	if err != nil {
		slog.Warn("Desktop switch: capture bounds unavailable; the capture path will follow the first frame",
			"session", s.id, "error", err.Error())
		return false
	}
	w, h = AlignEven(w, h)
	if w == 0 || h == 0 {
		return false
	}
	resized = s.captureW != 0 && (w != s.captureW || h != s.captureH)
	if resized {
		slog.Info("Display resolution changed across a desktop switch",
			"session", s.id,
			"from", fmt.Sprintf("%dx%d", s.captureW, s.captureH),
			"to", fmt.Sprintf("%dx%d", w, h))
	}
	s.adoptCaptureSize(cap, w, h)
	if r, ok := s.inputHandler.(ScreenGeometryRefresher); ok {
		r.RefreshScreenGeometry()
	}
	return resized
}

// refreshInputGeometry makes the input handler re-read the screen metrics it
// caches (Windows virtual-screen size, macOS backing scale) and re-applies the
// display offset: a mode change on one monitor moves the origin of the others.
func (s *Session) refreshInputGeometry(index int) {
	if s.inputHandler == nil {
		return
	}
	if r, ok := s.inputHandler.(ScreenGeometryRefresher); ok {
		r.RefreshScreenGeometry()
	}
	applyDisplayOffset(s.inputHandler, index, &s.cursorOffsetX, &s.cursorOffsetY)
}

// ensureEncoderDimensions resizes enc to w x h when it is configured for
// another size, forcing an IDR at the new size. It reports whether enc can
// take a w x h frame now.
func (s *Session) ensureEncoderDimensions(enc *VideoEncoder, w, h int) bool {
	ew, eh := enc.Dimensions()
	if ew == w && eh == h {
		return true
	}
	now := time.Now()
	if !s.encoderResizeRetryAt.IsZero() && now.Before(s.encoderResizeRetryAt) {
		return false
	}
	if err := enc.SetDimensions(w, h); err != nil {
		s.encoderResizeRetryAt = now.Add(encoderResizeRetryBackoff)
		slog.Warn("Encoder could not be resized to the capture size; dropping frames",
			"session", s.id, "backend", enc.BackendName(),
			"from", fmt.Sprintf("%dx%d", ew, eh),
			"to", fmt.Sprintf("%dx%d", w, h),
			"retryIn", encoderResizeRetryBackoff, "error", err.Error())
		if enc.BackendIsHardware() {
			// The hardware encoder cannot run at this size. The software
			// encoder replacing it is sized from the capturer's bounds and
			// corrected here on the next frame if those differ, so the
			// backoff (which was for the hardware encoder) must not delay it.
			s.swapToSoftwareEncoder()
			if s.encoder.Load() != enc {
				s.encoderResizeRetryAt = time.Time{}
			}
		}
		return false
	}
	s.encoderResizeRetryAt = time.Time{}
	// The cached frame is at the old size; the idle resend must not replay it.
	s.clearCachedEncodedFrame()
	if err := enc.ForceKeyframe(); err != nil {
		// Without the IDR the viewer has no SPS/PPS for the new size until the
		// next natural keyframe.
		slog.Warn("Failed to force keyframe after encoder resize", "session", s.id, "error", err.Error())
	}
	slog.Info("Encoder resized to the capture size",
		"session", s.id, "backend", enc.BackendName(),
		"from", fmt.Sprintf("%dx%d", ew, eh),
		"to", fmt.Sprintf("%dx%d", w, h))
	return true
}
