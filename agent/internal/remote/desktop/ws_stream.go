package desktop

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// StreamConfig holds configuration for WebSocket-based desktop streaming
type StreamConfig struct {
	Quality     int     `json:"quality"`     // JPEG quality 1-100
	ScaleFactor float64 `json:"scaleFactor"` // 0.1-1.0
	MaxFPS      int     `json:"maxFps"`      // 1-30
}

// DefaultStreamConfig returns sensible defaults for streaming
func DefaultStreamConfig() StreamConfig {
	return StreamConfig{
		Quality:     60,
		ScaleFactor: 0.5,
		MaxFPS:      15,
	}
}

// SendFrameFunc is the callback used to send a JPEG frame to the API.
// The provided data slice is only valid for the duration of the call; if an
// implementation needs to retain it, it must make a copy.
type SendFrameFunc func(sessionId string, data []byte) error

// WsStreamSession manages a single WebSocket-based desktop streaming session
type WsStreamSession struct {
	id           string
	capturer     ScreenCapturer
	inputHandler InputHandler
	sendFrame    SendFrameFunc
	config       StreamConfig
	done         chan struct{}
	mu           sync.RWMutex
	isActive     bool

	// Optimized pipeline components
	differ   *frameDiffer
	cursor   *cursorOverlay
	metrics  *StreamMetrics
	adaptive *adaptiveQuality
}

// newWsStreamSession creates a new streaming session (called by WsSessionManager)
func newWsStreamSession(id string, capturer ScreenCapturer, inputHandler InputHandler, sendFrame SendFrameFunc, config StreamConfig) *WsStreamSession {
	return &WsStreamSession{
		id:           id,
		capturer:     capturer,
		inputHandler: inputHandler,
		sendFrame:    sendFrame,
		config:       config,
		done:         make(chan struct{}),
		isActive:     true,
		differ:       newFrameDiffer(),
		cursor:       newCursorOverlay(),
		metrics:      newStreamMetrics(),
		adaptive:     newAdaptiveQuality(config.Quality),
	}
}

// Start begins the capture loop and metrics logger in goroutines
func (s *WsStreamSession) Start() {
	go s.captureLoop()
	go s.metricsLogger()
}

// captureLoop runs at the configured FPS and sends JPEG frames
func (s *WsStreamSession) captureLoop() {
	fps := s.getFPS()
	frameDuration := time.Second / time.Duration(fps)
	ticker := time.NewTicker(frameDuration)
	defer ticker.Stop()

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			newFPS := s.getFPS()
			if newFPS != fps {
				fps = newFPS
				frameDuration = time.Second / time.Duration(fps)
				ticker.Reset(frameDuration)
			}
			s.captureAndSend()
		}
	}
}

func (s *WsStreamSession) getFPS() int {
	s.mu.RLock()
	fps := s.config.MaxFPS
	s.mu.RUnlock()
	return clampInt(fps, 1, 30)
}

