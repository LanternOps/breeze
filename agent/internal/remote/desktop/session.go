package desktop

import (
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v3"

	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/breeze-rmm/agent/internal/remote/filedrop"
)

const (
	defaultFrameRate = 30
	maxFrameRate     = 60

	iceGatherTimeout = 20 * time.Second
)

// captureMode indicates which capture strategy to use. Returned by the
// individual loop functions so the top-level captureLoop can switch modes
// without recursive calls (which would grow the stack on repeated switches).
type captureMode int

const (
	captureModeDXGI    captureMode = iota // tight-loop DXGI capture
	captureModeTicker                     // ticker-paced GDI/macOS/Linux capture
	captureModeStopped                    // session closed
)

// Session represents a remote desktop WebRTC session with H264 encoding.
type Session struct {
	id              string
	peerConn        *webrtc.PeerConnection
	videoTrack      *webrtc.TrackLocalStaticSample
	dataChannel     *webrtc.DataChannel
	inputHandler    InputHandler
	capturer        ScreenCapturer
	encoder         *VideoEncoder
	encoderPF       PixelFormat // cached encoder input format for CPU Encode() path
	clipboardSync   *clipboard.ClipboardSync
	fileDropHandler *filedrop.FileDropHandler
	cursorDC        *webrtc.DataChannel
	controlDC       *webrtc.DataChannel
	audioTrack      *webrtc.TrackLocalStaticSample
	audioCapturer   AudioCapturer
	audioEnabled    atomic.Bool
	done            chan struct{}
	mu              sync.RWMutex
	isActive        bool
	fps             int
	cleanupOnce     sync.Once
	stopOnce        sync.Once
	startOnce       sync.Once
	wg              sync.WaitGroup

	// Optimized pipeline components (shared with WS path)
	differ   *frameDiffer
	cursor   *cursorOverlay
	metrics  *StreamMetrics
	adaptive *AdaptiveBitrate

	// clickFlush is set by handleInputMessage on mouse_down. The capture loop
	// checks and clears it before encoding, flushing the MFT pipeline so that
	// stale animation frames are dropped and the click result appears immediately.
	clickFlush atomic.Bool

	// inputActive is set by handleInputMessage on ANY input event (mouse_move,
	// key_down, etc.). The capture loop checks and clears it to exit idle mode
	// immediately when the user is interacting, even without screen changes.
	inputActive atomic.Bool

	// cursorStreamEnabled gates cursor polling + datachannel sends.
	// Disabled by default; viewer can toggle via control message.
	cursorStreamEnabled atomic.Bool

	// capturerSwapped is set by switch_monitor. The capture loop checks and
	// clears it to re-read s.capturer and reinitialize GPU pipeline state.
	capturerSwapped atomic.Bool
	// oldCapturers holds previous capturers after monitor switches so the
	// capture loop can close them safely after confirming the swap. A slice
	// prevents leaking capturers if multiple switches arrive before the
	// capture loop drains the swap.
	oldCapturers []ScreenCapturer

	// gpuEncodeErrors tracks consecutive GPU encode failures. The GPU path
	// is only permanently disabled after 3+ consecutive errors to allow the
	// MFT to warm up after a monitor switch (first frame often fails).
	gpuEncodeErrors int

	// cursorOffsetX/Y store the active monitor's virtual desktop origin so
	// cursorStreamLoop can convert absolute GetCursorInfo coords to
	// display-relative coords before sending to the viewer.
	cursorOffsetX atomic.Int32
	cursorOffsetY atomic.Int32

	frameIdx uint64

	// sasHandler is set from SessionManager.OnSASRequest during creation.
	sasHandler func() error

	// displayIndex is the monitor index this session was started on.
	displayIndex int

	// Cached encoded H264 frame used as a fallback resend source when secure
	// desktop capture yields temporary no-frame periods.
	lastEncodedMu    sync.RWMutex
	lastEncodedFrame []byte
	// Nanoseconds since epoch of the last successful video sample write.
	lastVideoWriteUnixNano atomic.Int64
}

