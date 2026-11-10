//go:build windows

package desktop

import (
	"testing"
)

// These tests drive Microsoft's real software H264 MFT (#11622). They skip
// where it is not registered (e.g. Windows Server without Media Foundation).

func newSoftwareMFTForTest(t *testing.T, lateLowLatency bool) *mftEncoder {
	t.Helper()
	be, err := newMFTPlaceholderFallbackEncoder(EncoderConfig{Codec: CodecH264, Bitrate: 2_500_000, FPS: 30})
	if err != nil {
		t.Skipf("no Media Foundation H264 encoder: %v", err)
	}
	m := be.(*mftEncoder)
	m.lateLowLatency = lateLowLatency
	m.SetPixelFormat(PixelFormatBGRA)
	if err := m.SetDimensions(640, 360); err != nil {
		t.Fatal(err)
	}
	if !m.inited {
		t.Skipf("MFT did not initialize: %v", m.InitError())
	}
	if m.isHW || m.asyncMode {
		m.Close()
		t.Skip("a hardware MFT was activated; this test needs the software MFT")
	}
	t.Cleanup(func() { m.Close() })
	return m
}

func softwareMFTTestFrame(i int) []byte {
	f := make([]byte, 640*360*4)
	for j := range f {
		f[j] = byte(i*12 + j%7)
	}
	return f
}

func TestSoftwareMFT_OneOutputPerInput(t *testing.T) {
	m := newSoftwareMFTForTest(t, false)
	nils := 0
	for i := 1; i <= 10; i++ {
		out, err := m.Encode(softwareMFTTestFrame(i))
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if out == nil {
			nils++
		}
	}
	if nils > 0 {
		t.Fatalf("software MFT returned no output for %d of 10 inputs; low-latency mode set before negotiation should make it one-in-one-out", nils)
	}
	for i := 0; i < 5; i++ {
		if out, _ := m.CatchUpIdle(); out != nil {
			t.Fatalf("a one-in-one-out encoder must not be re-fed at idle")
		}
	}
	if m.catchUp.refeeds != 0 {
		t.Fatalf("re-submits = %d on a one-in-one-out encoder, want 0", m.catchUp.refeeds)
	}
}

func TestSoftwareMFT_IdleCatchUpPushesHeldFramesOut(t *testing.T) {
	m := newSoftwareMFTForTest(t, true) // reproduce the 5-frame hold
	outputs := 0
	for i := 1; i <= 10; i++ {
		out, err := m.Encode(softwareMFTTestFrame(i))
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if out != nil {
			outputs++
		}
	}
	held := m.catchUp.held()
	if held == 0 {
		t.Skip("this build's software MFT does not hold frames even with late low-latency mode")
	}
	t.Logf("encoder holds %d frames after 10 inputs (%d outputs)", held, outputs)

	refeeds, caught := 0, 0
	for i := 0; i < 50; i++ {
		out, err := m.CatchUpIdle()
		if err != nil {
			t.Fatalf("catch-up: %v", err)
		}
		if m.catchUp.refeeds > refeeds {
			refeeds = m.catchUp.refeeds
		}
		if out != nil {
			caught++
		}
	}
	if m.catchUp.newest > m.catchUp.emitted {
		t.Fatalf("after idle catch-up the newest frame is still inside the encoder (newest=%d emitted=%d)",
			m.catchUp.newest, m.catchUp.emitted)
	}
	if refeeds != held {
		t.Fatalf("re-submits = %d, want %d (one per held frame)", refeeds, held)
	}
	if caught != held {
		t.Fatalf("catch-up outputs = %d, want %d", caught, held)
	}

	// The accounting must stay in step: the next screen change is held the
	// same way and needs the same number of re-submits, not a growing number.
	if out, err := m.Encode(softwareMFTTestFrame(30)); err != nil || out == nil {
		t.Fatalf("a new frame after catch-up must push a held frame out (out=%v err=%v)", out != nil, err)
	}
	if got := m.catchUp.held(); got != held {
		t.Fatalf("held after a new frame = %d, want %d", got, held)
	}
	for i := 0; i < 50; i++ {
		if _, err := m.CatchUpIdle(); err != nil {
			t.Fatalf("catch-up: %v", err)
		}
	}
	if m.catchUp.refeeds != held || m.catchUp.newest > m.catchUp.emitted {
		t.Fatalf("second change: re-submits=%d (want %d), newest=%d emitted=%d",
			m.catchUp.refeeds, held, m.catchUp.newest, m.catchUp.emitted)
	}

	// A flush with frames inside: the retained frame is carried into the new
	// stream and pushed out within the budget.
	for i := 11; i <= 13; i++ {
		if _, err := m.Encode(softwareMFTTestFrame(i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.Flush(); err != nil {
		t.Fatal(err)
	}
	caught = 0
	for i := 0; i < 50; i++ {
		out, err := m.CatchUpIdle()
		if err != nil {
			t.Fatalf("catch-up after flush: %v", err)
		}
		if out != nil {
			caught++
		}
	}
	if m.catchUp.lost || m.catchUp.newest > m.catchUp.emitted {
		t.Fatalf("after a flush and idle catch-up the newest frame never came out (lost=%v newest=%d emitted=%d)",
			m.catchUp.lost, m.catchUp.newest, m.catchUp.emitted)
	}
	if m.IsPermanentlyStalled() {
		t.Fatalf("idle catch-up after a flush must not trip the stall detector")
	}
	t.Logf("after flush: %d catch-up outputs, %d re-submits", caught, m.catchUp.refeeds)
}
