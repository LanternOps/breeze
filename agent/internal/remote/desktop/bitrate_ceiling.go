package desktop

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
)

// Bitrate ceilings for the WebRTC remote-desktop stream.
//
// The adaptive controller (adaptive.go) always ramps the stream UP toward a
// ceiling and DOWN under network pressure; these constants set how high it is
// allowed to ramp. They are intentionally generous for screen content on
// hardware encoders (AMF/NVENC/VideoToolbox sustain these without stalling) —
// CapForSoftwareEncoder() separately clamps software backends to 4 Mbps.
//
// Defaults were raised for #1410: the previous 15 Mbps ceiling above 1080p was
// the limiting factor for sharpness on 1440p/4K screen content well before the
// network was. The numbers below track typical "good" H.264 screen-content
// rates: ~8 Mbps @ 1080p, ~30 Mbps @ 1440p, ~50 Mbps @ 4K.
const (
	defaultBitrate1080p = 8_000_000  // ≤ 1920×1080
	defaultBitrate1440p = 30_000_000 // ≤ 2560×1440
	defaultBitrate4K    = 50_000_000 // > 1440p (4K and beyond)

	// pixels1080p / pixels1440p are the inclusive upper pixel-count bounds for
	// each tier. A resolution at or below the bound uses that tier's ceiling.
	pixels1080p = 1920 * 1080
	pixels1440p = 2560 * 1440

	// envMaxBitrate lets an operator override the resolution-derived ceiling
	// with a single absolute cap (in bits per second). This is the
	// "configurable ceiling" half of #1410: defaults stay conservative enough
	// for WAN, while LAN/fiber deployments can raise (or lower) the cap without
	// a rebuild. When unset or invalid the resolution defaults apply.
	envMaxBitrate = "BREEZE_REMOTE_MAX_BITRATE_BPS"

	// absoluteBitrateFloor / absoluteBitrateCeiling bound any operator-supplied
	// override so a typo can't drive the encoder to a degenerate value. 1 Mbps
	// is the lowest sane screen-share rate; 200 Mbps comfortably covers 4K
	// high-motion with headroom while preventing absurd values.
	absoluteBitrateFloor   = 1_000_000   // 1 Mbps
	absoluteBitrateCeiling = 200_000_000 // 200 Mbps
)

var (
	bitrateOverrideOnce sync.Once
	bitrateOverrideBps  int // 0 = no valid override configured
)

// loadBitrateOverride parses BREEZE_REMOTE_MAX_BITRATE_BPS once and caches the
// result (the env value is fixed for the process lifetime).
func loadBitrateOverride() int {
	bitrateOverrideOnce.Do(func() {
		bitrateOverrideBps = parseBitrateOverride(os.Getenv(envMaxBitrate))
	})
	return bitrateOverrideBps
}

// parseBitrateOverride validates a raw BREEZE_REMOTE_MAX_BITRATE_BPS value,
// clamping it to the sane [floor, ceiling] band. Invalid, empty, or
// out-of-range values return 0 (logged) so callers fall back to the
// resolution-based defaults. Split out from loadBitrateOverride so it is
// testable without the process-lifetime sync.Once cache.
func parseBitrateOverride(raw string) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		slog.Warn("Ignoring invalid "+envMaxBitrate+" (not an integer)", "value", raw, "error", err.Error())
		return 0
	}
	if v < absoluteBitrateFloor || v > absoluteBitrateCeiling {
		slog.Warn("Ignoring out-of-range "+envMaxBitrate,
			"value", v, "min", absoluteBitrateFloor, "max", absoluteBitrateCeiling)
		return 0
	}
	slog.Info("Remote-desktop max bitrate overridden by env", "bps", v)
	return v
}

// resolutionBitrateCeiling returns the adaptive-controller ceiling (in bps) for
// a stream of the given pixel dimensions. An operator override
// (BREEZE_REMOTE_MAX_BITRATE_BPS), when set, takes precedence over the
// resolution-derived default at every resolution.
//
// This is the single source of truth for the ceiling — StartSession and both
// hardware-encoder restore paths call it so they can never drift apart (they
// previously each inlined the same 8/15 Mbps ladder).
func resolutionBitrateCeiling(w, h int) int {
	return ceilingForResolution(w, h, loadBitrateOverride())
}

// ceilingForResolution is the pure core of resolutionBitrateCeiling, split out
// so it can be tested across the resolution ladder and the override branch
// without touching the process env / sync.Once cache.
func ceilingForResolution(w, h, override int) int {
	if override > 0 {
		return override
	}
	pixels := w * h
	switch {
	case pixels <= pixels1080p:
		return defaultBitrate1080p
	case pixels <= pixels1440p:
		return defaultBitrate1440p
	default:
		return defaultBitrate4K
	}
}

// viewerBitrateHardCap is the absolute ceiling the viewer's `set_bitrate`
// control message may request. It honors the operator override when set so a
// quality slider in the viewer can climb to whatever the operator allows;
// otherwise it defaults to the 4K ceiling. Keeping this in sync with
// resolutionBitrateCeiling means a viewer can request the full 4K rate (the
// previous hard 20 Mbps cap silently truncated 4K requests — #1410).
func viewerBitrateHardCap() int {
	if override := loadBitrateOverride(); override > 0 {
		return override
	}
	return defaultBitrate4K
}