// captureAndSend captures one frame through the optimized pipeline:
// Capture → Frame diff → Cursor composite → Fast scale → Adaptive quality → Pooled JPEG encode → Send
func (s *WsStreamSession) captureAndSend() {
	s.mu.RLock()
	if !s.isActive {
		s.mu.RUnlock()
		return
	}
	scaleFactor := s.config.ScaleFactor
	s.mu.RUnlock()

	// 1. Capture (using persistent GDI handles)
	t0 := time.Now()
	img, err := s.capturer.Capture()
	captureTime := time.Since(t0)
	if err != nil {
		slog.Warn("Desktop capture error", "sessionId", s.id, "error", err)
		return
	}
	if img == nil {
		// DXGI capturers return nil,nil when no new frame is available.
		s.metrics.RecordSkip()
		return
	}
	s.metrics.RecordCapture(captureTime)

	// WS streaming uses image operations (cursor overlay, JPEG encoding) that assume RGBA byte order.
	// Convert DXGI's BGRA frames in-place to avoid swapped channels in JPEG output.
	if bgraCap, ok := s.capturer.(BGRAProvider); ok && bgraCap.IsBGRA() {
		bgraToRGBAInPlace(img.Pix)
	}

	// 2. Frame differencing — skip encode+send if pixels unchanged
	if !s.differ.HasChanged(img.Pix) {
		captureImagePool.Put(img)
		s.metrics.RecordSkip()
		return
	}

	// 3. Cursor compositing (drawn at full resolution, scales naturally)
	s.cursor.CompositeCursor(img)

	// 4. Fast scale using direct Pix manipulation
	var scaled = img
	t1 := time.Now()
	if scaleFactor < 1.0 && scaleFactor > 0 {
		scaled = ScaleImageFast(img, scaleFactor)
		captureImagePool.Put(img) // return full-res image to pool
	}
	s.metrics.RecordScale(time.Since(t1))

	// 5. Get adaptive quality
	quality := s.adaptive.Quality()
	s.metrics.SetQuality(quality)

	// 6. Pooled JPEG encode
	t2 := time.Now()
	buf, err := EncodeJPEGPooled(scaled, quality)
	encodeTime := time.Since(t2)

	// Return scaled image to pool (only if it was a different image from capture)
	if scaleFactor < 1.0 && scaleFactor > 0 {
		scaledImagePool.Put(scaled)
	} else {
		captureImagePool.Put(scaled)
	}

	if err != nil {
		slog.Warn("Desktop JPEG encode error", "sessionId", s.id, "error", err)
		return
	}

	frameSize := buf.Len()
	s.metrics.RecordEncode(encodeTime, frameSize)

	// 7. Send frame
	jpegData := buf.Bytes()
	sendErr := s.sendFrame(s.id, jpegData)
	putBuffer(buf) // return buffer to pool after send copies it

	if sendErr != nil {
		s.metrics.RecordDrop()
		s.adaptive.RecordFrame(encodeTime, frameSize, true)
	} else {
		s.metrics.RecordSend(frameSize)
		s.adaptive.RecordFrame(encodeTime, frameSize, false)
	}

	// 8. Let adaptive quality recalculate
	s.adaptive.Adjust()
}

// metricsLogger periodically logs streaming metrics
func (s *WsStreamSession) metricsLogger() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			snap := s.metrics.Snapshot()
			slog.Info("Desktop stream metrics",
				"sessionId", s.id,
				"captured", snap.FramesCaptured,
				"encoded", snap.FramesEncoded,
				"sent", snap.FramesSent,
				"skipped", snap.FramesSkipped,
				"dropped", snap.FramesDropped,
				"captureMs", fmt.Sprintf("%.1f", snap.CaptureMs),
				"scaleMs", fmt.Sprintf("%.1f", snap.ScaleMs),
				"encodeMs", fmt.Sprintf("%.1f", snap.EncodeMs),
				"frameBytes", snap.LastFrameSize,
				"bandwidthKBps", fmt.Sprintf("%.1f", snap.BandwidthKBps),
				"quality", snap.CurrentQuality,
				"uptime", snap.Uptime.Round(time.Second),
			)
		}
	}
}

// HandleInput delegates an input event to the platform input handler
func (s *WsStreamSession) HandleInput(event InputEvent) error {
	if s.inputHandler == nil {
		return fmt.Errorf("no input handler available")
	}
	return s.inputHandler.HandleEvent(event)
}

// UpdateConfig updates streaming parameters live
func (s *WsStreamSession) UpdateConfig(config StreamConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if config.Quality >= 1 && config.Quality <= 100 {
		s.config.Quality = config.Quality
		s.adaptive.SetBaseQuality(config.Quality)
	}
	if config.ScaleFactor > 0 && config.ScaleFactor <= 1.0 {
		s.config.ScaleFactor = config.ScaleFactor
		s.differ.Reset() // resolution change invalidates frame diff
	}
	if config.MaxFPS >= 1 && config.MaxFPS <= 30 {
		s.config.MaxFPS = config.MaxFPS
	}
}

// GetScreenBounds returns the remote screen dimensions
func (s *WsStreamSession) GetScreenBounds() (width, height int, err error) {
	return s.capturer.GetScreenBounds()
}

// Stop terminates the session and releases resources
func (s *WsStreamSession) Stop() {
	s.mu.Lock()
	if !s.isActive {
		s.mu.Unlock()
		return
	}
	s.isActive = false
	s.mu.Unlock()

	close(s.done)
	if s.capturer != nil {
		s.capturer.Close()
	}

	// Log final metrics
	snap := s.metrics.Snapshot()
	slog.Info("Desktop WS stream session stopped",
		"sessionId", s.id,
		"totalCaptured", snap.FramesCaptured,
		"totalSent", snap.FramesSent,
		"totalSkipped", snap.FramesSkipped,
		"avgBandwidthKBps", fmt.Sprintf("%.1f", snap.BandwidthKBps),
		"uptime", snap.Uptime.Round(time.Second),
	)
}
