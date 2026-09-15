package desktop

import (
	"testing"
	"time"
)

// The "Desktop WebRTC metrics" line reports captureMs/convertMs alongside
// encodeMs so a slow capturer or colour conversion is not misread as a slow
// encoder (#5929).
func TestStreamMetricsSnapshotCarriesCaptureConvertEncode(t *testing.T) {
	m := newStreamMetrics()
	m.RecordCapture(12 * time.Millisecond)
	m.RecordConvert(3500 * time.Microsecond)
	m.RecordEncode(7*time.Millisecond, 1024)

	snap := m.Snapshot()
	if snap.CaptureMs != 12 {
		t.Fatalf("CaptureMs = %v, want 12", snap.CaptureMs)
	}
	if snap.ConvertMs != 3.5 {
		t.Fatalf("ConvertMs = %v, want 3.5", snap.ConvertMs)
	}
	if snap.EncodeMs != 7 {
		t.Fatalf("EncodeMs = %v, want 7", snap.EncodeMs)
	}
}

// convertTimingStub is an encoderBackend that also reports its last colour
// conversion duration, as the CPU-path encoders do.
type convertTimingStub struct {
	stubEncoder
	convertTimer
}

func TestVideoEncoderLastConvertDuration(t *testing.T) {
	stub := &convertTimingStub{}
	stub.record(4 * time.Millisecond)
	enc := &VideoEncoder{backend: stub}
	if got := enc.LastConvertDuration(); got != 4*time.Millisecond {
		t.Fatalf("LastConvertDuration = %v, want 4ms", got)
	}

	plain := &VideoEncoder{backend: &stubEncoder{}}
	if got := plain.LastConvertDuration(); got != 0 {
		t.Fatalf("backend without conversion timing should report 0, got %v", got)
	}
}
