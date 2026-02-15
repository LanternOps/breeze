package desktop

import (
	"testing"
	"time"
)

// stubEncoder satisfies encoderBackend for testing adaptive bitrate.
type stubEncoder struct {
	bitrate int
	quality QualityPreset
}

func (s *stubEncoder) Encode([]byte) ([]byte, error)              { return nil, nil }
func (s *stubEncoder) SetCodec(Codec) error                       { return nil }
func (s *stubEncoder) SetQuality(q QualityPreset) error           { s.quality = q; return nil }
func (s *stubEncoder) SetBitrate(b int) error                     { s.bitrate = b; return nil }
func (s *stubEncoder) SetFPS(int) error                           { return nil }
func (s *stubEncoder) SetDimensions(int, int) error               { return nil }
func (s *stubEncoder) SetPixelFormat(PixelFormat)                  {}
func (s *stubEncoder) Close() error                                { return nil }
func (s *stubEncoder) Name() string                                { return "stub" }
func (s *stubEncoder) IsHardware() bool                            { return false }
func (s *stubEncoder) IsPlaceholder() bool                         { return false }
func (s *stubEncoder) SetD3D11Device(uintptr, uintptr)             {}
func (s *stubEncoder) SupportsGPUInput() bool                      { return false }
func (s *stubEncoder) EncodeTexture(uintptr) ([]byte, error)       { return nil, nil }

func newTestAdaptive(initial, min, max int) (*AdaptiveBitrate, *stubEncoder) {
	stub := &stubEncoder{bitrate: initial}
	enc := &VideoEncoder{backend: stub, cfg: EncoderConfig{Bitrate: initial}}
	a, err := NewAdaptiveBitrate(AdaptiveConfig{
		Encoder:        enc,
		InitialBitrate: initial,
		MinBitrate:     min,
		MaxBitrate:     max,
		Cooldown:       time.Nanosecond, // effectively zero for tests
	})
	if err != nil {
		panic(err)
	}
	return a, stub
}

// warmup feeds clean samples to get past the 3-sample EWMA warmup.
// Returns the stableCount accumulated during warmup (the 3rd sample runs the
// algorithm and may increment stableCount).
func warmup(a *AdaptiveBitrate, rtt time.Duration, loss float64) {
	for i := 0; i < 3; i++ {
		a.Update(rtt, loss)
	}
}

func TestAdaptive_InitialBitrateMatchesEncoder(t *testing.T) {
	a, _ := newTestAdaptive(2_500_000, 500_000, 8_000_000)
	if a.targetBitrate != 2_500_000 {
		t.Fatalf("expected targetBitrate=2500000, got %d", a.targetBitrate)
	}
}

func TestAdaptive_WarmupPreventsEarlyAction(t *testing.T) {
	a, stub := newTestAdaptive(2_500_000, 500_000, 8_000_000)

	// First two samples shouldn't trigger any adjustment (warmup = 3 samples).
	a.Update(10*time.Millisecond, 0.0)
	a.Update(10*time.Millisecond, 0.0)
	if stub.bitrate != 2_500_000 {
		t.Fatalf("bitrate changed during warmup: %d", stub.bitrate)
	}
}

func TestAdaptive_DegradeOnHighLoss(t *testing.T) {
	a, stub := newTestAdaptive(2_500_000, 500_000, 8_000_000)

	// Warm up with high-loss samples so EWMA is already elevated.
	for i := 0; i < 5; i++ {
		a.Update(50*time.Millisecond, 0.10)
	}

	if stub.bitrate >= 2_500_000 {
		t.Fatalf("expected degrade, bitrate=%d", stub.bitrate)
	}
}

func TestAdaptive_DegradeMultiplicative(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Warmup + first action with high loss triggers degrade.
	warmup(a, 50*time.Millisecond, 0.10)
	// The 3rd warmup sample is the first action sample → bitrate drops to 0.70x.
	expected := int(float64(2_000_000) * 0.70)
	if abs(stub.bitrate-expected) > 50_000 {
		t.Fatalf("expected bitrate ~%d after degrade, got %d", expected, stub.bitrate)
	}
}

func TestAdaptive_UpgradeRequiresStableSamples(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Warm up with clean samples. The 3rd sample runs algorithm, stableCount→1.
	warmup(a, 50*time.Millisecond, 0.0)

	// After warmup, stableCount=1. Need 3 total to trigger upgrade.
	// Sending 1 more gives stableCount=2 — no upgrade yet.
	prevBitrate := stub.bitrate
	a.Update(50*time.Millisecond, 0.0) // stableCount=2
	if stub.bitrate != prevBitrate {
		t.Fatalf("upgraded too early with stableCount=2, bitrate=%d", stub.bitrate)
	}

	// stableCount=3 → triggers upgrade.
	a.Update(50*time.Millisecond, 0.0)
	if stub.bitrate <= prevBitrate {
		t.Fatalf("should have upgraded at stableCount=3, bitrate=%d", stub.bitrate)
	}
}

func TestAdaptive_UpgradeIsAdditive(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Warm up + get to stableCount=3 (triggers first upgrade).
	warmup(a, 50*time.Millisecond, 0.0)       // stableCount=1
	a.Update(50*time.Millisecond, 0.0)         // stableCount=2
	a.Update(50*time.Millisecond, 0.0)         // stableCount=3 → upgrade

	// Step should be 5% of max (8M/20 = 400K).
	expected := 2_000_000 + 400_000
	if stub.bitrate != expected {
		t.Fatalf("expected additive step to %d, got %d", expected, stub.bitrate)
	}
}

