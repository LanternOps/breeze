package desktop

import (
	"sync"
	"time"
)

// adaptiveQuality adjusts JPEG quality based on encode timing and frame drop rate.
type adaptiveQuality struct {
	mu sync.Mutex

	baseQuality int
	quality     int
	minQuality  int
	maxQuality  int

	recentEncodeTimes []time.Duration
	recentFrameSizes  []int
	windowSize        int
	dropCount         int
	sendCount         int

	lastAdjust time.Time
	cooldown   time.Duration
}

func newAdaptiveQuality(baseQuality int) *adaptiveQuality {
	maxQ := baseQuality + 15
	if maxQ > 95 {
		maxQ = 95
	}
	return &adaptiveQuality{
		baseQuality: baseQuality,
		quality:     baseQuality,
		minQuality:  20,
		maxQuality:  maxQ,
		windowSize:  30,
		cooldown:    500 * time.Millisecond,
	}
}

// RecordFrame records metrics for an encoded frame.
func (a *adaptiveQuality) RecordFrame(encodeTime time.Duration, frameSize int, dropped bool) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.sendCount++
	if dropped {
		a.dropCount++
	}

	a.recentEncodeTimes = append(a.recentEncodeTimes, encodeTime)
	a.recentFrameSizes = append(a.recentFrameSizes, frameSize)
	if len(a.recentEncodeTimes) > a.windowSize {
		a.recentEncodeTimes = a.recentEncodeTimes[1:]
		a.recentFrameSizes = a.recentFrameSizes[1:]
	}
}

// Quality returns the current effective JPEG quality.
func (a *adaptiveQuality) Quality() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.quality
}

// Adjust recalculates quality based on recent metrics.
func (a *adaptiveQuality) Adjust() {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := time.Now()
	if now.Sub(a.lastAdjust) < a.cooldown {
		return
	}
	if len(a.recentEncodeTimes) < 5 {
		return
	}

	var totalTime time.Duration
	var totalSize int
	for i, t := range a.recentEncodeTimes {
		totalTime += t
		totalSize += a.recentFrameSizes[i]
	}
	n := len(a.recentEncodeTimes)
	avgEncodeMs := float64(totalTime.Milliseconds()) / float64(n)
	avgSize := totalSize / n

	dropRate := float64(0)
	if a.sendCount > 0 {
		dropRate = float64(a.dropCount) / float64(a.sendCount)
	}

	newQuality := a.quality

	if avgEncodeMs > 30 || dropRate > 0.1 || avgSize > 80*1024 {
		newQuality -= 5
	} else if avgEncodeMs < 15 && dropRate < 0.02 && avgSize < 40*1024 {
		newQuality += 3
	}

	if newQuality < a.minQuality {
		newQuality = a.minQuality
	}
	if newQuality > a.maxQuality {
		newQuality = a.maxQuality
	}

	if newQuality != a.quality {
		a.quality = newQuality
		a.lastAdjust = now
		a.dropCount = 0
		a.sendCount = 0
	}
}

// SetBaseQuality updates the user-configured base quality.
func (a *adaptiveQuality) SetBaseQuality(q int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.baseQuality = q
	a.maxQuality = q + 15
	if a.maxQuality > 95 {
		a.maxQuality = 95
	}
	a.quality = q
}
