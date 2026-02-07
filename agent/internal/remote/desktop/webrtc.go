package desktop

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/pion/webrtc/v3"
	"github.com/pion/webrtc/v3/pkg/media"

	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/breeze-rmm/agent/internal/remote/filedrop"
)

const (
	frameRate    = 15
	frameTimeout = time.Second / frameRate
)

// Session represents a remote desktop WebRTC session
type Session struct {
	id            string
	peerConn      *webrtc.PeerConnection
	videoTrack    *webrtc.TrackLocalStaticSample
	dataChannel   *webrtc.DataChannel
	inputHandler  InputHandler
	capturer      ScreenCapturer
	clipboardSync *clipboard.ClipboardSync
	fileDropHandler *filedrop.FileDropHandler
	done          chan struct{}
	mu            sync.RWMutex
	isActive      bool
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

	// Create video track
	videoTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8},
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

	// Create screen capturer using existing interface
	capturer, err := NewScreenCapturer(DefaultConfig())
	if err != nil {
		peerConn.Close()
		return "", fmt.Errorf("failed to create screen capturer: %w", err)
	}

	// Create session
	session := &Session{
		id:           sessionID,
		peerConn:     peerConn,
		videoTrack:   videoTrack,
		inputHandler: NewInputHandler(),
		capturer:     capturer,
		done:         make(chan struct{}),
		isActive:     true,
	}

	// Create clipboard DataChannel for clipboard sync
	clipboardDC, err := peerConn.CreateDataChannel("clipboard", nil)
	if err != nil {
		fmt.Printf("Desktop session %s: failed to create clipboard DataChannel: %v\n", sessionID, err)
	} else if clipboardDC != nil {
		session.clipboardSync = clipboard.NewClipboardSync(clipboardDC, clipboard.NewSystemClipboard())
		clipboardDC.OnOpen(func() {
			session.clipboardSync.Watch()
		})
	}

	// Create filedrop DataChannel for file transfers
	filedropDC, err := peerConn.CreateDataChannel("filedrop", nil)
	if err != nil {
		fmt.Printf("Desktop session %s: failed to create filedrop DataChannel: %v\n", sessionID, err)
	} else if filedropDC != nil {
		session.fileDropHandler = filedrop.NewFileDropHandler(filedropDC, "")
	}

	// Handle data channel for input events
	peerConn.OnDataChannel(func(dc *webrtc.DataChannel) {
		session.mu.Lock()
		session.dataChannel = dc
		session.mu.Unlock()

		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			session.handleInputMessage(msg.Data)
		})
	})

	// Handle connection state changes
	peerConn.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		fmt.Printf("Desktop session %s connection state: %s\n", sessionID, state.String())
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			m.StopSession(sessionID)
		}
	})

	// Set remote description (offer)
	if err := peerConn.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offer,
	}); err != nil {
		peerConn.Close()
		return "", fmt.Errorf("failed to set remote description: %w", err)
	}

	// Create answer
	answer, err := peerConn.CreateAnswer(nil)
	if err != nil {
		peerConn.Close()
		return "", fmt.Errorf("failed to create answer: %w", err)
	}

	// Set local description
	if err := peerConn.SetLocalDescription(answer); err != nil {
		peerConn.Close()
		return "", fmt.Errorf("failed to set local description: %w", err)
	}

	// Wait for ICE gathering to complete
	gatherComplete := webrtc.GatheringCompletePromise(peerConn)
	<-gatherComplete

	// Store session
	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()

	// Start capture loop
	go session.captureLoop()

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
	if s.clipboardSync != nil {
		s.clipboardSync.Stop()
	}
	if s.fileDropHandler != nil {
		s.fileDropHandler.Close()
	}
	if s.capturer != nil {
		s.capturer.Close()
	}
	s.peerConn.Close()
	fmt.Printf("Desktop session %s stopped\n", s.id)
}

// captureLoop continuously captures and sends screen frames
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

// captureAndSendFrame captures the screen and sends it via WebRTC
func (s *Session) captureAndSendFrame() {
	s.mu.RLock()
	if !s.isActive {
		s.mu.RUnlock()
		return
	}
	s.mu.RUnlock()

	// Capture screen
	img, err := s.capturer.Capture()
	if err != nil {
		return
	}

	// Encode to VP8 (simplified - in production use a proper encoder)
	// For now, we'll send raw RGBA data which won't work with standard WebRTC
	// A real implementation would use libvpx or similar
	sample := media.Sample{
		Data:     img.Pix,
		Duration: frameTimeout,
	}

	if err := s.videoTrack.WriteSample(sample); err != nil {
		fmt.Printf("Failed to write video sample: %v\n", err)
	}
}

// handleInputMessage processes input events from the data channel
func (s *Session) handleInputMessage(data []byte) {
	var event InputEvent
	if err := json.Unmarshal(data, &event); err != nil {
		fmt.Printf("Failed to parse input event: %v\n", err)
		return
	}

	if err := s.inputHandler.HandleEvent(event); err != nil {
		fmt.Printf("Failed to handle input event: %v\n", err)
	}
}

// AddICECandidate adds an ICE candidate to the session
func (s *Session) AddICECandidate(candidate string) error {
	return s.peerConn.AddICECandidate(webrtc.ICECandidateInit{
		Candidate: candidate,
	})
}