func TestAdaptive_HighRTTDoesNotDegradeAlone(t *testing.T) {
	a, stub := newTestAdaptive(4_000_000, 500_000, 8_000_000)

	// High RTT but zero loss — this is just a long path, not congestion.
	for i := 0; i < 6; i++ {
		a.Update(200*time.Millisecond, 0.0)
	}

	if stub.bitrate < 4_000_000 {
		t.Fatalf("high RTT alone should not degrade, bitrate=%d", stub.bitrate)
	}
}

func TestAdaptive_HighRTTCanStillRecover(t *testing.T) {
	a, stub := newTestAdaptive(2_000_000, 500_000, 8_000_000)

	// Degrade with high loss + high RTT.
	for i := 0; i < 5; i++ {
		a.Update(200*time.Millisecond, 0.10)
	}
	degradedBitrate := stub.bitrate

	// Now loss clears but RTT stays high. Upgrade is loss-based only, so
	// it should recover once EWMA loss drops below 0.01.
	// EWMA decay from ~0.10 to <0.01 takes ~7 samples, then 3 stable to upgrade.
	for i := 0; i < 20; i++ {
		a.Update(200*time.Millisecond, 0.0)
	}

	if stub.bitrate <= degradedBitrate {
		t.Fatalf("should recover when loss clears even with high RTT, degraded=%d, current=%d",
			degradedBitrate, stub.bitrate)
	}
}

func TestAdaptive_FloorAndCeiling(t *testing.T) {
	a, stub := newTestAdaptive(600_000, 500_000, 8_000_000)

	// Degrade many times — should not go below floor.
	for i := 0; i < 20; i++ {
		a.Update(50*time.Millisecond, 0.20)
	}

	if stub.bitrate < 500_000 {
		t.Fatalf("went below floor: %d", stub.bitrate)
	}

	// Recover many times — should not exceed ceiling.
	for i := 0; i < 200; i++ {
		a.Update(50*time.Millisecond, 0.0)
	}

	if stub.bitrate > 8_000_000 {
		t.Fatalf("exceeded ceiling: %d", stub.bitrate)
	}
}

func TestAdaptive_EWMASmooths(t *testing.T) {
	a, stub := newTestAdaptive(4_000_000, 500_000, 8_000_000)

	// Warm up with clean data.
	warmup(a, 50*time.Millisecond, 0.0)

	// Single spike: one high-loss sample among clean ones should NOT degrade
	// because EWMA smooths it out (0.3 * 0.10 + 0.7 * 0.0 = 0.03 < 0.05).
	a.Update(50*time.Millisecond, 0.10)

	if stub.bitrate < 4_000_000 {
		t.Fatalf("single spike should not degrade (EWMA smoothing), bitrate=%d", stub.bitrate)
	}
}

func TestAdaptive_SetMaxBitrateClampsDown(t *testing.T) {
	a, stub := newTestAdaptive(5_000_000, 500_000, 8_000_000)

	a.SetMaxBitrate(3_000_000)
	if stub.bitrate != 3_000_000 {
		t.Fatalf("expected clamp to 3M, got %d", stub.bitrate)
	}
	if a.targetBitrate != 3_000_000 {
		t.Fatalf("expected targetBitrate=3M, got %d", a.targetBitrate)
	}
}

func TestAdaptive_FullRecovery(t *testing.T) {
	a, stub := newTestAdaptive(8_000_000, 500_000, 8_000_000)

	// Degrade to floor — each Update applies 0.70x.
	for i := 0; i < 50; i++ {
		a.Update(50*time.Millisecond, 0.15)
	}
	if stub.bitrate != 500_000 {
		t.Fatalf("expected floor, got %d", stub.bitrate)
	}

	// Recover fully. Need EWMA to settle (~10 samples), then 3 stable per
	// upgrade step. From 500K to 8M at +400K/step: ~19 steps × 3 = 57.
	// Plus ~10 EWMA settle + initial degrades from EWMA memory ≈ 80 total.
	for i := 0; i < 120; i++ {
		a.Update(50*time.Millisecond, 0.0)
	}
	if stub.bitrate < 8_000_000 {
		t.Fatalf("should have recovered to ceiling, got %d", stub.bitrate)
	}
}

func TestAdaptive_NoOscillation(t *testing.T) {
	a, stub := newTestAdaptive(4_000_000, 500_000, 8_000_000)

	// Warm up clean.
	warmup(a, 50*time.Millisecond, 0.0)

	// Alternating good/mediocre samples should NOT cause oscillation.
	// Mediocre = loss 0.03 (above upgrade threshold but below degrade).
	var lastBitrate int
	oscillations := 0
	for i := 0; i < 20; i++ {
		loss := 0.0
		if i%2 == 1 {
			loss = 0.03 // in dead zone
		}
		a.Update(50*time.Millisecond, loss)
		if stub.bitrate != lastBitrate && lastBitrate != 0 {
			oscillations++
		}
		lastBitrate = stub.bitrate
	}

	// With stableCount requirement and EWMA, we expect very few changes.
	if oscillations > 2 {
		t.Fatalf("too many oscillations: %d", oscillations)
	}
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
