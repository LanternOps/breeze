package desktop

import (
	"fmt"
	"log/slog"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v3"

	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/breeze-rmm/agent/internal/remote/filedrop"
)

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
		sasHandler:   m.OnSASRequest,
	}
	session.cursorStreamEnabled.Store(false)

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
			MimeType:  webrtc.MimeTypeH264,
			ClockRate: 90000,
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
	session.displayIndex = capConfig.DisplayIndex

	// Set display offset so input handler translates viewer-relative coords
	// to virtual screen coords (required for multi-monitor setups).
	displayIdx := 0
	if len(displayIndex) > 0 {
		displayIdx = displayIndex[0]
	}
	applyDisplayOffset(session.inputHandler, displayIdx, &session.cursorOffsetX, &session.cursorOffsetY)

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
		MaxFPS:         maxFrameRate,
		OnFPSChange: func(fps int) {
			session.mu.Lock()
			session.fps = fps
			session.mu.Unlock()
			session.encoder.SetFPS(fps)
		},
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

// AddICECandidate adds an ICE candidate to the session
func (s *Session) AddICECandidate(candidate string) error {
	return s.peerConn.AddICECandidate(webrtc.ICECandidateInit{
		Candidate: candidate,
	})
}
