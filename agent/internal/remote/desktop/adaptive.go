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
	//
	// Uses observed encoded-frames-per-second (not an encoded/captured
	// ratio): when the cap drops capture to match encoder output, a ratio
	// would recover toward 1.0 and release the cap, while an observed-FPS
	// measurement correctly stays at the encoder's true ceiling.
	prevCaptured           uint64
	prevEncoded            uint64
	lastEncoderSample      time.Time
	smoothedEncodedFPS     float64 // EWMA of observed encoder output rate
	encoderSamples         int
	encoderCapFPS          int // currently-applied cap (0 = no cap)
	encoderCapReleaseCount int // consecutive samples above release threshold

	// clock is overridable for tests.
	clock func() time.Time
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
		clock:         time.Now,
	}, nil
}

// SetEncoder updates the encoder pointer after a mid-session encoder swap.
// Resets encoder throughput EWMA AND AIMD control state so stale degradation
// history from the old encoder doesn't cause bitrate cycling on the new one.
func (a *AdaptiveBitrate) SetEncoder(enc *VideoEncoder) {
	if a == nil {
		return
	}
	a.mu.Lock()
	a.encoder = enc
	// Reset encoder throughput tracking
	a.encoderSamples = 0
	a.prevCaptured = 0
	a.prevEncoded = 0
	a.smoothedEncodedFPS = 0
	a.lastEncoderSample = time.Time{}
	a.encoderCapFPS = 0
	a.encoderCapReleaseCount = 0
	// Reset AIMD control state — old degradation backoff and stable counts
	// don't apply to the new encoder and cause boom-bust bitrate cycling.
	a.stableCount = 0
	a.degradeBackoff = 0
	a.samplesCount = 0
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
	a.samplesCount = 0 // reset network EWMA warmup for fresh conditions
	// Intentionally preserve encoderSamples / encoderCapFPS: the encoder's
	// max sustainable throughput is a property of hardware/driver, not of
	// user activity, so the cap must outlive idle→active transitions.

	newFPS := clampInt(moderate/minBitsPerFrame, 10, a.maxFPS)
	// Respect an active encoder cap — hardware capacity doesn't change with
	// user activity, so the cap must clamp the post-reset FPS directly
	// instead of relying on the next viewer_stats tick to re-apply it.
	if a.encoderCapFPS > 0 && newFPS > a.encoderCapFPS {
		newFPS = a.encoderCapFPS
	}
	prevFPS := a.currentFPS
	a.currentFPS = newFPS
	fpsCallback := a.onFPSChange
	encoder := a.encoder

	slog.Info("Adaptive soft-reset for activity",
		"bitrate", moderate,
		"fps", newFPS,
		"prevFPS", prevFPS,
		"encoderCap", a.encoderCapFPS,
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
//
// The rate is measured as encoded-frames-per-second over the wall-clock interval
// between calls, NOT as an encoded/captured ratio. Ratio-based measurement is
// a positive-feedback loop: capping capture makes the ratio recover to 1.0 even
// though encoder throughput is unchanged.
func (a *AdaptiveBitrate) UpdateEncoderThroughput(captured, encoded uint64) {
	if a == nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.updateEncoderThroughputLocked(captured, encoded, a.clock())
}

func (a *AdaptiveBitrate) updateEncoderThroughputLocked(captured, encoded uint64, now time.Time) {
	if a.lastEncoderSample.IsZero() {
		a.lastEncoderSample = now
		a.prevCaptured = captured
		a.prevEncoded = encoded
		return
	}

	interval := now.Sub(a.lastEncoderSample)
	// Need a meaningful interval — skip sub-100ms samples (would amplify noise).
	// On long gaps (>5s, e.g. paused session) reset the baseline so stale data
	// doesn't pollute the EWMA.
	if interval < 100*time.Millisecond {
		return
	}
	if interval > 5*time.Second {
		a.lastEncoderSample = now
		a.prevCaptured = captured
		a.prevEncoded = encoded
		a.encoderSamples = 0
		a.smoothedEncodedFPS = 0
		return
	}

	deltaCaptured := captured - a.prevCaptured
	deltaEncoded := encoded - a.prevEncoded
	a.lastEncoderSample = now
	a.prevCaptured = captured
	a.prevEncoded = encoded

	// Need enough captured frames to trust the measurement.
	if deltaCaptured < 5 {
		return
	}

	observedFPS := float64(deltaEncoded) / interval.Seconds()
	a.encoderSamples++
	if a.encoderSamples == 1 {
		a.smoothedEncodedFPS = observedFPS
	} else {
		a.smoothedEncodedFPS = ewmaAlpha*observedFPS + (1-ewmaAlpha)*a.smoothedEncodedFPS
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

	// Encoder throughput cap: sticky FPS ceiling based on observed encoder
	// output rate. Once engaged, requires 3 consecutive samples above
	// cap*1.25 before releasing, so transient bursts can't trigger a
	// release → overshoot → re-engage cycle.
	if a.encoderSamples >= 3 {
		observed := a.smoothedEncodedFPS
		if a.encoderCapFPS == 0 {
			// Not capped — engage if encoder can't keep up with maxFPS.
			// 0.85 threshold keeps a little slack before intervening.
			if observed > 0 && observed < float64(a.maxFPS)*0.85 {
				cap := int(observed * 1.1) // 10% headroom above observed
				a.encoderCapFPS = clampInt(cap, 10, a.maxFPS)
				a.encoderCapReleaseCount = 0
			}
		} else {
			// Already capped — check for release or lower.
			releaseThreshold := float64(a.encoderCapFPS) * 1.25
			if observed >= releaseThreshold {
				a.encoderCapReleaseCount++
				if a.encoderCapReleaseCount >= 3 {
					a.encoderCapFPS = 0
					a.encoderCapReleaseCount = 0
				}
			} else {
				a.encoderCapReleaseCount = 0
				// If throughput sags further, lower the cap to match.
				if observed > 0 && observed < float64(a.encoderCapFPS)*0.8 {
					cap := int(observed * 1.1)
					a.encoderCapFPS = clampInt(cap, 10, a.maxFPS)
				}
			}
		}
		if a.encoderCapFPS > 0 && newFPS > a.encoderCapFPS {
			newFPS = a.encoderCapFPS
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
	observedEncFPS := a.smoothedEncodedFPS
	encoderCap := a.encoderCapFPS
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
		"observedEncFPS", observedEncFPS,
		"encoderCap", encoderCap,
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
