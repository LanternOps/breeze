package desktop

import "testing"

func TestCeilingForResolution(t *testing.T) {
	tests := []struct {
		name     string
		w, h     int
		override int
		want     int
	}{
		{"720p uses 1080p tier", 1280, 720, 0, defaultBitrate1080p},
		{"exactly 1080p", 1920, 1080, 0, defaultBitrate1080p},
		{"just above 1080p uses 1440p tier", 1920, 1081, 0, defaultBitrate1440p},
		{"exactly 1440p", 2560, 1440, 0, defaultBitrate1440p},
		{"just above 1440p uses 4K tier", 2560, 1441, 0, defaultBitrate4K},
		{"4K uses 4K tier", 3840, 2160, 0, defaultBitrate4K},
		{"5K uses 4K tier", 5120, 2880, 0, defaultBitrate4K},
		{"override beats 1080p default", 1920, 1080, 25_000_000, 25_000_000},
		{"override beats 4K default", 3840, 2160, 12_000_000, 12_000_000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ceilingForResolution(tt.w, tt.h, tt.override); got != tt.want {
				t.Errorf("ceilingForResolution(%d, %d, override=%d) = %d, want %d",
					tt.w, tt.h, tt.override, got, tt.want)
			}
		})
	}
}

func TestResolutionLadderRaisedAboveLegacyCap(t *testing.T) {
	// Regression guard for #1410: the previous ceiling above 1080p was a flat
	// 15 Mbps, which throttled 1440p/4K screen content. Both higher tiers must
	// now exceed that legacy cap.
	const legacyCap = 15_000_000
	if defaultBitrate1440p <= legacyCap {
		t.Errorf("1440p ceiling %d must exceed legacy %d", defaultBitrate1440p, legacyCap)
	}
	if defaultBitrate4K <= legacyCap {
		t.Errorf("4K ceiling %d must exceed legacy %d", defaultBitrate4K, legacyCap)
	}
}

func TestParseBitrateOverride(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want int
	}{
		{"empty", "", 0},
		{"whitespace only", "   ", 0},
		{"non-integer", "fast", 0},
		{"float not accepted", "10.5", 0},
		{"below floor ignored", "500000", 0},
		{"above ceiling ignored", "999000000", 0},
		{"valid mid-range", "30000000", 30_000_000},
		{"valid at floor", "1000000", absoluteBitrateFloor},
		{"valid at ceiling", "200000000", absoluteBitrateCeiling},
		{"trimmed", "  40000000 ", 40_000_000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseBitrateOverride(tt.raw); got != tt.want {
				t.Errorf("parseBitrateOverride(%q) = %d, want %d", tt.raw, got, tt.want)
			}
		})
	}
}

func TestViewerHardCap(t *testing.T) {
	tests := []struct {
		name     string
		override int
		want     int
	}{
		{"no override defaults to 4K ceiling", 0, defaultBitrate4K},
		{"override takes precedence", 35_000_000, 35_000_000},
		{"override below default still wins", 10_000_000, 10_000_000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := viewerHardCap(tt.override); got != tt.want {
				t.Errorf("viewerHardCap(%d) = %d, want %d", tt.override, got, tt.want)
			}
		})
	}
}

func TestViewerHardCapAboveLegacy(t *testing.T) {
	// The viewer set_bitrate control path was previously hard-capped at 20 Mbps,
	// silently truncating higher 4K quality requests (#1410). The default cap
	// (no override) must now allow the full 4K ceiling.
	const legacyControlCap = 20_000_000
	if defaultBitrate4K <= legacyControlCap {
		t.Errorf("default viewer hard cap %d must exceed legacy control cap %d",
			defaultBitrate4K, legacyControlCap)
	}
}
