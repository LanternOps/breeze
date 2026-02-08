package desktop

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/webrtc/v3"
	"github.com/pion/webrtc/v3/pkg/media"

	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/breeze-rmm/agent/internal/remote/filedrop"
)

const (
	frameRate    = 30
	frameTimeout = time.Second / frameRate
)

// Session represents a remote desktop WebRTC session with H264 encoding.
type Session struct {
	id            string
	peerConn      *webrtc.PeerConnection
	videoTrack    *webrtc.TrackLocalStaticSample
	dataChannel   *webrtc.DataChannel
	inputHandler  InputHandler
	capturer      ScreenCapturer
	encoder       *VideoEncoder
	clipboardSync *clipboard.ClipboardSync
	fileDropHandler *filedrop.FileDropHandler
	done          chan struct{}
	mu            sync.RWMutex
	isActive      bool

	// Optimized pipeline components (shared with WS path)
	differ   *frameDiffer
	cursor   *cursorOverlay
	metrics  *StreamMetrics
	adaptive *AdaptiveBitrate

	frameIdx uint64
}

// SessionManager manages remote desktop sessions
type SessionManager struct {
	sessions map[string]*Session
	mu       sync.RWMutex
}

// NewSessionManager creates a new session manager
func NewSessionManager() *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
	}
}

// StartSession creates and starts a new remote desktop session
func (m *SessionManager) StartSession(sessionID string, offer string) (string, error) {
	// Create WebRTC configuration
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
	}

	// Create peer connection
	peerConn, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return "", fmt.Errorf("failed to create peer connection: %w", err)
	}

	// Create H264 video track
	videoTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
		},
		"video",
		"desktop",
	)
	if err != nil {
		peerConn.Close()
		return "", fmt.Errorf("failed to create video track: %w", err)
	}

	// Add video track to peer connection
	if _, err := peerConn.AddTrack(videoTrack); err != nil {
		peerConn.Close()
		return "", fmt.Errorf("failed to add video track: %w", err)
	}

	// Create screen capturer
	capturer, err := NewScreenCapturer(DefaultConfig())
	if err != nil {
		peerConn.Close()
		return "", fmt.Errorf("failed to create screen capturer: %w", err)
	}

	// Create H264 encoder via factory (will use MFT on Windows)
	enc, err := NewVideoEncoder(EncoderConfig{
		Codec:          CodecH264,
		Quality:        QualityAuto,
		Bitrate:        2_500_000,
		FPS:            frameRate,
		PreferHardware: true,
	})
	if err != nil {
		capturer.Close()
		peerConn.Close()
		return "", fmt.Errorf("failed to create H264 encoder: %w", err)
	}

	// Set encoder dimensions from screen bounds
	w, h, err := capturer.GetScreenBounds()
	if err != nil {
		enc.Close()
		capturer.Close()
		peerConn.Close()
		return "", fmt.Errorf("failed to get screen bounds: %w", err)
	}
	if err := enc.SetDimensions(w, h); err != nil {
		enc.Close()
		capturer.Close()
		peerConn.Close()
		return "", fmt.Errorf("failed to set encoder dimensions: %w", err)
	}

	// Create session
	session := &Session{
		id:           sessionID,
		peerConn:     peerConn,
		videoTrack:   videoTrack,
		inputHandler: NewInputHandler(),
		capturer:     capturer,
		encoder:      enc,
		done:         make(chan struct{}),
		isActive:     true,
		differ:       newFrameDiffer(),
		cursor:       newCursorOverlay(),
		metrics:      newStreamMetrics(),
	}

	// Create adaptive bitrate controller
	adaptive, err := NewAdaptiveBitrate(AdaptiveConfig{
		Encoder:    enc,
		MinBitrate: 500_000,
		MaxBitrate: 5_000_000,
		MinQuality: QualityLow,
		MaxQuality: QualityUltra,
	})
	if err == nil {
		session.adaptive = adaptive
	}

	// Create clipboard DataChannel
	clipboardDC, err := peerConn.CreateDataChannel("clipboard", nil)
	if err != nil {
		slog.Warn("Failed to create clipboard DataChannel", "session", sessionID, "error", err)
	} else if clipboardDC != nil {
		session.clipboardSync = clipboard.NewClipboardSync(clipboardDC, clipboard.NewSystemClipboard())
		clipboardDC.OnOpen(func() {
			session.clipboardSync.Watch()
		})
	}

	// Create filedrop DataChannel
	filedropDC, err := peerConn.CreateDataChannel("filedrop", nil)
	if err != nil {
		slog.Warn("Failed to create filedrop DataChannel", "session", sessionID, "error", err)
	} else if filedropDC != nil {
		session.fileDropHandler = filedrop.NewFileDropHandler(filedropDC, "")
	}

	// Handle incoming data channels (input + control from viewer)
	peerConn.OnDataChannel(func(dc *webrtc.DataChannel) {
		switch dc.Label() {
		case "input":
			session.mu.Lock()
			session.dataChannel = dc
			session.mu.Unlock()
			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				session.handleInputMessage(msg.Data)
			})
		case "control":
			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				session.handleControlMessage(msg.Data)
			})
		}
	})

	// Handle connection state changes
	peerConn.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		slog.Info("Desktop WebRTC connection state", "session", sessionID, "state", state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			m.StopSession(sessionID)
		}
	})

	// Set remote description (offer from viewer)
	if err := peerConn.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offer,
	}); err != nil {
		session.cleanup()
		return "", fmt.Errorf("failed to set remote description: %w", err)
	}

	// Create answer
	answer, err := peerConn.CreateAnswer(nil)
	if err != nil {
		session.cleanup()
		return "", fmt.Errorf("failed to create answer: %w", err)
	}

	// Set local description
	if err := peerConn.SetLocalDescription(answer); err != nil {
		session.cleanup()
		return "", fmt.Errorf("failed to set local description: %w", err)
	}

	// Wait for ICE gathering to complete
	gatherComplete := webrtc.GatheringCompletePromise(peerConn)
	<-gatherComplete

	// Store session
	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()

	// Start capture loop and metrics logger
	go session.captureLoop()
	go session.metricsLogger()

	slog.Info("Desktop WebRTC session started",
		"session", sessionID,
		"width", w,
		"height", h,
	)

	return peerConn.LocalDescription().SDP, nil
}

