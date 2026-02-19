package desktop

import (
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/pion/webrtc/v3"
	"github.com/pion/webrtc/v3/pkg/media"
)

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

// cursorStreamLoop runs an independent 120Hz loop that polls cursor position
// and sends updates over the cursor data channel. Decoupled from the capture
// loop so cursor movement stays smooth even when DXGI blocks on AcquireNextFrame.
func (s *Session) cursorStreamLoop(prov CursorProvider) {
	const (
		cursorActiveInterval = time.Second / 120
		cursorIdleInterval   = 250 * time.Millisecond
	)

	enabled := s.cursorStreamEnabled.Load()
	interval := cursorIdleInterval
	if enabled {
		interval = cursorActiveInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	var lastRelX, lastRelY int32
	var lastV bool
	haveLast := false

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			nowEnabled := s.cursorStreamEnabled.Load()
			if nowEnabled != enabled {
				enabled = nowEnabled
				if enabled {
					ticker.Reset(cursorActiveInterval)
				} else {
					ticker.Reset(cursorIdleInterval)
				}
			}
			if !enabled {
				continue
			}
			if s.cursorDC.ReadyState() != webrtc.DataChannelStateOpen {
				continue
			}
			cx, cy, cv := prov.CursorPosition()
			// Convert absolute virtual desktop coords to display-relative
			// so viewer can map directly using videoWidth/videoHeight.
			relX := cx - s.cursorOffsetX.Load()
			relY := cy - s.cursorOffsetY.Load()
			if haveLast && relX == lastRelX && relY == lastRelY && cv == lastV {
				continue
			}
			lastRelX, lastRelY, lastV = relX, relY, cv
			haveLast = true
			v := 0
			if cv {
				v = 1
			}
			payload := make([]byte, 0, 40)
			payload = append(payload, `{"x":`...)
			payload = strconv.AppendInt(payload, int64(relX), 10)
			payload = append(payload, `,"y":`...)
			payload = strconv.AppendInt(payload, int64(relY), 10)
			payload = append(payload, `,"v":`...)
			payload = strconv.AppendInt(payload, int64(v), 10)
			payload = append(payload, '}')
			if err := s.cursorDC.Send(payload); err != nil {
				slog.Debug("Failed to send cursor update", "session", s.id, "error", err)
			}
		}
	}
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

func (s *Session) adaptiveLoop() {
	if s.adaptive == nil || s.peerConn == nil {
		return
	}

	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()

	var logCount int
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
			// Log RTCP stats periodically for bitrate diagnostics
			logCount++
			if logCount%5 == 1 { // every 10s (5 × 2s ticks)
				slog.Info("WebRTC RTCP stats",
					"session", s.id,
					"rtt", rtt.Round(time.Millisecond),
					"fractionLost", fmt.Sprintf("%.4f", loss),
				)
			}
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

// describeH264NALUs parses Annex B start codes and returns a summary of NALU types.
// Used for diagnostics after monitor switch to verify SPS/PPS presence.
func describeH264NALUs(data []byte) string {
	types := make(map[string]int)
	for i := 0; i < len(data)-4; {
		// Look for start code: 00 00 01 or 00 00 00 01
		startLen := 0
		if data[i] == 0 && data[i+1] == 0 {
			if data[i+2] == 1 {
				startLen = 3
			} else if data[i+2] == 0 && i+3 < len(data) && data[i+3] == 1 {
				startLen = 4
			}
		}
		if startLen == 0 {
			i++
			continue
		}
		naluType := data[i+startLen] & 0x1f
		name := fmt.Sprintf("type%d", naluType)
		switch naluType {
		case 7:
			name = "SPS"
		case 8:
			name = "PPS"
		case 5:
			name = "IDR"
		case 1:
			name = "non-IDR"
		case 6:
			name = "SEI"
		case 9:
			name = "AUD"
		}
		types[name]++
		i += startLen + 1
	}
	parts := make([]string, 0, len(types))
	for t, c := range types {
		parts = append(parts, fmt.Sprintf("%s:%d", t, c))
	}
	return strings.Join(parts, " ")
}
