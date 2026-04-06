package desktop

import (
	"errors"
	"log/slog"
	"sync"
	"time"
)

type AdaptiveConfig struct {
	Encoder        *VideoEncoder
	InitialBitrate int
	MinBitrate     int
	MaxBitrate     int
	MinQuality     QualityPreset
	MaxQuality     QualityPreset
	Cooldown       time.Duration
	MaxFPS         int        // maximum FPS ceiling (from encoder/session)
	OnFPSChange    func(int)  // called when adaptive FPS changes
}

// minBitsPerFrame is the minimum bits each frame should receive to maintain
// acceptable quality for screen content. When bitrate drops, FPS is reduced
// so each frame stays above this threshold — preventing MFT buffer buildup
// from pushing too many low-quality frames.
const minBitsPerFrame = 40000 // 5KB per frame

type AdaptiveBitrate struct {
	mu            sync.Mutex
	encoder       *VideoEncoder
	minBitrate    int
	maxBitrate    int
	minQuality    QualityPreset
	maxQuality    QualityPreset
	cooldown      time.Duration
	lastAdjust    time.Time
	targetBitrate int
	targetQuality QualityPreset

	// Adaptive FPS: scaled with bitrate to maintain per-frame quality.
	maxFPS      int
	currentFPS  int
	onFPSChange func(int)

	// EWMA-smoothed metrics to avoid reacting to single transient spikes.
	// Alpha = 0.3 gives ~70% weight to history, 30% to new sample.
	smoothedLoss float64
	smoothedRTT  time.Duration
	samplesCount int // track how many samples we've seen for warmup

	// Track consecutive stable samples before upgrading. Prevents oscillation
	// by requiring sustained good conditions before increasing bitrate.
	stableCount int

	// Post-degrade backoff: after a degrade event, require extra stable samples
	// before upgrading to prevent the boom-bust cycle where the controller
	// ramps back to the same bitrate that caused congestion.
	degradeBackoff int

	// Encoder throughput tracking — caps FPS when encoder can't keep up.
	// Common on headless servers where GPU encoding fails and software MFT
	// can only sustain ~15fps instead of the requested 60fps.
	prevCaptured        uint64
	prevEncoded         uint64
	smoothedEncodeRatio float64
	encoderSamples      int
}

func NewAdaptiveBitrate(cfg AdaptiveConfig) (*AdaptiveBitrate, error) {
	if cfg.Encoder == nil {
		return nil, errors.New("encoder is required")
	}
	if cfg.MinBitrate <= 0 || cfg.MaxBitrate <= 0 || cfg.MinBitrate > cfg.MaxBitrate {
		return nil, errors.New("invalid bitrate bounds")
	}
	minQuality := cfg.MinQuality
	maxQuality := cfg.MaxQuality
	if minQuality == "" {
		minQuality = QualityLow
	}
	if maxQuality == "" {
		maxQuality = QualityUltra
	}
	if !minQuality.valid() || !maxQuality.valid() {
		return nil, errors.New("invalid quality bounds")
	}
	if qualityRank(minQuality) > qualityRank(maxQuality) {
		minQuality, maxQuality = maxQuality, minQuality
	}
	cooldown := cfg.Cooldown
	if cooldown == 0 {
		cooldown = 500 * time.Millisecond
	}

	// Start at the encoder's actual bitrate, not the ceiling.
	initialBitrate := cfg.InitialBitrate
	if initialBitrate <= 0 {
		initialBitrate = cfg.MinBitrate
	}
	initialBitrate = clampInt(initialBitrate, cfg.MinBitrate, cfg.MaxBitrate)

	maxFPS := cfg.MaxFPS
	if maxFPS <= 0 {
		maxFPS = 60
	}
	initialFPS := clampInt(initialBitrate/minBitsPerFrame, 10, maxFPS)

	return &AdaptiveBitrate{
		encoder:       cfg.Encoder,
		minBitrate:    cfg.MinBitrate,
		maxBitrate:    cfg.MaxBitrate,
		minQuality:    minQuality,
		maxQuality:    maxQuality,
		cooldown:      cooldown,
		lastAdjust:    time.Time{},
		targetBitrate: initialBitrate,
		targetQuality: QualityAuto,
		maxFPS:        maxFPS,
		currentFPS:    initialFPS,
		onFPSChange:   cfg.OnFPSChange,
	}, nil
}

