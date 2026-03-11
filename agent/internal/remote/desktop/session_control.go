package desktop

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"
)

// verifySecureDesktopTransition checks whether the session moved to a secure
// desktop shortly after a SAS request. This is a best-effort verification
// signal for diagnostics; SendSAS itself is a void API and cannot confirm
// effect directly.
func (s *Session) verifySecureDesktopTransition(timeout time.Duration) (supported bool, transitioned bool) {
	deadline := time.Now().Add(timeout)
	for {
		s.mu.RLock()
		cap := s.capturer
		s.mu.RUnlock()

		dsn, ok := cap.(DesktopSwitchNotifier)
		if !ok {
			return false, false
		}
		if dsn.OnSecureDesktop() {
			return true, true
		}
		if time.Now().After(deadline) {
			return true, false
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// handleInputMessage processes input events from the data channel
func (s *Session) handleInputMessage(data []byte) {
	var event InputEvent
	if err := json.Unmarshal(data, &event); err != nil {
		slog.Warn("Failed to parse input event", "session", s.id, "error", err.Error())
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
		slog.Warn("Failed to handle input event", "session", s.id, "error", err.Error())
	}
}

// handleControlMessage processes control messages (bitrate, quality changes)
func (s *Session) handleControlMessage(data []byte) {
	var msg struct {
		Type  string `json:"type"`
		Value int    `json:"value"`
	}
	if err := json.Unmarshal(data, &msg); err != nil {
		slog.Warn("Failed to parse control message", "session", s.id, "error", err.Error())
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
					slog.Warn("Failed to set bitrate", "session", s.id, "bitrate", msg.Value, "error", err.Error())
				}
			}
		}
	case "set_fps":
		if msg.Value > 0 && msg.Value <= maxFrameRate {
			if s.adaptive != nil {
				s.adaptive.SetMaxFPS(msg.Value)
			}
			s.mu.Lock()
			s.fps = msg.Value
			s.mu.Unlock()
			if err := s.encoder.SetFPS(msg.Value); err != nil {
				slog.Warn("Failed to set fps", "session", s.id, "fps", msg.Value, "error", err.Error())
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
			slog.Warn("Failed to list monitors", "session", s.id, "error", err.Error())
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
	case "set_cursor_stream":
		enabled := msg.Value != 0
		s.cursorStreamEnabled.Store(enabled)
		if !enabled {
			s.mu.RLock()
			cdc := s.cursorDC
			s.mu.RUnlock()
			if cdc != nil {
				if err := cdc.SendText(`{"v":0}`); err != nil {
					slog.Debug("Failed to send cursor hide message", "session", s.id, "error", err.Error())
				}
			}
		}
		slog.Debug("Cursor stream toggled", "session", s.id, "enabled", enabled)
	case "send_sas":
		slog.Info("SAS requested via control channel", "session", s.id)
		// Try service IPC first (Session 0 context), fall back to direct call.
		var sasErr error
		verificationSupported := false
		verified := false
		if s.sasHandler != nil {
			sasErr = s.sasHandler()
			if sasErr != nil {
				slog.Warn("SAS via service IPC failed, trying direct InvokeSAS", "session", s.id, "error", sasErr.Error())
				sasErr = InvokeSAS()
			}
		} else {
			sasErr = InvokeSAS()
		}
		if sasErr == nil {
			verificationSupported, verified = s.verifySecureDesktopTransition(1200 * time.Millisecond)
			if verificationSupported && !verified {
				slog.Warn("SAS call succeeded but secure desktop transition not observed", "session", s.id)
			}
		}
		ok := sasErr == nil
		if sasErr != nil {
			slog.Warn("SendSAS failed (all paths)", "session", s.id, "error", sasErr.Error())
		}
		respBody := map[string]any{
			"type":                  "sas_result",
			"ok":                    ok,
			"verificationSupported": verificationSupported,
			"verified":              verified,
		}
		if sasErr != nil {
			respBody["error"] = sasErr.Error()
		} else if verificationSupported && !verified {
			respBody["warning"] = "SAS request sent but secure-desktop transition not observed"
		}
		resp, _ := json.Marshal(respBody)
		s.mu.RLock()
		dc := s.controlDC
		s.mu.RUnlock()
		if dc != nil {
			dc.SendText(string(resp))
		}
	case "lock_workstation":
		slog.Info("Lock workstation requested via control channel", "session", s.id)
		lockErr := LockWorkstation()
		lockOk := lockErr == nil
		if lockErr != nil {
			slog.Warn("LockWorkstation failed", "session", s.id, "error", lockErr.Error())
		}
		lockBody := map[string]any{
			"type": "lock_result",
			"ok":   lockOk,
		}
		if lockErr != nil {
			lockBody["error"] = lockErr.Error()
		}
		lockResp, _ := json.Marshal(lockBody)
		s.mu.RLock()
		ldc := s.controlDC
		s.mu.RUnlock()
		if ldc != nil {
			ldc.SendText(string(lockResp))
		}
	case "viewer_stats":
		// Viewer-reported WebRTC stats — log and feed into adaptive bitrate as
		// a fallback when pion's RTCP RemoteInboundRTPStreamStats are unavailable.
		var vs struct {
			Type                 string `json:"type"`
			RTTMs                int    `json:"rttMs"`
			JitterMs             int    `json:"jitterMs"`
			PacketsLost          int    `json:"packetsLost"`
			PacketsLostDelta     int    `json:"packetsLostDelta"`
			PacketsReceived      int    `json:"packetsReceived"`
			PacketsReceivedDelta int    `json:"packetsReceivedDelta"`
			FramesReceived       int    `json:"framesReceived"`
			FramesDecoded        int    `json:"framesDecoded"`
			FramesDropped        int    `json:"framesDropped"`
			FramesDroppedDelta   int    `json:"framesDroppedDelta"`
			Kbps                 int    `json:"kbps"`
			ICELocal             string `json:"iceLocal"`
			ICERemote            string `json:"iceRemote"`
		}
		if err := json.Unmarshal(data, &vs); err == nil {
			// Compute loss fraction from viewer-reported deltas.
			var lossFraction float64
			totalDelta := vs.PacketsLostDelta + vs.PacketsReceivedDelta
			if totalDelta > 0 && vs.PacketsLostDelta > 0 {
				lossFraction = float64(vs.PacketsLostDelta) / float64(totalDelta)
			}

			// Frame drops signal jitter-buffer overload even when packet loss is
			// zero. Treat dropped frames as a loss signal for the adaptive controller.
			// Use framesDroppedDelta relative to total frame activity in this interval.
			// Combine packet loss and frame drops into a single congestion signal
			// using probability union P(A∪B) = P(A)+P(B)-P(A)·P(B).
			// Jitter is NOT used as a signal — it's a lagging indicator that
			// doesn't respond to bitrate reduction, causing death spirals.
			var effectiveLoss float64 = lossFraction
			if vs.FramesDroppedDelta > 0 {
				frameLoss := float64(vs.FramesDroppedDelta) / float64(vs.FramesDroppedDelta+vs.FramesDecoded)
				if vs.FramesDecoded == 0 {
					frameLoss = 0.5 // significant but not max
				}
				effectiveLoss = effectiveLoss + frameLoss - effectiveLoss*frameLoss
			}

			slog.Info("Viewer WebRTC stats",
				"session", s.id,
				"rttMs", vs.RTTMs,
				"jitterMs", vs.JitterMs,
				"pktLost", vs.PacketsLost,
				"pktLostDelta", vs.PacketsLostDelta,
				"pktRcvdDelta", vs.PacketsReceivedDelta,
				"lossFraction", fmt.Sprintf("%.3f", lossFraction),
				"effectiveLoss", fmt.Sprintf("%.3f", effectiveLoss),
				"framesRcvd", vs.FramesReceived,
				"framesDecoded", vs.FramesDecoded,
				"framesDropped", vs.FramesDropped,
				"framesDroppedDelta", vs.FramesDroppedDelta,
				"kbps", vs.Kbps,
				"iceLocal", vs.ICELocal,
				"iceRemote", vs.ICERemote,
			)

			// Feed viewer stats into the adaptive bitrate controller.
			if s.adaptive != nil {
				rtt := time.Duration(vs.RTTMs) * time.Millisecond
				s.adaptive.Update(rtt, effectiveLoss)
			}
		}
	case "switch_monitor":
		if msg.Value < 0 {
			return
		}
		slog.Info("Switching monitor", "session", s.id, "display", msg.Value)
		cfg := DefaultConfig()
		cfg.DisplayIndex = msg.Value
		newCap, capErr := NewScreenCapturer(cfg)
		if capErr != nil {
			slog.Warn("Failed to create capturer for monitor", "display", msg.Value, "error", capErr.Error())
			return
		}
		// Force a desktop repaint so DXGI has dirty rects for the initial
		// AcquireNextFrame on the new display. Without this, a completely
		// static display (no cursor, no animations) produces zero frames.
		forceDesktopRepaint()
		// Swap capturer and signal the capture loop to reinitialize.
		// The old capturer is NOT closed here — the capture loop closes it
		// after detecting the swap, avoiding a race where Close() is called
		// while captureAndSendFrameGPU is mid-frame on the old capturer.
		s.mu.Lock()
		s.oldCapturers = append(s.oldCapturers, s.capturer)
		s.capturer = newCap
		s.displayIndex = msg.Value
		s.mu.Unlock()
		s.capturerSwapped.Store(true)
		applyDisplayOffset(s.inputHandler, msg.Value, &s.cursorOffsetX, &s.cursorOffsetY)
		// Get bounds for viewer notification — encoder dimensions are updated
		// by the capture loop when it detects capturerSwapped, avoiding a race
		// with the encoding goroutine.
		w, h, boundsErr := newCap.GetScreenBounds()
		if boundsErr != nil {
			slog.Warn("Failed to get bounds for new monitor", "display", msg.Value, "error", boundsErr.Error())
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