// StopSession stops and removes a session
func (m *SessionManager) StopSession(sessionID string) {
	m.mu.Lock()
	session, ok := m.sessions[sessionID]
	if ok {
		delete(m.sessions, sessionID)
	}
	m.mu.Unlock()

	if session != nil {
		session.Stop()
	}
}

// Stop stops the session
func (s *Session) Stop() {
	s.mu.Lock()
	if !s.isActive {
		s.mu.Unlock()
		return
	}
	s.isActive = false
	s.mu.Unlock()

	close(s.done)
	s.cleanup()

	snap := s.metrics.Snapshot()
	slog.Info("Desktop WebRTC session stopped",
		"session", s.id,
		"totalCaptured", snap.FramesCaptured,
		"totalSent", snap.FramesSent,
		"totalSkipped", snap.FramesSkipped,
		"uptime", snap.Uptime.Round(time.Second),
	)
}

func (s *Session) cleanup() {
	if s.clipboardSync != nil {
		s.clipboardSync.Stop()
	}
	if s.fileDropHandler != nil {
		s.fileDropHandler.Close()
	}
	if s.encoder != nil {
		s.encoder.Close()
	}
	if s.capturer != nil {
		s.capturer.Close()
	}
	if s.peerConn != nil {
		s.peerConn.Close()
	}
}

// captureLoop continuously captures and sends encoded H264 frames
func (s *Session) captureLoop() {
	ticker := time.NewTicker(frameTimeout)
	defer ticker.Stop()

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.captureAndSendFrame()
		}
	}
}

// captureAndSendFrame captures, encodes H264, and sends via WebRTC
func (s *Session) captureAndSendFrame() {
	s.mu.RLock()
	if !s.isActive {
		s.mu.RUnlock()
		return
	}
	s.mu.RUnlock()

	// 1. Capture screen (uses persistent GDI handles + pooled images)
	t0 := time.Now()
	img, err := s.capturer.Capture()
	if err != nil {
		return
	}
	s.metrics.RecordCapture(time.Since(t0))

	// 2. Frame differencing — skip if unchanged
	if !s.differ.HasChanged(img.Pix) {
		captureImagePool.Put(img)
		s.metrics.RecordSkip()
		return
	}

	// 3. Cursor compositing (at full resolution)
	s.cursor.CompositeCursor(img)

	// 4. Encode to H264 via MFT (BGRA→NV12→H264 internally)
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
		Duration: frameTimeout,
	}
	if err := s.videoTrack.WriteSample(sample); err != nil {
		slog.Warn("Failed to write H264 sample", "session", s.id, "error", err)
		s.metrics.RecordDrop()
		return
	}

	s.metrics.RecordSend(len(h264Data))
}

// metricsLogger periodically logs streaming metrics
func (s *Session) metricsLogger() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			snap := s.metrics.Snapshot()
			slog.Info("Desktop WebRTC metrics",
				"session", s.id,
				"captured", snap.FramesCaptured,
				"encoded", snap.FramesEncoded,
				"sent", snap.FramesSent,
				"skipped", snap.FramesSkipped,
				"dropped", snap.FramesDropped,
				"encodeMs", fmt.Sprintf("%.1f", snap.EncodeMs),
				"frameBytes", snap.LastFrameSize,
				"bandwidthKBps", fmt.Sprintf("%.1f", snap.BandwidthKBps),
				"uptime", snap.Uptime.Round(time.Second),
			)
		}
	}
}

// handleInputMessage processes input events from the data channel
func (s *Session) handleInputMessage(data []byte) {
	var event InputEvent
	if err := json.Unmarshal(data, &event); err != nil {
		slog.Warn("Failed to parse input event", "session", s.id, "error", err)
		return
	}

	if err := s.inputHandler.HandleEvent(event); err != nil {
		slog.Warn("Failed to handle input event", "session", s.id, "error", err)
	}
}

// handleControlMessage processes control messages (bitrate, quality changes)
func (s *Session) handleControlMessage(data []byte) {
	var msg struct {
		Type  string `json:"type"`
		Value int    `json:"value"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	switch msg.Type {
	case "set_bitrate":
		if msg.Value > 0 {
			s.encoder.SetBitrate(msg.Value)
		}
	case "set_fps":
		if msg.Value > 0 && msg.Value <= 60 {
			s.encoder.SetFPS(msg.Value)
		}
	}
}

// AddICECandidate adds an ICE candidate to the session
func (s *Session) AddICECandidate(candidate string) error {
	return s.peerConn.AddICECandidate(webrtc.ICECandidateInit{
		Candidate: candidate,
	})
}