// SetEncoder updates the encoder pointer after a mid-session encoder swap.
// Resets encoder throughput EWMA so stale data from the old encoder doesn't
// incorrectly cap FPS on the new encoder.
func (a *AdaptiveBitrate) SetEncoder(enc *VideoEncoder) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.encoder = enc
	a.encoderSamples = 0
	a.prevCaptured = 0
	a.prevEncoded = 0
	a.smoothedEncodeRatio = 0
	a.mu.Unlock()
}

// SetMaxFPS updates the FPS ceiling for adaptive scaling.
// Called when the viewer sends a set_fps control message.
func (a *AdaptiveBitrate) SetMaxFPS(max int) {
	if a == nil || max <= 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.maxFPS = max
}

// SetMaxBitrate updates the ceiling the adaptive controller will ramp up to.
// Called when the viewer adjusts the bitrate slider.
func (a *AdaptiveBitrate) SetMaxBitrate(max int) {
	if a == nil || max <= 0 {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.maxBitrate = max
	// If current target exceeds the new ceiling, clamp immediately.
	if a.targetBitrate > max {
		a.targetBitrate = max
		if a.encoder != nil {
			if err := a.encoder.SetBitrate(max); err != nil {
				slog.Warn("Failed to clamp bitrate", "targetBitrate", max, "error", err.Error())
			}
		}
	}
}

// SoftResetForActivity resets the adaptive state when transitioning from idle
// to active. Sets bitrate to a moderate level (60% of max) so the encoder
// doesn't spike from idle ~233kbps to full 2.5Mbps+ in one frame, which
// overwhelms the jitter buffer and causes massive frame drops.
func (a *AdaptiveBitrate) SoftResetForActivity() {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	// Start at 60% of max — enough for a good keyframe but not a burst
	moderate := a.maxBitrate * 60 / 100
	moderate = clampInt(moderate, a.minBitrate, a.maxBitrate)
	a.targetBitrate = moderate
	a.stableCount = 0
	a.degradeBackoff = 0
	a.samplesCount = 0    // reset EWMA warmup for fresh conditions
	a.encoderSamples = 0  // reset encoder ratio so it re-warms after idle

	newFPS := clampInt(moderate/minBitsPerFrame, 10, a.maxFPS)
	prevFPS := a.currentFPS
	a.currentFPS = newFPS
	fpsCallback := a.onFPSChange
	encoder := a.encoder

	slog.Info("Adaptive soft-reset for activity",
		"bitrate", moderate,
		"fps", newFPS,
		"prevFPS", prevFPS,
	)

	if encoder != nil {
		_ = encoder.SetBitrate(moderate)
	}
	if newFPS != prevFPS && fpsCallback != nil {
		fpsCallback(newFPS)
	}
}

// CapForSoftwareEncoder reduces the ABR ceiling when GPU H264 encoding is
// unavailable and the software MFT is the fallback. The software encoder can't
// sustain high bitrate/FPS without stalling, so we cap to conservative limits
// that keep the MFT's rate controller happy (fewer buffering stalls).
func (a *AdaptiveBitrate) CapForSoftwareEncoder() {
	if a == nil {
		return
	}
	a.mu.Lock()

	const swMaxBitrate = 3_000_000 // 3 Mbps — OpenH264 handles this well
	const swMaxFPS = 45            // 45fps — OpenH264 is deterministic, no stalls

	if a.maxBitrate > swMaxBitrate {
		a.maxBitrate = swMaxBitrate
	}
	if a.targetBitrate > a.maxBitrate {
		a.targetBitrate = a.maxBitrate
	}
	a.maxFPS = swMaxFPS
	newFPS := clampInt(a.targetBitrate/minBitsPerFrame, 10, swMaxFPS)
	prevFPS := a.currentFPS
	a.currentFPS = newFPS
	encoder := a.encoder
	fpsCallback := a.onFPSChange
	targetBitrate := a.targetBitrate

	slog.Info("Adaptive: capped for software encoder (no GPU H264)",
		"maxBitrate", a.maxBitrate,
		"targetBitrate", targetBitrate,
		"maxFPS", swMaxFPS,
		"fps", newFPS,
		"prevFPS", prevFPS,
	)
	a.mu.Unlock()

	if encoder != nil {
		if err := encoder.SetBitrate(targetBitrate); err != nil {
			slog.Warn("failed to apply software encoder bitrate cap", "bitrate", targetBitrate, "error", err.Error())
		}
	}
	if newFPS != prevFPS && fpsCallback != nil {
		fpsCallback(newFPS)
	}
}

// UpdateEncoderThroughput feeds encoder-side metrics into the adaptive controller.
// When the encoder produces significantly fewer frames than captured (common with
// software MFT on servers without GPU H264 support), FPS is capped to match actual
// encoder capacity. This prevents wasting CPU on captures the encoder discards.
func (a *AdaptiveBitrate) UpdateEncoderThroughput(captured, encoded uint64) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()

	deltaCaptured := captured - a.prevCaptured
	deltaEncoded := encoded - a.prevEncoded
	a.prevCaptured = captured
	a.prevEncoded = encoded

	// Need enough frames for a meaningful ratio — skip sparse intervals
	// (idle desktop, session startup before first capture).
	if deltaCaptured < 5 {
		return
	}

	ratio := float64(deltaEncoded) / float64(deltaCaptured)
	if ratio > 1.0 {
		ratio = 1.0
	}

	a.encoderSamples++
	if a.encoderSamples == 1 {
		a.smoothedEncodeRatio = ratio
	} else {
		a.smoothedEncodeRatio = ewmaAlpha*ratio + (1-ewmaAlpha)*a.smoothedEncodeRatio
	}
}