// SessionManager manages remote desktop sessions
type SessionManager struct {
	sessions map[string]*Session
	mu       sync.RWMutex

	// OnSASRequest is called when a viewer requests Ctrl+Alt+Del. In service
	// mode the helper sets this to route the request via IPC to the SCM service
	// which can call SendSAS(FALSE). In direct mode it defaults to InvokeSAS().
	OnSASRequest func() error
}

// NewSessionManager creates a new session manager
func NewSessionManager() *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
	}
}

// ICEServerConfig represents an ICE server from the API payload.
type ICEServerConfig struct {
	// URLs can be a string or []string in the API payload, so we use interface{}
	// and handle both cases in parseICEServers.
	URLs       interface{} `json:"urls"`
	Username   string      `json:"username,omitempty"`
	Credential string      `json:"credential,omitempty"`
}

// parseICEServers converts API ICE server configs into pion ICEServer structs.
func parseICEServers(raw []ICEServerConfig) []webrtc.ICEServer {
	if len(raw) == 0 {
		return []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}
	}

	servers := make([]webrtc.ICEServer, 0, len(raw))
	for _, s := range raw {
		var urls []string
		switch v := s.URLs.(type) {
		case string:
			urls = []string{v}
		case []string:
			urls = append(urls, v...)
		case []interface{}:
			for _, u := range v {
				if str, ok := u.(string); ok {
					urls = append(urls, str)
				}
			}
		}
		if len(urls) == 0 {
			continue
		}
		server := webrtc.ICEServer{URLs: urls}
		if s.Username != "" {
			server.Username = s.Username
			server.Credential = s.Credential
			server.CredentialType = webrtc.ICECredentialTypePassword
		}
		servers = append(servers, server)
	}
	if len(servers) == 0 {
		return []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}
	}
	return servers
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

// StopAllSessions tears down all active desktop sessions.
func (m *SessionManager) StopAllSessions() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()

	for _, s := range sessions {
		s.Stop()
	}
}

// Stop stops the session
func (s *Session) Stop() {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		if !s.isActive {
			s.mu.Unlock()
			return
		}
		s.isActive = false
		s.mu.Unlock()

		close(s.done)

		// Close peer connection early to unblock any RTCP reads.
		if s.peerConn != nil {
			_ = s.peerConn.Close()
		}

		// Wait for loops we started to exit before tearing down encoder/capturer.
		s.wg.Wait()

		s.doCleanup()

		snap := s.metrics.Snapshot()
		slog.Info("Desktop WebRTC session stopped",
			"session", s.id,
			"totalCaptured", snap.FramesCaptured,
			"totalSent", snap.FramesSent,
			"totalSkipped", snap.FramesSkipped,
			"uptime", snap.Uptime.Round(time.Second),
		)
	})
}

func (s *Session) doCleanup() {
	s.cleanupOnce.Do(func() {
		if s.audioCapturer != nil {
			s.audioCapturer.Stop()
		}
		if s.clipboardSync != nil {
			s.clipboardSync.Stop()
		}
		if s.fileDropHandler != nil {
			s.fileDropHandler.Close()
		}
		if s.cursorDC != nil {
			s.cursorDC.Close()
		}
		s.clearCachedEncodedFrame()
		if s.encoder != nil {
			s.encoder.Close()
		}
		for _, oc := range s.oldCapturers {
			oc.Close()
		}
		s.oldCapturers = nil
		if s.capturer != nil {
			s.capturer.Close()
		}
		if s.peerConn != nil {
			s.peerConn.Close()
		}

		if err := GetWallpaperManager().Restore(); err != nil {
			slog.Warn("Failed to restore wallpaper", "session", s.id, "error", err)
		}
	})
}

func (s *Session) getFPS() int {
	s.mu.RLock()
	fps := s.fps
	s.mu.RUnlock()
	if fps <= 0 {
		fps = defaultFrameRate
	}
	return clampInt(fps, 1, maxFrameRate)
}
