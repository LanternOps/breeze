package desktop

import (
	"sync"
	"testing"
)

// resetEnvCeilingForTest forces configuredMaxBitrate() to re-read the
// environment on its next call. configuredMaxBitrate memoizes via sync.Once
// (env vars are immutable for the real process lifetime), so a test that wants
// to exercise a different env value must reset the latch and the cached value.
func resetEnvCeilingForTest() {
	envCeilingOnce = sync.Once{}
	envCeiling = 0
}

func TestResolveMaxBitrate_ResolutionDefaults(t *testing.T) {
	t.Setenv(maxBitrateEnvVar, "")
	resetEnvCeilingForTest()

	cases := []struct {
		name string
		w, h int
		want int
	}{
		{"1080p uses HD ceiling", 1920, 1080, defaultMaxBitrateHD},
		{"720p uses HD ceiling", 1280, 720, defaultMaxBitrateHD},
		{"just above 1080p uses hi-res ceiling", 1920, 1081, defaultMaxBitrateHiRes},
		{"1440p uses hi-res ceiling", 2560, 1440, defaultMaxBitrateHiRes},
		{"4K uses hi-res ceiling", 3840, 2160, defaultMaxBitrateHiRes},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resetEnvCeilingForTest()
			if got := resolveMaxBitrate(tc.w, tc.h); got != tc.want {
				t.Fatalf("resolveMaxBitrate(%d,%d) = %d, want %d", tc.w, tc.h, got, tc.want)
			}
		})
	}
}

func TestResolveMaxBitrate_RaisedFromHistoricalCaps(t *testing.T) {
	t.Setenv(maxBitrateEnvVar, "")
	resetEnvCeilingForTest()

	// Regression guard for issue #1410: the new defaults must exceed the
	// historical 8 Mbps / 15 Mbps hardcodes so 1440p/4K is actually usable.
	if got := resolveMaxBitrate(1920, 1080); got <= 8_000_000 {
		t.Fatalf("HD ceiling %d should exceed the historical 8 Mbps cap", got)
	}
	if got := resolveMaxBitrate(3840, 2160); got <= 15_000_000 {
		t.Fatalf("hi-res ceiling %d should exceed the historical 15 Mbps cap", got)
	}
}

func TestResolveMaxBitrate_EnvOverride(t *testing.T) {
	t.Setenv(maxBitrateEnvVar, "50")
	resetEnvCeilingForTest()

	// A valid override takes precedence at every resolution.
	if got := resolveMaxBitrate(1920, 1080); got != 50_000_000 {
		t.Fatalf("HD with override = %d, want 50000000", got)
	}
	if got := resolveMaxBitrate(3840, 2160); got != 50_000_000 {
		t.Fatalf("4K with override = %d, want 50000000", got)
	}
}

func TestResolveMaxBitrate_EnvOverrideFractional(t *testing.T) {
	t.Setenv(maxBitrateEnvVar, "1.5")
	resetEnvCeilingForTest()

	if got := resolveMaxBitrate(1920, 1080); got != 1_500_000 {
		t.Fatalf("fractional override = %d, want 1500000", got)
	}
}

func TestResolveMaxBitrate_EnvOverrideCanLowerForWAN(t *testing.T) {
	// The override must be able to *lower* the ceiling so a thin-uplink WAN
	// deployment stays protected — not just raise it for LAN.
	t.Setenv(maxBitrateEnvVar, "2")
	resetEnvCeilingForTest()

	if got := resolveMaxBitrate(3840, 2160); got != 2_000_000 {
		t.Fatalf("4K with low override = %d, want 2000000 (below the default ceiling)", got)
	}
}

func TestResolveMaxBitrate_InvalidEnvIgnored(t *testing.T) {
	cases := []string{"abc", "-5", "0", "  "}
	for _, raw := range cases {
		t.Run("raw="+raw, func(t *testing.T) {
			t.Setenv(maxBitrateEnvVar, raw)
			resetEnvCeilingForTest()
			// Falls back to the resolution default rather than applying garbage.
			if got := resolveMaxBitrate(1920, 1080); got != defaultMaxBitrateHD {
				t.Fatalf("invalid override %q applied: got %d, want default %d", raw, got, defaultMaxBitrateHD)
			}
		})
	}
}

func TestResolveMaxBitrate_OutOfRangeEnvIgnored(t *testing.T) {
	cases := []string{
		"0.5", // below 1 Mbps floor
		"500", // above 200 Mbps ceiling
	}
	for _, raw := range cases {
		t.Run("raw="+raw, func(t *testing.T) {
			t.Setenv(maxBitrateEnvVar, raw)
			resetEnvCeilingForTest()
			if got := resolveMaxBitrate(2560, 1440); got != defaultMaxBitrateHiRes {
				t.Fatalf("out-of-range override %q applied: got %d, want default %d", raw, got, defaultMaxBitrateHiRes)
			}
		})
	}
}

func TestConfiguredMaxBitrate_UnsetReturnsZero(t *testing.T) {
	t.Setenv(maxBitrateEnvVar, "")
	resetEnvCeilingForTest()
	if got := configuredMaxBitrate(); got != 0 {
		t.Fatalf("configuredMaxBitrate() with unset env = %d, want 0", got)
	}
}
