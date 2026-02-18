package desktop

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v3"
	"github.com/pion/webrtc/v3/pkg/media"

	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/breeze-rmm/agent/internal/remote/filedrop"
)

const (
	defaultFrameRate = 30
	maxFrameRate     = 60

	iceGatherTimeout = 20 * time.Second
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

	// capturerSwapped is set by switch_monitor. The capture loop checks and
	// clears it to re-read s.capturer and reinitialize GPU pipeline state.
	capturerSwapped atomic.Bool
	// oldCapturer holds the previous capturer after a monitor switch so the
	// capture loop can close it safely after confirming the swap.
	oldCapturer ScreenCapturer

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

// StartSession creates and starts a new remote desktop session.
// iceServers is optional; if nil, falls back to Google STUN.
func (m *SessionManager) StartSession(sessionID string, offer string, iceServers []ICEServerConfig, displayIndex ...int) (answer string, err error) {
	// Desktop Duplication and GPU pipelines get unstable with multiple concurrent
	// sessions in one process. Enforce single active desktop session per agent.
	var toStop []*Session
	m.mu.Lock()
	for id, s := range m.sessions {
		delete(m.sessions, id)
		if s != nil {
			toStop = append(toStop, s)
		}
	}
	m.mu.Unlock()
	for _, s := range toStop {
		s.Stop()
	}

	// Create WebRTC configuration
	config := webrtc.Configuration{
		ICEServers: parseICEServers(iceServers),
	}

	// Register playout-delay RTP header extension for low-latency screen sharing.
	// This signals to Chrome that frames should be rendered immediately rather than
	// buffered in a jitter buffer designed for video calls.
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return "", fmt.Errorf("failed to register default codecs: %w", err)
	}
	const playoutDelayURI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"
	if regErr := mediaEngine.RegisterHeaderExtension(
		webrtc.RTPHeaderExtensionCapability{URI: playoutDelayURI},
		webrtc.RTPCodecTypeVideo,
	); regErr != nil {
		slog.Warn("Failed to register playout-delay extension (non-fatal)", "error", regErr)
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))

	// Create peer connection with custom API (playout-delay extension)
	peerConn, err := api.NewPeerConnection(config)
	if err != nil {
		return "", fmt.Errorf("failed to create peer connection: %w", err)
	}

	// Create session early so external StopSession calls and peer callbacks can
	// clean up even if we fail before returning an answer.
	session := &Session{
		id:           sessionID,
		peerConn:     peerConn,
		inputHandler: NewInputHandler(),
		done:         make(chan struct{}),
		isActive:     true,
		fps:          defaultFrameRate,
		differ:       newFrameDiffer(),
		cursor:       newCursorOverlay(),
		metrics:      newStreamMetrics(),
	}

	m.mu.Lock()
	m.sessions[sessionID] = session
	m.mu.Unlock()

	defer func() {
		if err != nil {
			m.StopSession(sessionID)
		}
	}()

	// Create H264 video track
	videoTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			ClockRate:   90000,
			// Main profile Level 3.1 — matches MFT encoder's CABAC configuration.
			// VideoToolbox uses Baseline; browser decoders accept both transparently.
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4d001f",
		},
		"video",
		"desktop",
	)
	if err != nil {
		return "", fmt.Errorf("failed to create video track: %w", err)
	}
	session.videoTrack = videoTrack

	// Add video track to peer connection
	sender, err := peerConn.AddTrack(videoTrack)
	if err != nil {
		return "", fmt.Errorf("failed to add video track: %w", err)
	}

	// Drain RTCP so we don't block on backpressure.
	go func() {
		rtcpBuf := make([]byte, 1500)
		var lastKF time.Time
		for {
			n, _, readErr := sender.Read(rtcpBuf)
			if readErr != nil {
				return
			}
			pkts, perr := rtcp.Unmarshal(rtcpBuf[:n])
			if perr != nil {
				continue
			}
			for _, p := range pkts {
				switch p.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					// Rate-limit keyframe forcing.
					if time.Since(lastKF) < 500*time.Millisecond {
						continue
					}
					lastKF = time.Now()
					if session.encoder != nil {
						_ = session.encoder.ForceKeyframe()
					}
				}
			}
		}
	}()

	// Create screen capturer (optionally targeting a specific display)
	capConfig := DefaultConfig()
	if len(displayIndex) > 0 && displayIndex[0] > 0 {
		capConfig.DisplayIndex = displayIndex[0]
	}
	capturer, err := NewScreenCapturer(capConfig)
	if err != nil {
		return "", fmt.Errorf("failed to create screen capturer: %w", err)
	}
	session.capturer = capturer

	// Set display offset so input handler translates viewer-relative coords
	// to virtual screen coords (required for multi-monitor setups).
	displayIdx := 0
	if len(displayIndex) > 0 {
		displayIdx = displayIndex[0]
	}
	applyDisplayOffset(session.inputHandler, displayIdx)

	// Get screen bounds first — needed for bitrate scaling and encoder init
	w, h, err := capturer.GetScreenBounds()
	if err != nil {
		return "", fmt.Errorf("failed to get screen bounds: %w", err)
	}

	// Scale initial bitrate to resolution. 2.5Mbps is fine for 1080p but
	// starves 1440p+ text clarity. Main profile CABAC makes better use of bits.
	initBitrate := 2_500_000
	if w*h > 1920*1080 {
		initBitrate = 8_000_000
	}

	// Create H264 encoder via factory (will use MFT on Windows).
	// Always configure the encoder for maxFrameRate so hardware MFT rate control
	// is correct from first frame. The capture loop throttles if needed.
	enc, err := NewVideoEncoder(EncoderConfig{
		Codec:          CodecH264,
		Quality:        QualityAuto,
		Bitrate:        initBitrate,
		FPS:            maxFrameRate,
		PreferHardware: true,
	})
	if err != nil {
		return "", fmt.Errorf("failed to create H264 encoder: %w", err)
	}
	session.encoder = enc

	if enc.BackendIsPlaceholder() {
		return "", fmt.Errorf("no H264 encoder available (backend=%s)", enc.BackendName())
	}

	if err := enc.SetDimensions(w, h); err != nil {
		return "", fmt.Errorf("failed to set encoder dimensions: %w", err)
	}

	// If the capturer produces BGRA, tell the encoder to skip BGRA→RGBA conversion
	session.encoderPF = PixelFormatRGBA
	if bgraCap, ok := capturer.(BGRAProvider); ok && bgraCap.IsBGRA() {
		enc.SetPixelFormat(PixelFormatBGRA)
		session.encoderPF = PixelFormatBGRA
		slog.Info("Capturer provides BGRA, encoder set to BGRA→NV12 direct path",
			"session", sessionID)
	}

	// Pass D3D11 device to encoder for GPU zero-copy pipeline setup
	if tp, ok := capturer.(TextureProvider); ok {
		enc.SetD3D11Device(tp.GetD3D11Device(), tp.GetD3D11Context())
		slog.Info("D3D11 device passed to encoder for GPU pipeline",
			"session", sessionID)
	}

	// Only cap capture loop FPS for true placeholder backends at high res.
	// Real backends (MFT, VideoToolbox) handle 60fps fine — the capture loop
	// will uncap once hardware is confirmed on first encode.
	if enc.BackendIsPlaceholder() && w*h > 1920*1080 {
		session.fps = 15
		slog.Info("Capped FPS for placeholder encoder at high resolution",
			"session", sessionID, "fps", 15, "resolution", fmt.Sprintf("%dx%d", w, h))
	} else {
		session.fps = maxFrameRate
	}

	// Create adaptive bitrate controller — ceiling scales with resolution
	maxAdaptiveBitrate := 8_000_000
	if w*h > 1920*1080 {
		maxAdaptiveBitrate = 15_000_000
	}
	adaptive, err := NewAdaptiveBitrate(AdaptiveConfig{
		Encoder:        enc,
		InitialBitrate: initBitrate,
		MinBitrate:     500_000,
		MaxBitrate:     maxAdaptiveBitrate,
		MinQuality:     QualityLow,
		MaxQuality:     QualityUltra,
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

	// Create cursor DataChannel — streams remote cursor position to viewer for
	// instant cursor rendering independent of video frame rate.
	// Unordered + unreliable: latest-wins semantics, no head-of-line blocking.
	ordered := false
	maxRetransmits := uint16(0)
	cursorDC, err := peerConn.CreateDataChannel("cursor", &webrtc.DataChannelInit{
		Ordered:        &ordered,
		MaxRetransmits: &maxRetransmits,
	})
	if err != nil {
		slog.Warn("Failed to create cursor DataChannel", "session", sessionID, "error", err)
	} else {
		session.cursorDC = cursorDC
	}

	// Create PCMU audio track for system audio forwarding (loopback capture).
	// The viewer can mute/unmute; the track is always present in the SDP.
	audioTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypePCMU,
			ClockRate: 8000,
			Channels:  1,
		},
		"audio",
		"desktop-audio",
	)
	if err != nil {
		slog.Warn("Failed to create audio track", "session", sessionID, "error", err)
	} else {
		if _, addErr := peerConn.AddTrack(audioTrack); addErr != nil {
			slog.Warn("Failed to add audio track", "session", sessionID, "error", addErr)
		} else {
			session.audioTrack = audioTrack
		}
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
			session.mu.Lock()
			session.controlDC = dc
			session.mu.Unlock()
			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				session.handleControlMessage(msg.Data)
			})
		}
	})

	// Handle connection state changes
	peerConn.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		slog.Info("Desktop WebRTC connection state", "session", sessionID, "state", state.String())
		if state == webrtc.PeerConnectionStateConnected {
			session.startStreaming()
		}
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			m.StopSession(sessionID)
		}
	})

	// Set remote description (offer from viewer)
	if err := peerConn.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer,
		SDP:  offer,
	}); err != nil {
		session.doCleanup()
		return "", fmt.Errorf("failed to set remote description: %w", err)
	}

	// Create answer
	pcAnswer, err := peerConn.CreateAnswer(nil)
	if err != nil {
		session.doCleanup()
		return "", fmt.Errorf("failed to create answer: %w", err)
	}

	// Set local description
	if err := peerConn.SetLocalDescription(pcAnswer); err != nil {
		return "", fmt.Errorf("failed to set local description: %w", err)
	}

	// Wait for ICE gathering to complete
	gatherComplete := webrtc.GatheringCompletePromise(peerConn)
	timer := time.NewTimer(iceGatherTimeout)
	defer timer.Stop()
	select {
	case <-gatherComplete:
	case <-timer.C:
		return "", fmt.Errorf("ICE gathering timed out after %s", iceGatherTimeout)
	case <-session.done:
		return "", fmt.Errorf("session stopped during ICE gathering")
	}

	// Streaming starts on PeerConnectionStateConnected to avoid sending the first
	// keyframe while the receiver is still negotiating.

	ld := peerConn.LocalDescription()
	if ld == nil {
		return "", fmt.Errorf("local description not available")
	}
	return ld.SDP, nil
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

