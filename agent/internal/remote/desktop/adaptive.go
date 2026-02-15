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
}

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

	// EWMA-smoothed metrics to avoid reacting to single transient spikes.
	// Alpha = 0.3 gives ~70% weight to history, 30% to new sample.
	smoothedLoss float64
	smoothedRTT  time.Duration
	samplesCount int // track how many samples we've seen for warmup

	// Track consecutive stable samples before upgrading. Prevents oscillation
	// by requiring sustained good conditions before increasing bitrate.
	stableCount int
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
		cooldown = 2 * time.Second
	}

	// Start at the encoder's actual bitrate, not the ceiling.
	initialBitrate := cfg.InitialBitrate
	if initialBitrate <= 0 {
		initialBitrate = cfg.MinBitrate
	}
	initialBitrate = clampInt(initialBitrate, cfg.MinBitrate, cfg.MaxBitrate)

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
	}, nil
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
				slog.Warn("Failed to clamp bitrate", "targetBitrate", max, "error", err)
			}
		}
	}
}

// Update feeds a new RTT/loss sample from RTCP and adjusts bitrate.
//
// Uses AIMD (Additive Increase, Multiplicative Decrease) with EWMA smoothing:
//   - Degrade: multiplicative 0.70x on sustained high loss (fast reaction to congestion)
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

	// Need at least 3 samples before making decisions (6s warmup).
	if a.samplesCount < 3 {
		a.mu.Unlock()
		return
	}

	loss := a.smoothedLoss
	smoothRTT := a.smoothedRTT

	// Degrade: smoothed loss indicates real congestion (not a single spike).
	// RTT alone doesn't trigger degrade — high RTT with zero loss is just a
	// long path, not congestion. Only degrade on RTT if loss is also present.
	degrade := loss >= 0.05 || (smoothRTT >= 300*time.Millisecond && loss >= 0.02)

	// Upgrade: loss-based only. Connections with inherently high RTT (cross-
	// continent, WiFi) can still recover as long as there's no packet loss.
	// Require consecutive stable samples to prevent oscillation.
	upgrade := loss <= 0.01

	if degrade {
		a.stableCount = 0
	} else if upgrade {
		a.stableCount++
	} else {
		// In the middle zone — not degrading, but not clean enough to upgrade.
		// Let stableCount decay slowly rather than resetting.
		if a.stableCount > 0 {
			a.stableCount--
		}
	}

	// Require 3 consecutive stable samples (~6s) before upgrading.
	// This prevents upgrade→degrade oscillation cycles.
	const stableRequired = 3

	action := "hold"
	newBitrate := a.targetBitrate
	newQuality := a.targetQuality
	if newQuality == QualityAuto {
		newQuality = QualityMedium
	}

	if degrade {
		action = "degrade"
		// Multiplicative decrease: fast reaction to congestion.
		newBitrate = int(float64(newBitrate) * 0.70)
		newBitrate = clampInt(newBitrate, a.minBitrate, a.maxBitrate)
		newQuality = stepQuality(newQuality, -1, a.minQuality, a.maxQuality)
	} else if a.stableCount >= stableRequired && a.targetBitrate < a.maxBitrate {
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

	if newBitrate == a.targetBitrate && newQuality == a.targetQuality {
		a.mu.Unlock()
		return
	}

	prevBitrate := a.targetBitrate
	a.targetBitrate = newBitrate
	a.targetQuality = newQuality
	a.lastAdjust = now
	encoder := a.encoder
	a.mu.Unlock()

	slog.Info("Adaptive bitrate adjustment",
		"action", action,
		"bitrate", newBitrate,
		"prev", prevBitrate,
		"quality", newQuality,
		"smoothedLoss", loss,
		"smoothedRTT", smoothRTT.Round(time.Millisecond),
	)

	if encoder != nil {
		if err := encoder.SetBitrate(newBitrate); err != nil {
			slog.Warn("Failed to set bitrate", "bitrate", newBitrate, "error", err)
		}
		if err := encoder.SetQuality(newQuality); err != nil {
			slog.Warn("Failed to set quality", "quality", newQuality, "error", err)
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
