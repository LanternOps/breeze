package desktop

import (
	"sync"
	"time"
)

// StreamMetrics tracks real-time performance data for a streaming session.
type StreamMetrics struct {
	mu sync.RWMutex

	FramesCaptured uint64
	FramesEncoded  uint64
	FramesSent     uint64
	FramesSkipped  uint64
	FramesDropped  uint64

	LastCaptureTime time.Duration
	LastScaleTime   time.Duration
	LastEncodeTime  time.Duration
	LastFrameSize   int

	TotalBytesSent uint64
	CurrentQuality int
	startTime      time.Time
}

func newStreamMetrics() *StreamMetrics {
	return &StreamMetrics{startTime: time.Now()}
}

func (m *StreamMetrics) RecordCapture(d time.Duration) {
	m.mu.Lock()
	m.FramesCaptured++
	m.LastCaptureTime = d
	m.mu.Unlock()
}

func (m *StreamMetrics) RecordSkip() {
	m.mu.Lock()
	m.FramesSkipped++
	m.mu.Unlock()
}

func (m *StreamMetrics) RecordScale(d time.Duration) {
	m.mu.Lock()
	m.LastScaleTime = d
	m.mu.Unlock()
}

func (m *StreamMetrics) RecordEncode(d time.Duration, size int) {
	m.mu.Lock()
	m.FramesEncoded++
	m.LastEncodeTime = d
	m.LastFrameSize = size
	m.mu.Unlock()
}

func (m *StreamMetrics) RecordSend(size int) {
	m.mu.Lock()
	m.FramesSent++
	m.TotalBytesSent += uint64(size)
	m.mu.Unlock()
}

func (m *StreamMetrics) RecordDrop() {
	m.mu.Lock()
	m.FramesDropped++
	m.mu.Unlock()
}

func (m *StreamMetrics) SetQuality(q int) {
	m.mu.Lock()
	m.CurrentQuality = q
	m.mu.Unlock()
}

// MetricsSnapshot is a point-in-time copy of metrics for logging.
type MetricsSnapshot struct {
	FramesCaptured uint64
	FramesEncoded  uint64
	FramesSent     uint64
	FramesSkipped  uint64
	FramesDropped  uint64
	CaptureMs      float64
	ScaleMs        float64
	EncodeMs       float64
	LastFrameSize  int
	BandwidthKBps  float64
	CurrentQuality int
	Uptime         time.Duration
}

func (m *StreamMetrics) Snapshot() MetricsSnapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()

	uptime := time.Since(m.startTime)
	bw := float64(0)
	if uptime.Seconds() > 0 {
		bw = float64(m.TotalBytesSent) / uptime.Seconds() / 1024.0
	}

	return MetricsSnapshot{
		FramesCaptured: m.FramesCaptured,
		FramesEncoded:  m.FramesEncoded,
		FramesSent:     m.FramesSent,
		FramesSkipped:  m.FramesSkipped,
		FramesDropped:  m.FramesDropped,
		CaptureMs:      float64(m.LastCaptureTime.Microseconds()) / 1000.0,
		ScaleMs:        float64(m.LastScaleTime.Microseconds()) / 1000.0,
		EncodeMs:       float64(m.LastEncodeTime.Microseconds()) / 1000.0,
		LastFrameSize:  m.LastFrameSize,
		BandwidthKBps:  bw,
		CurrentQuality: m.CurrentQuality,
		Uptime:         uptime,
	}
}