func (s *Session) startStreaming() {
	s.startOnce.Do(func() {
		s.mu.RLock()
		active := s.isActive
		s.mu.RUnlock()
		if !active {
			return
		}

		if err := GetWallpaperManager().Suppress(); err != nil {
			slog.Warn("Failed to suppress wallpaper", "session", s.id, "error", err)
		}

		// Best-effort: request an IDR immediately for fast viewer startup.
		if s.encoder != nil {
			_ = s.encoder.ForceKeyframe()
		}

		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.captureLoop()
		}()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.metricsLogger()
		}()
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.adaptiveLoop()
		}()
		if s.cursorDC != nil {
			if cp, ok := s.capturer.(CursorProvider); ok {
				s.wg.Add(1)
				go func() {
					defer s.wg.Done()
					s.cursorStreamLoop(cp)
				}()
			}
		}

		// Initialize audio capture (WASAPI loopback on Windows).
		// Audio is muted by default — the viewer sends toggle_audio to unmute.
		if s.audioTrack != nil {
			ac := NewAudioCapturer()
			if ac != nil {
				s.audioCapturer = ac
				audioTrack := s.audioTrack
				err := ac.Start(func(frame []byte) {
					if !s.audioEnabled.Load() {
						return // muted — skip sending to save bandwidth
					}
					_ = audioTrack.WriteSample(media.Sample{
						Data:     frame,
						Duration: 20 * time.Millisecond,
					})
				})
				if err != nil {
					slog.Warn("Failed to start audio capture", "session", s.id, "error", err)
					ac.Stop() // release partially-initialized COM resources
					s.audioCapturer = nil
				} else {
					slog.Info("Audio capture started (WASAPI loopback)", "session", s.id)
				}
			}
		}

		w, h, _ := s.capturer.GetScreenBounds()
		slog.Info("Desktop WebRTC session started",
			"session", s.id,
			"width", w,
			"height", h,
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
		if s.encoder != nil {
			s.encoder.Close()
		}
		if s.oldCapturer != nil {
			s.oldCapturer.Close()
		}
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

// captureLoop continuously captures and sends encoded H264 frames.
// For DXGI capturers, runs a tight loop — AcquireNextFrame already blocks
// waiting for new frames, so a ticker would only add latency.
// For non-DXGI capturers, uses a ticker to pace frames.
func (s *Session) captureLoop() {
	if h, ok := s.capturer.(TightLoopHint); ok && h.TightLoop() {
		s.captureLoopDXGI()
	} else {
		s.captureLoopTicker()
	}
}

// captureLoopDXGI runs a tight loop driven by DXGI's AcquireNextFrame blocking.
// No ticker — capture calls block until a new frame is available or timeout.
func (s *Session) captureLoopDXGI() {
	fps := s.getFPS()
	frameDuration := time.Second / time.Duration(fps)
	hwChecked := false
	tp, hasTP := s.capturer.(TextureProvider)
	gpuDisabled := false

	// Dynamic FPS scaling: track consecutive "no new frame" iterations.
	// After idleThreshold consecutive skips (~3s of static screen), enter idle
	// mode with longer sleep to save CPU/GPU. Reset on first new frame or input.
	const idleThreshold = 180   // ~3s at 60fps
	const idleSleep = 16 * time.Millisecond // one frame at 60fps — responsive wake-up
	consecutiveSkips := 0
	wasIdle := false

	for {
		loopStart := time.Now()
		select {
		case <-s.done:
			return
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
			// Close the old capturer now that we're safely outside captureAndSendFrameGPU.
			s.mu.RLock()
			oldCap := s.oldCapturer
			newCap := s.capturer
			s.mu.RUnlock()
			if oldCap != nil {
				oldCap.Close()
				s.mu.Lock()
				s.oldCapturer = nil
				s.mu.Unlock()
			}
			tp, hasTP = newCap.(TextureProvider)
			gpuDisabled = false
			hwChecked = false
			consecutiveSkips = 0
			wasIdle = false
			// Pass new D3D11 device to encoder
			if hasTP && s.encoder != nil {
				s.encoder.SetD3D11Device(tp.GetD3D11Device(), tp.GetD3D11Context())
			}
			// Update encoder dimensions for the new monitor
			if w, h, err := newCap.GetScreenBounds(); err == nil && s.encoder != nil {
				_ = s.encoder.SetDimensions(w, h)
				_ = s.encoder.ForceKeyframe()
			}
		}

		// If the capturer falls back to a non-blocking mode (e.g. DXGI→GDI),
		// switch to the ticker loop to avoid spinning.
		if h, ok := s.capturer.(TightLoopHint); ok && !h.TightLoop() {
			slog.Info("Capturer no longer supports tight loop, switching to ticker loop", "session", s.id)
			s.captureLoopTicker()
			return
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

		newFPS := s.getFPS()
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
			}
			if handled {
				frameSent = sent
				sleepDur := frameDuration
				if !frameSent {
					consecutiveSkips++
					if consecutiveSkips >= idleThreshold {
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

// cursorStreamLoop runs an independent 120Hz loop that polls cursor position
// and sends updates over the cursor data channel. Decoupled from the capture
// loop so cursor movement stays smooth even when DXGI blocks on AcquireNextFrame.
func (s *Session) cursorStreamLoop(prov CursorProvider) {
	ticker := time.NewTicker(time.Second / 120)
	defer ticker.Stop()

	var lastX, lastY int32
	var lastV bool

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			if s.cursorDC.ReadyState() != webrtc.DataChannelStateOpen {
				continue
			}
			cx, cy, cv := prov.CursorPosition()
			if cx == lastX && cy == lastY && cv == lastV {
				continue
			}
			lastX, lastY, lastV = cx, cy, cv
			v := 0
			if cv {
				v = 1
			}
			_ = s.cursorDC.SendText(fmt.Sprintf(`{"x":%d,"y":%d,"v":%d}`, cx, cy, v))
		}
	}
}

// captureLoopTicker uses a ticker for non-DXGI capturers (GDI, macOS, Linux).
func (s *Session) captureLoopTicker() {
	fps := s.getFPS()
	frameDuration := time.Second / time.Duration(fps)
	ticker := time.NewTicker(frameDuration)
	defer ticker.Stop()

	hwChecked := false

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
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
					ticker.Reset(frameDuration)
					slog.Info("Uncapped FPS for hardware encoder",
						"session", s.id, "fps", fps)
				}
			}

			newFPS := s.getFPS()
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
	s.mu.RUnlock()

	// 1. Capture screen
	t0 := time.Now()
	img, err := s.capturer.Capture()
	if err != nil {
		slog.Debug("Screen capture error", "session", s.id, "error", err)
		return
	}
	if img == nil {
		// DXGI: no new frame available (AccumulatedFrames==0)
		s.metrics.RecordSkip()
		return
	}
	s.metrics.RecordCapture(time.Since(t0))

	// Keep the encoder's expected byte order in sync with the capturer.
	desiredPF := PixelFormatRGBA
	if bgraCap, ok := s.capturer.(BGRAProvider); ok && bgraCap.IsBGRA() {
		desiredPF = PixelFormatBGRA
	}
	if desiredPF != s.encoderPF {
		s.encoder.SetPixelFormat(desiredPF)
		s.encoderPF = desiredPF
	}

	// DXGI capturers already skip unchanged frames (Capture() returns nil,nil).
	dxgiActive := false
	if h, ok := s.capturer.(TightLoopHint); ok && h.TightLoop() {
		dxgiActive = true
	}

	// 2. Frame differencing — skip if unchanged.
	// DXGI capturers already filter via AccumulatedFrames in Capture(),
	// so we only need CRC32 for non-DXGI capturers.
	if !dxgiActive {
		if !s.differ.HasChanged(img.Pix) {
			captureImagePool.Put(img)
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
		slog.Warn("GPU capture error", "session", s.id, "error", err)
		return false, true, false
	}
	if texture == 0 {
		s.metrics.RecordSkip()
		return true, false, false
	}
	defer tp.ReleaseTexture()
	s.metrics.RecordCapture(time.Since(t0))

	t1 := time.Now()
	h264Data, err := s.encoder.EncodeTexture(texture)
	encodeTime := time.Since(t1)

	if err != nil {
		slog.Warn("GPU encode error", "session", s.id, "error", err)
		return true, true, false
	}
	if h264Data == nil {
		return true, false, false
	}

	s.metrics.RecordEncode(encodeTime, len(h264Data))

	sample := media.Sample{
		Data:     h264Data,
		Duration: frameDuration,
	}
	if err := s.videoTrack.WriteSample(sample); err != nil {
		slog.Warn("Failed to write H264 sample", "session", s.id, "error", err)
		s.metrics.RecordDrop()
		return true, false, false
	}

	s.metrics.RecordSend(len(h264Data))
	return true, false, true
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

	// Signal the capture loop that the user is active so it exits idle mode
	// and polls at full speed. This covers mouse_move, key_down, scroll, etc.
	s.inputActive.Store(true)

	// On mouse down, signal the capture loop to flush the encoder pipeline so
	// stale buffered frames are dropped and the click result appears immediately.
	if event.Type == "mouse_down" {
		s.clickFlush.Store(true)
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
		slog.Warn("Failed to parse control message", "session", s.id, "error", err)
		return
	}

	const maxBitrateCap = 20_000_000 // 20 Mbps hard cap
	switch msg.Type {
	case "set_bitrate":
		if msg.Value > 0 && msg.Value <= maxBitrateCap {
			// Update the adaptive controller's ceiling so it ramps up to
			// the user-chosen max rather than bypassing adaptive entirely.
			if s.adaptive != nil {
				s.adaptive.SetMaxBitrate(msg.Value)
			} else {
				if err := s.encoder.SetBitrate(msg.Value); err != nil {
					slog.Warn("Failed to set bitrate", "session", s.id, "bitrate", msg.Value, "error", err)
				}
			}
		}
	case "set_fps":
		if msg.Value > 0 && msg.Value <= maxFrameRate {
			s.mu.Lock()
			s.fps = msg.Value
			s.mu.Unlock()
			if err := s.encoder.SetFPS(msg.Value); err != nil {
				slog.Warn("Failed to set fps", "session", s.id, "fps", msg.Value, "error", err)
			}
		}
	case "request_keyframe":
		// Viewer window regained focus — force IDR so picture is immediately sharp.
		if s.encoder != nil {
			_ = s.encoder.ForceKeyframe()
		}
	case "list_monitors":
		monitors, err := ListMonitors()
		if err != nil {
			slog.Warn("Failed to list monitors", "session", s.id, "error", err)
			return
		}
		resp, _ := json.Marshal(map[string]any{
			"type":     "monitors",
			"monitors": monitors,
		})
		s.mu.RLock()
		dc := s.controlDC
		s.mu.RUnlock()
		if dc != nil {
			dc.SendText(string(resp))
		}
	case "toggle_audio":
		enabled := msg.Value != 0
		s.audioEnabled.Store(enabled)
		slog.Info("Audio toggled", "session", s.id, "enabled", enabled)
	case "switch_monitor":
		if msg.Value < 0 {
			return
		}
		slog.Info("Switching monitor", "session", s.id, "display", msg.Value)
		cfg := DefaultConfig()
		cfg.DisplayIndex = msg.Value
		newCap, capErr := NewScreenCapturer(cfg)
		if capErr != nil {
			slog.Warn("Failed to create capturer for monitor", "display", msg.Value, "error", capErr)
			return
		}
		// Swap capturer and signal the capture loop to reinitialize.
		// The old capturer is NOT closed here — the capture loop closes it
		// after detecting the swap, avoiding a race where Close() is called
		// while captureAndSendFrameGPU is mid-frame on the old capturer.
		s.mu.Lock()
		s.oldCapturer = s.capturer
		s.capturer = newCap
		s.mu.Unlock()
		s.capturerSwapped.Store(true)
		applyDisplayOffset(s.inputHandler, msg.Value)
		// Get bounds for viewer notification — encoder dimensions are updated
		// by the capture loop when it detects capturerSwapped, avoiding a race
		// with the encoding goroutine.
		w, h, boundsErr := newCap.GetScreenBounds()
		if boundsErr != nil {
			slog.Warn("Failed to get bounds for new monitor", "display", msg.Value, "error", boundsErr)
		}
		// Notify viewer of new resolution
		resp, _ := json.Marshal(map[string]any{
			"type":   "monitor_switched",
			"index":  msg.Value,
			"width":  w,
			"height": h,
		})
		s.mu.RLock()
		dc := s.controlDC
		s.mu.RUnlock()
		if dc != nil {
			dc.SendText(string(resp))
		}
	}
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

func (s *Session) adaptiveLoop() {
	if s.adaptive == nil || s.peerConn == nil {
		return
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			rtt, loss, ok := extractRemoteInboundVideoStats(s.peerConn.GetStats())
			if !ok {
				continue
			}
			s.adaptive.Update(rtt, loss)
		}
	}
}

func extractRemoteInboundVideoStats(report webrtc.StatsReport) (rtt time.Duration, loss float64, ok bool) {
	var bestPackets uint32
	for _, s := range report {
		ri, okRI := s.(webrtc.RemoteInboundRTPStreamStats)
		if !okRI || ri.Kind != "video" {
			continue
		}

		// Pick the stream with the most received packets as the primary one.
		if !ok || ri.PacketsReceived >= bestPackets {
			bestPackets = ri.PacketsReceived
			rtt = time.Duration(ri.RoundTripTime * float64(time.Second))
			loss = ri.FractionLost
			ok = true
		}
	}
	return rtt, loss, ok
}

// AddICECandidate adds an ICE candidate to the session
func (s *Session) AddICECandidate(candidate string) error {
	return s.peerConn.AddICECandidate(webrtc.ICECandidateInit{
		Candidate: candidate,
	})
}

// applyDisplayOffset queries the monitor list and sets the input handler's
// coordinate offset so viewer-relative (0,0) maps to the captured monitor's
// top-left corner in virtual screen space.
func applyDisplayOffset(handler InputHandler, displayIndex int) {
	monitors, err := ListMonitors()
	if err != nil {
		handler.SetDisplayOffset(0, 0)
		return
	}
	for _, m := range monitors {
		if m.Index == displayIndex {
			handler.SetDisplayOffset(m.X, m.Y)
			return
		}
	}
	handler.SetDisplayOffset(0, 0)
}