// Update feeds a new RTT/loss sample from RTCP and adjusts bitrate.
//
// Uses AIMD (Additive Increase, Multiplicative Decrease) with EWMA smoothing:
//   - Degrade: multiplicative 0.85x on sustained high loss (moderate reaction to congestion)
//   - Upgrade: additive +5% of max on sustained good conditions (gentle probe)
//   - EWMA smoothing prevents reacting to single transient spikes
//   - Loss-only upgrade gating so high-RTT connections can still recover
func (a *AdaptiveBitrate) Update(rtt time.Duration, packetLoss float64) {
	if a == nil {
		return
	}
	if packetLoss < 0 {
		packetLoss = 0
	}
	if packetLoss > 1 {
		packetLoss = 1
	}

	a.mu.Lock()

	now := time.Now()
	if !a.lastAdjust.IsZero() && now.Sub(a.lastAdjust) < a.cooldown {
		// Still update EWMA even when on cooldown so we don't miss data.
		a.updateEWMA(rtt, packetLoss)
		a.mu.Unlock()
		return
	}

	a.updateEWMA(rtt, packetLoss)

	// Need at least 5 samples before making decisions (~2.5s warmup).
	// More samples let the EWMA settle before the controller reacts.
	if a.samplesCount < 5 {
		a.mu.Unlock()
		return
	}

	loss := a.smoothedLoss
	smoothRTT := a.smoothedRTT

	// Degrade: smoothed loss indicates real congestion (not a single spike).
	// Threshold at 8% (strict >) avoids reacting to steady-state minor loss
	// common on WiFi/residential connections. RTT alone doesn't trigger
	// degrade — high RTT with zero loss is just a long path, not congestion.
	degrade := loss > 0.08 || (smoothRTT >= 300*time.Millisecond && loss >= 0.03)

	// Upgrade: loss-based only. Connections with inherently high RTT (cross-
	// continent, WiFi) can still recover as long as there's no packet loss.
	// Require consecutive stable samples to prevent oscillation.
	upgrade := loss <= 0.01

	if degrade {
		a.stableCount = 0
		// After degrading, require extra stable samples before upgrading again.
		// This prevents the boom-bust cycle: degrade→recover→immediately ramp
		// back to the same bitrate that caused congestion. At 1s viewer stats
		// intervals, backoff=4 means ~4s of stable conditions before upgrading.
		a.degradeBackoff = 4
	} else if upgrade {
		a.stableCount++
		if a.degradeBackoff > 0 {
			a.degradeBackoff--
		}
	} else {
		// In the middle zone — not degrading, but not clean enough to upgrade.
		// Let stableCount decay slowly rather than resetting.
		if a.stableCount > 0 {
			a.stableCount--
		}
	}

	// Require 3 consecutive stable samples plus no active backoff before upgrading.
	// At 1s viewer stats polling, this means 3s of clean conditions before each step.
	const stableRequired = 3

	action := "hold"
	newBitrate := a.targetBitrate
	newQuality := a.targetQuality
	if newQuality == QualityAuto {
		newQuality = QualityMedium
	}

	if degrade {
		action = "degrade"
		// Multiplicative decrease: moderate reaction to congestion.
		// 0.85x is gentler than the typical 0.70x to reduce visual pulsing —
		// aggressive drops cause large quality swings that are more jarring
		// than a slightly slower reaction to congestion.
		newBitrate = int(float64(newBitrate) * 0.85)
		newBitrate = clampInt(newBitrate, a.minBitrate, a.maxBitrate)
		newQuality = stepQuality(newQuality, -1, a.minQuality, a.maxQuality)
	} else if a.stableCount >= stableRequired && a.degradeBackoff <= 0 && a.targetBitrate < a.maxBitrate {
		action = "upgrade"
		// Additive increase: gentle probe — add 5% of max ceiling.
		// This avoids multiplicative overshoot that causes degrade spirals.
		step := a.maxBitrate / 20
		if step < 100_000 {
			step = 100_000
		}
		newBitrate = newBitrate + step
		newBitrate = clampInt(newBitrate, a.minBitrate, a.maxBitrate)
		newQuality = stepQuality(newQuality, 1, a.minQuality, a.maxQuality)
		a.stableCount = 0 // reset so we need another stable period before next upgrade
	}

	// Scale FPS with bitrate: ensure each frame gets enough bits for quality.
	newFPS := clampInt(newBitrate/minBitsPerFrame, 10, a.maxFPS)

	// Encoder throughput cap: if the software encoder can't sustain the
	// requested FPS, reduce to match actual encoder capacity. Prevents
	// wasting CPU on captures the encoder discards (common on headless
	// servers where GPU encoding fails and software MFT is the fallback).
	if a.encoderSamples >= 3 && a.smoothedEncodeRatio < 0.85 {
		encoderCapFPS := int(float64(a.maxFPS) * a.smoothedEncodeRatio)
		encoderCapFPS = clampInt(encoderCapFPS, 10, a.maxFPS)
		if newFPS > encoderCapFPS {
			newFPS = encoderCapFPS
			action = "encoder-cap"
		}
	}

	if newBitrate == a.targetBitrate && newQuality == a.targetQuality && newFPS == a.currentFPS {
		a.mu.Unlock()
		return
	}

	prevBitrate := a.targetBitrate
	prevFPS := a.currentFPS
	a.targetBitrate = newBitrate
	a.targetQuality = newQuality
	a.currentFPS = newFPS
	a.lastAdjust = now
	encoder := a.encoder
	fpsCallback := a.onFPSChange
	encodeRatio := a.smoothedEncodeRatio
	a.mu.Unlock()

	slog.Info("Adaptive bitrate adjustment",
		"action", action,
		"bitrate", newBitrate,
		"prev", prevBitrate,
		"fps", newFPS,
		"prevFPS", prevFPS,
		"quality", newQuality,
		"smoothedLoss", loss,
		"smoothedRTT", smoothRTT.Round(time.Millisecond),
		"encodeRatio", encodeRatio,
	)

	if newFPS != prevFPS && fpsCallback != nil {
		fpsCallback(newFPS)
	}

	if encoder != nil {
		if err := encoder.SetBitrate(newBitrate); err != nil {
			slog.Warn("Failed to set bitrate", "bitrate", newBitrate, "error", err.Error())
		}
		if err := encoder.SetQuality(newQuality); err != nil {
			slog.Warn("Failed to set quality", "quality", newQuality, "error", err.Error())
		}
	}
}

