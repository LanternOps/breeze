package desktop

import (
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/breeze-rmm/agent/internal/remote/filedrop"
)

// StartSession creates and starts a new remote desktop session.
// iceServers is optional; if nil, falls back to Google STUN.
func (m *SessionManager) StartSession(sessionID string, offer string, iceServers []ICEServerConfig, displayIndex ...int) (answer string, err error) {
	sessionStart := time.Now()
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
	if elapsed := time.Since(sessionStart); elapsed > 500*time.Millisecond {
		slog.Info("StartSession: stop existing sessions took long", "session", sessionID, "elapsed", elapsed)
	}

	// Create WebRTC configuration
	parsedICE := parseICEServers(iceServers)
	for _, s := range parsedICE {
		hasCreds := s.Username != ""
		slog.Info("ICE server configured", "session", sessionID, "urls", s.URLs, "hasCreds", hasCreds)
	}
	config := webrtc.Configuration{
		ICEServers: parsedICE,
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
		slog.Warn("Failed to register playout-delay extension (non-fatal)", "error", regErr.Error())
	}

	// ICE timeout tuning: keep NAT bindings alive and detect failures faster.
	se := webrtc.SettingEngine{}
	se.SetICETimeouts(
		5*time.Second,  // disconnectedTimeout — detect no-media quickly
		15*time.Second, // failedTimeout — reduced from 25s default for faster recovery
		2*time.Second,  // keepAliveInterval — refresh STUN bindings when no media
	)

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithSettingEngine(se),
	)

	// Create peer connection with custom API (playout-delay + ICE tuning)
	peerConn, err := api.NewPeerConnection(config)
	if err != nil {
		return "", fmt.Errorf("failed to create peer connection: %w", err)
	}

	// Create session early so external StopSession calls and peer callbacks can
	// clean up even if we fail before returning an answer.
	session := &Session{
		id:           sessionID,
		peerConn:     peerConn,
		inputHandler: NewInputHandler(m.config.DesktopContext),
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
		firstKF := true
		var lastEnc *VideoEncoder
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
					enc := session.encoder.Load()
					// Reset PLI rate-limit when the encoder pointer changes
					// (e.g. after swapToSoftwareEncoder) so the new encoder
					// gets an immediate keyframe.
					if enc != lastEnc {
						firstKF = true
						lastEnc = enc
					}
					// Allow the first PLI immediately for fast startup,
					// then rate-limit subsequent ones to 500ms apart.
					if !firstKF && time.Since(lastKF) < 500*time.Millisecond {
						continue
					}
					firstKF = false
					lastKF = time.Now()
					if enc != nil {
						_ = enc.ForceKeyframe()
					}
				}
			}
		}
	}()

	// Create screen capturer (optionally targeting a specific display)
	capConfig := m.CaptureConfig()
	if len(displayIndex) > 0 && displayIndex[0] > 0 {
		capConfig.DisplayIndex = displayIndex[0]
	}
	capturerStart := time.Now()
	capturer, err := NewScreenCapturer(capConfig)
	if err != nil {
		return "", fmt.Errorf("failed to create screen capturer: %w", err)
	}
	slog.Info("StartSession: capturer created", "session", sessionID, "elapsed", time.Since(capturerStart))
	session.capturer = capturer
	session.displayIndex = capConfig.DisplayIndex
	session.captureConfig = capConfig
	session.gpuVendor = m.gpuVendor

	// Set display offset so input handler translates viewer-relative coords
	// to virtual screen coords (required for multi-monitor setups).
	displayIdx := 0
	if len(displayIndex) > 0 {
		displayIdx = displayIndex[0]
	}
	applyDisplayOffset(session.inputHandler, displayIdx, &session.cursorOffsetX, &session.cursorOffsetY)

	// Get screen bounds first — needed for bitrate scaling and encoder init.
	// On macOS Retina, GetScreenBounds (NSScreen × scaleFactor) may report
	// pixel dimensions that differ from what the capturer actually produces.
	// A defensive probe capture detects this mismatch and uses the actual
	// capture dimensions for encoder init when they differ.
	w, h, err := capturer.GetScreenBounds()
	if err != nil {
		return "", fmt.Errorf("failed to get screen bounds: %w", err)
	}
	probeStart := time.Now()
	if probeImg, probeErr := capturer.Capture(); probeErr == nil && probeImg != nil {
		pw, ph := probeImg.Rect.Dx(), probeImg.Rect.Dy()
		if pw != w || ph != h {
			slog.Info("Capture probe: actual dimensions differ from GetScreenBounds",
				"session", sessionID,
				"screenBounds", fmt.Sprintf("%dx%d", w, h),
				"actualCapture", fmt.Sprintf("%dx%d", pw, ph))
			w, h = pw, ph
		}
		captureImagePool.Put(probeImg)
	} else if probeErr != nil {
		// If the probe capture fails, the display is inaccessible (e.g. the
		// helper is in a disconnected Windows session with no active display).
		// Abort instead of returning a WebRTC answer that will stream zero frames.
		// The defer at line 80 calls StopSession which closes the capturer.
		return "", fmt.Errorf("screen capture failed (display may be unavailable): %w", probeErr)
	}
	slog.Info("StartSession: probe capture done", "session", sessionID, "elapsed", time.Since(probeStart))

	// Start at 2.5Mbps — matches the viewer's default max-bitrate slider.
	// Adaptive ramps from here. Too low and the MFT encoder can't produce
	// good keyframes; too high and it bursts the jitter buffer.
	initBitrate := 2_500_000

	// Probe the active input desktop BEFORE creating the encoder. On
	// Windows, if we're starting on Winlogon / Screen-saver / UAC, DXGI
	// Desktop Duplication can't capture it and GPU-only encoders (AMF,
	// NVENC) can't process the GDI fallback's CPU pixels. Start directly
	// on a software encoder in that case; when the desktop transitions to
	// Default (user logs in), handleDesktopSwitch swaps us back to
	// hardware. Non-Windows platforms return "" and skip this check.
	preferHardware := true
	if deskName := getCurrentInputDesktopName(); deskName != "" && isSecureDesktop(deskName) {
		slog.Info("StartSession: starting on secure desktop, preferring software encoder",
			"session", sessionID, "desktop", deskName)
		preferHardware = false
	}

	// Create H264 encoder via factory (will use MFT on Windows).
	// Always configure the encoder for maxFrameRate so hardware MFT rate control
	// is correct from first frame. The capture loop throttles if needed.
	encoderStart := time.Now()
	enc, err := NewVideoEncoder(EncoderConfig{
		Codec:          CodecH264,
		Quality:        QualityAuto,
		Bitrate:        initBitrate,
		FPS:            maxFrameRate,
		PreferHardware: preferHardware,
		GPUVendor:      m.gpuVendor,
	})
	if err != nil {
		return "", fmt.Errorf("failed to create H264 encoder: %w", err)
	}
	slog.Info("StartSession: encoder created", "session", sessionID, "backend", enc.BackendName(), "elapsed", time.Since(encoderStart))
	session.encoder.Store(enc)

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

	// Create adaptive bitrate controller — ceiling scales with resolution.
	// Hardware encoders (AMF, NVENC) sustain high bitrate without stalling;
	// CapForSoftwareEncoder() clamps to 4Mbps when the backend is software.
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
			if enc := session.encoder.Load(); enc != nil {
				enc.SetFPS(fps)
			}
		},
	})
	if err == nil {
		session.adaptive = adaptive
		// If the encoder factory fell through to software (e.g. AMF init
		// failed silently), cap the adaptive controller immediately so it
		// doesn't target 4-5Mbps on a software encoder that can't sustain it.
		if !enc.BackendIsHardware() {
			adaptive.CapForSoftwareEncoder()
		}
	}

	// Create clipboard DataChannel
	clipboardDC, err := peerConn.CreateDataChannel("clipboard", nil)
	if err != nil {
		slog.Warn("Failed to create clipboard DataChannel", "session", sessionID, "error", err.Error())
	} else if clipboardDC != nil {
		session.clipboardSync = clipboard.NewClipboardSync(clipboardDC, clipboard.NewSystemClipboard())
		clipboardDC.OnOpen(func() {
			session.clipboardSync.Watch()
		})
	}

	// Create filedrop DataChannel
	filedropDC, err := peerConn.CreateDataChannel("filedrop", nil)
	if err != nil {
		slog.Warn("Failed to create filedrop DataChannel", "session", sessionID, "error", err.Error())
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
		slog.Warn("Failed to create cursor DataChannel", "session", sessionID, "error", err.Error())
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
		slog.Warn("Failed to create audio track", "session", sessionID, "error", err.Error())
	} else {
		if _, addErr := peerConn.AddTrack(audioTrack); addErr != nil {
			slog.Warn("Failed to add audio track", "session", sessionID, "error", addErr.Error())
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

	// Handle connection state changes.
	// On "disconnected", wait a grace period for ICE to recover (NAT rebinding,
	// TURN fallback) before tearing down. This prevents premature session kills
	// on transient network blips.
	// Log ICE connection state transitions at warn level so they ship from
	// the helper process. Helps distinguish ICE-level failures (network /
	// STUN / TURN) from peer-connection-level failures (DTLS / cert).

	// logSelectedPair emits the currently-selected ICE candidate pair so we
	// can tell a Tailscale peer-reflexive path apart from a TURN relay
	// fallback in logs. Safe to call once ICE has reached connected; before
	// then GetSelectedCandidatePair may return nil.
	logSelectedPair := func(context string) {
		sctp := peerConn.SCTP()
		if sctp == nil {
			return
		}
		dtls := sctp.Transport()
		if dtls == nil {
			return
		}
		ice := dtls.ICETransport()
		if ice == nil {
			return
		}
		pair, perr := ice.GetSelectedCandidatePair()
		if perr != nil || pair == nil {
			slog.Info("ICE selected pair", "session", sessionID, "context", context, "pair", "none")
			return
		}
		localType, remoteType := "nil", "nil"
		localAddr, remoteAddr := "", ""
		if pair.Local != nil {
			localType = pair.Local.Typ.String()
			localAddr = fmt.Sprintf("%s:%d", pair.Local.Address, pair.Local.Port)
		}
		if pair.Remote != nil {
			remoteType = pair.Remote.Typ.String()
			remoteAddr = fmt.Sprintf("%s:%d", pair.Remote.Address, pair.Remote.Port)
		}
		slog.Info("ICE selected pair",
			"session", sessionID,
			"context", context,
			"localType", localType,
			"localAddr", localAddr,
			"remoteType", remoteType,
			"remoteAddr", remoteAddr,
		)
	}

	// State transitions are info-level routine diagnostics. Operators who
	// need them flip `desktop_debug: true` in agent.yaml to elevate the
	// shipper's minimum level. Disconnect-timeout and real failures are
	// still emitted at warn below — those always ship.
	peerConn.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		slog.Info("Desktop WebRTC ICE state", "session", sessionID, "state", state.String())
		switch state {
		case webrtc.ICEConnectionStateConnected, webrtc.ICEConnectionStateCompleted:
			logSelectedPair("ice-" + state.String())
		}
	})

	var disconnectTimer *time.Timer
	peerConn.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		// Routine state transition — info level. `desktop_debug: true` in
		// agent.yaml elevates the shipper to surface these. The real
		// session-death event (disconnect grace timeout) and Failed /
		// Closed paths below stay at warn regardless.
		slog.Info("Desktop WebRTC connection state", "session", sessionID, "state", state.String())

		// Cancel any pending disconnect timer when state changes
		if disconnectTimer != nil {
			disconnectTimer.Stop()
			disconnectTimer = nil
		}

		switch state {
		case webrtc.PeerConnectionStateConnected:
			logSelectedPair("connected")
			session.startStreaming()

		case webrtc.PeerConnectionStateDisconnected:
			logSelectedPair("disconnected")
			// 20s grace — dimensioned for Tailscale flaps and short transient
			// path loss. During this window pion's ICE agent retries all
			// gathered candidate pairs (including TURN relay) and can recover
			// without any agent<->viewer signaling. A true ICE restart would
			// require the viewer to re-offer with ICERestart=true (agent is
			// the answerer) — tracked as follow-up.
			disconnectTimer = time.AfterFunc(20*time.Second, func() {
				currentState := peerConn.ConnectionState()
				if currentState != webrtc.PeerConnectionStateConnected {
					slog.Warn("Desktop WebRTC did not recover from disconnected state, stopping",
						"session", sessionID, "finalState", currentState.String())
					logSelectedPair("disconnect-timeout")
					m.StopSession(sessionID)
					if m.OnSessionStopped != nil {
						go m.OnSessionStopped(sessionID)
					}
				}
			})

		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			logSelectedPair("failed-or-closed")
			m.StopSession(sessionID)
			if m.OnSessionStopped != nil {
				go m.OnSessionStopped(sessionID)
			}
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

	// Fast ICE gathering: return as soon as we have usable candidates rather
	// than waiting for full gathering. Host candidates appear in <10ms, STUN
	// reflexive candidates in ~50-200ms. We wait for the first candidate,
	// then collect for a short window before returning.
	gatherComplete := webrtc.GatheringCompletePromise(peerConn)

	// Channel signalled on first candidate
	firstCandidate := make(chan struct{}, 1)
	var candMu sync.Mutex
	candCounts := map[string]int{}
	peerConn.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			// pion signals end-of-gathering with a nil candidate. Summarize
			// what we gathered so we can tell whether TURN was reachable.
			// Relay candidates are the fallback path when host/srflx/prflx
			// become unreachable mid-session (e.g. Tailscale flap); no relay
			// means the session has no backup path.
			candMu.Lock()
			total := 0
			for _, n := range candCounts {
				total += n
			}
			summary := make(map[string]int, len(candCounts))
			for k, v := range candCounts {
				summary[k] = v
			}
			candMu.Unlock()
			if summary["relay"] == 0 {
				slog.Warn("ICE gathering complete with no relay candidates — TURN unreachable or unconfigured, session has no fallback path",
					"session", sessionID, "total", total, "counts", summary)
			} else {
				slog.Info("ICE gathering complete",
					"session", sessionID, "total", total, "counts", summary)
			}
			return
		}
		candMu.Lock()
		candCounts[c.Typ.String()]++
		candMu.Unlock()
		slog.Info("ICE candidate gathered",
			"session", sessionID,
			"type", c.Typ.String(),
			"protocol", c.Protocol.String(),
			"address", c.Address,
			"port", c.Port,
			"relatedAddr", c.RelatedAddress,
		)
		select {
		case firstCandidate <- struct{}{}:
		default:
		}
	})

	hardTimer := time.NewTimer(iceGatherTimeout)
	defer hardTimer.Stop()

	// Phase 1: wait for first candidate (or full completion / hard timeout)
	select {
	case <-gatherComplete:
		// All candidates gathered quickly — return immediately
	case <-firstCandidate:
		// Got first candidate — give a short window to collect more
		// (host + STUN candidates typically all arrive within 500ms)
		collectTimer := time.NewTimer(500 * time.Millisecond)
		select {
		case <-gatherComplete:
			collectTimer.Stop()
		case <-collectTimer.C:
			slog.Info("ICE early-exit: returning answer with partial candidates",
				"session", sessionID,
				"gatheringState", peerConn.ICEGatheringState().String())
		case <-session.done:
			collectTimer.Stop()
			return "", fmt.Errorf("session stopped during ICE gathering")
		}
	case <-hardTimer.C:
		return "", fmt.Errorf("ICE gathering timed out after %s (no candidates)", iceGatherTimeout)
	case <-session.done:
		return "", fmt.Errorf("session stopped during ICE gathering")
	}

	// Streaming starts on PeerConnectionStateConnected to avoid sending the first
	// keyframe while the receiver is still negotiating.

	ld := peerConn.LocalDescription()
	if ld == nil {
		return "", fmt.Errorf("local description not available")
	}
	slog.Info("StartSession: complete", "session", sessionID, "totalElapsed", time.Since(sessionStart))
	return ld.SDP, nil
}

// AddICECandidate adds an ICE candidate to the session
func (s *Session) AddICECandidate(candidate string) error {
	return s.peerConn.AddICECandidate(webrtc.ICECandidateInit{
		Candidate: candidate,
	})
}
