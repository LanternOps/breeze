package desktop

import (
	"errors"
	"sync"
	"time"
)

type AdaptiveConfig struct {
	Encoder    *VideoEncoder
	MinBitrate int
	MaxBitrate int
	MinQuality QualityPreset
	MaxQuality QualityPreset
	Cooldown   time.Duration
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

	return &AdaptiveBitrate{
		encoder:       cfg.Encoder,
		minBitrate:    cfg.MinBitrate,
		maxBitrate:    cfg.MaxBitrate,
		minQuality:    minQuality,
		maxQuality:    maxQuality,
		cooldown:      cooldown,
		lastAdjust:    time.Time{},
		targetBitrate: cfg.MaxBitrate,
		targetQuality: QualityAuto,
	}, nil
}

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
		a.mu.Unlock()
		return
	}

	degrade := packetLoss >= 0.08 || rtt >= 250*time.Millisecond
	upgrade := packetLoss <= 0.02 && rtt <= 120*time.Millisecond
	if !degrade && !upgrade {
		a.mu.Unlock()
		return
	}

	newBitrate := a.targetBitrate
	newQuality := a.targetQuality
	if newQuality == QualityAuto {
		newQuality = QualityMedium
	}

	if degrade {
		newBitrate = int(float64(newBitrate) * 0.85)
		newBitrate = clampInt(newBitrate, a.minBitrate, a.maxBitrate)
		newQuality = stepQuality(newQuality, -1, a.minQuality, a.maxQuality)
	} else if upgrade {
		newBitrate = int(float64(newBitrate) * 1.10)
		newBitrate = clampInt(newBitrate, a.minBitrate, a.maxBitrate)
		newQuality = stepQuality(newQuality, 1, a.minQuality, a.maxQuality)
	}

	if newBitrate == a.targetBitrate && newQuality == a.targetQuality {
		a.mu.Unlock()
		return
	}

	a.targetBitrate = newBitrate
	a.targetQuality = newQuality
	a.lastAdjust = now
	encoder := a.encoder
	a.mu.Unlock()

	if encoder != nil {
		_ = encoder.SetBitrate(newBitrate)
		_ = encoder.SetQuality(newQuality)
	}
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
