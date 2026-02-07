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

// SendFrameFunc is the callback used to send a JPEG frame to the API
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
	}
}

// Start begins the capture loop in a goroutine
func (s *WsStreamSession) Start() {
	go s.captureLoop()
}

// captureLoop runs at the configured FPS and sends JPEG frames
func (s *WsStreamSession) captureLoop() {
	s.mu.RLock()
	fps := s.config.MaxFPS
	s.mu.RUnlock()

	if fps < 1 {
		fps = 1
	}
	if fps > 30 {
		fps = 30
	}

	ticker := time.NewTicker(time.Second / time.Duration(fps))
	defer ticker.Stop()

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.captureAndSend()
		}
	}
}

// captureAndSend captures one frame and sends it
func (s *WsStreamSession) captureAndSend() {
	s.mu.RLock()
	if !s.isActive {
		s.mu.RUnlock()
		return
	}
	quality := s.config.Quality
	scaleFactor := s.config.ScaleFactor
	s.mu.RUnlock()

	img, err := s.capturer.Capture()
	if err != nil {
		slog.Warn("Desktop capture error", "sessionId", s.id, "error", err)
		return
	}

	// Scale if needed
	if scaleFactor < 1.0 && scaleFactor > 0 {
		img = ScaleImage(img, scaleFactor)
	}

	// Encode to JPEG
	jpegData, err := EncodeJPEG(img, quality)
	if err != nil {
		slog.Warn("Desktop JPEG encode error", "sessionId", s.id, "error", err)
		return
	}

	// Send frame (non-blocking — if the channel is full, frame is dropped)
	if err := s.sendFrame(s.id, jpegData); err != nil {
		// Frame dropped or connection issue — don't log every dropped frame
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
	}
	if config.ScaleFactor > 0 && config.ScaleFactor <= 1.0 {
		s.config.ScaleFactor = config.ScaleFactor
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
	slog.Info("Desktop WS stream session stopped", "sessionId", s.id)
}
