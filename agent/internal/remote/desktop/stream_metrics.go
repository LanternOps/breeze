package desktop

import (
	"sync/atomic"
	"time"
)

// StreamMetrics tracks real-time performance data for a streaming session.
type StreamMetrics struct {
	FramesCaptured atomic.Uint64
	FramesEncoded  atomic.Uint64
	FramesSent     atomic.Uint64
	FramesSkipped  atomic.Uint64
	FramesDropped  atomic.Uint64

	LastCaptureNanos atomic.Int64
	LastScaleNanos   atomic.Int64
	LastEncodeNanos  atomic.Int64
	LastFrameSize    atomic.Int64

	TotalBytesSent atomic.Uint64
	CurrentQuality atomic.Int64
	startTime      time.Time
}

func newStreamMetrics() *StreamMetrics {
	return &StreamMetrics{startTime: time.Now()}
}

func (m *StreamMetrics) RecordCapture(d time.Duration) {
	m.FramesCaptured.Add(1)
	m.LastCaptureNanos.Store(d.Nanoseconds())
}

func (m *StreamMetrics) RecordSkip() {
	m.FramesSkipped.Add(1)
}

func (m *StreamMetrics) RecordScale(d time.Duration) {
	m.LastScaleNanos.Store(d.Nanoseconds())
}

func (m *StreamMetrics) RecordEncode(d time.Duration, size int) {
	m.FramesEncoded.Add(1)
	m.LastEncodeNanos.Store(d.Nanoseconds())
	m.LastFrameSize.Store(int64(size))
}

func (m *StreamMetrics) RecordSend(size int) {
	m.FramesSent.Add(1)
	m.TotalBytesSent.Add(uint64(size))
}

func (m *StreamMetrics) RecordDrop() {
	m.FramesDropped.Add(1)
}

func (m *StreamMetrics) SetQuality(q int) {
	m.CurrentQuality.Store(int64(q))
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
	uptime := time.Since(m.startTime)
	bw := float64(0)
	totalBytesSent := m.TotalBytesSent.Load()
	if uptime.Seconds() > 0 {
		bw = float64(totalBytesSent) / uptime.Seconds() / 1024.0
	}

	return MetricsSnapshot{
		FramesCaptured: m.FramesCaptured.Load(),
		FramesEncoded:  m.FramesEncoded.Load(),
		FramesSent:     m.FramesSent.Load(),
		FramesSkipped:  m.FramesSkipped.Load(),
		FramesDropped:  m.FramesDropped.Load(),
		CaptureMs:      float64(time.Duration(m.LastCaptureNanos.Load()).Microseconds()) / 1000.0,
		ScaleMs:        float64(time.Duration(m.LastScaleNanos.Load()).Microseconds()) / 1000.0,
		EncodeMs:       float64(time.Duration(m.LastEncodeNanos.Load()).Microseconds()) / 1000.0,
		LastFrameSize:  int(m.LastFrameSize.Load()),
		BandwidthKBps:  bw,
		CurrentQuality: int(m.CurrentQuality.Load()),
		Uptime:         uptime,
	}
}