const ewmaAlpha = 0.3

func (a *AdaptiveBitrate) updateEWMA(rtt time.Duration, loss float64) {
	a.samplesCount++
	if a.samplesCount == 1 {
		// First sample: seed the EWMA.
		a.smoothedLoss = loss
		a.smoothedRTT = rtt
		return
	}
	a.smoothedLoss = ewmaAlpha*loss + (1-ewmaAlpha)*a.smoothedLoss
	a.smoothedRTT = time.Duration(ewmaAlpha*float64(rtt) + (1-ewmaAlpha)*float64(a.smoothedRTT))
}

func clampInt(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func stepQuality(current QualityPreset, delta int, minQ QualityPreset, maxQ QualityPreset) QualityPreset {
	order := []QualityPreset{QualityLow, QualityMedium, QualityHigh, QualityUltra}
	currentIdx := qualityRank(current)
	minIdx := qualityRank(minQ)
	maxIdx := qualityRank(maxQ)
	if currentIdx < 0 {
		currentIdx = qualityRank(QualityMedium)
	}
	newIdx := currentIdx + delta
	if newIdx < minIdx {
		newIdx = minIdx
	}
	if newIdx > maxIdx {
		newIdx = maxIdx
	}
	if newIdx < 0 || newIdx >= len(order) {
		return current
	}
	return order[newIdx]
}

func qualityRank(quality QualityPreset) int {
	switch quality {
	case QualityLow:
		return 0
	case QualityMedium:
		return 1
	case QualityHigh:
		return 2
	case QualityUltra:
		return 3
	default:
		return -1
	}
}
