package desktop

import (
	"log/slog"
	"math"
	"os"
	"strconv"
	"strings"
	"sync"
)

// Resolution-based default ceilings for the adaptive bitrate controller.
//
// The stream always adapts *downward* to network conditions (see adaptive.go);
// these values are the upper bound it may ramp up to on a healthy link with a
// hardware encoder. They are deliberately conservative so that an unconfigured
// agent on a WAN link does not try to saturate a thin uplink, but they are high
// enough that 1440p/4K screen content stays sharp on a LAN/fiber deployment.
//
// Operators on high-bandwidth networks can raise the ceiling (or lower it for
// constrained WAN) with BREEZE_REMOTE_DESKTOP_MAX_MBPS — see resolveMaxBitrate.
const (
	// defaultMaxBitrateHD is the ceiling at or below 1080p.
	defaultMaxBitrateHD = 10_000_000
	// defaultMaxBitrateHiRes is the ceiling above 1080p (1440p / 4K). Raised
	// from the historical 15 Mbps, which was the limiting factor for 4K
	// sharpness well before the network was (see issue #1410).
	defaultMaxBitrateHiRes = 25_000_000

	// minConfiguredMaxBitrate / maxConfiguredMaxBitrate bound an operator's
	// BREEZE_REMOTE_DESKTOP_MAX_MBPS override so a typo cannot starve the
	// stream (too low) or hand a single session an absurd ceiling (too high).
	minConfiguredMaxBitrate = 1_000_000   // 1 Mbps
	maxConfiguredMaxBitrate = 200_000_000 // 200 Mbps

	// maxBitrateEnvVar is the operator override for the adaptive ceiling,
	// expressed in Mbps (whole or fractional, e.g. "50" or "1.5").
	maxBitrateEnvVar = "BREEZE_REMOTE_DESKTOP_MAX_MBPS"
)

// hiResPixels is the pixel-count threshold above which the hi-res ceiling
// applies (anything larger than 1920x1080).
const hiResPixels = 1920 * 1080

var (
	envCeilingOnce sync.Once
	// envCeiling is the operator-configured ceiling in bits/sec, or 0 when the
	// env var is unset/invalid (resolved once, since env vars are immutable for
	// the agent process lifetime).
	envCeiling int
)

// configuredMaxBitrate returns the operator-configured ceiling in bits/sec, or
// 0 when BREEZE_REMOTE_DESKTOP_MAX_MBPS is unset/blank/invalid. An out-of-range
// or unparseable value is reported (warning) and ignored rather than silently
// applied, so a misconfiguration is visible in the agent log instead of quietly
// degrading or over-driving the stream.
func configuredMaxBitrate() int {
	envCeilingOnce.Do(func() {
		raw := strings.TrimSpace(os.Getenv(maxBitrateEnvVar))
		if raw == "" {
			return
		}
		mbps, err := strconv.ParseFloat(raw, 64)
		// ParseFloat accepts the literals "NaN"/"Inf" with err==nil; reject them
		// here so they get the accurate "invalid" message rather than falling
		// through to the out-of-range branch with garbage after int() conversion.
		if err != nil || math.IsNaN(mbps) || math.IsInf(mbps, 0) || mbps <= 0 {
			slog.Warn("Ignoring invalid "+maxBitrateEnvVar+" (expected a positive number of Mbps)",
				"value", raw)
			return
		}
		bps := int(mbps * 1_000_000)
		if bps < minConfiguredMaxBitrate || bps > maxConfiguredMaxBitrate {
			slog.Warn("Ignoring out-of-range "+maxBitrateEnvVar,
				"value", raw,
				"minMbps", minConfiguredMaxBitrate/1_000_000,
				"maxMbps", maxConfiguredMaxBitrate/1_000_000)
			return
		}
		envCeiling = bps
		slog.Info("Remote-desktop adaptive bitrate ceiling overridden by operator",
			"maxMbps", mbps)
	})
	return envCeiling
}

// resolveMaxBitrate returns the adaptive bitrate ceiling (bits/sec) for a stream
// of the given dimensions. When the operator has set a valid
// BREEZE_REMOTE_DESKTOP_MAX_MBPS it takes precedence at every resolution;
// otherwise the resolution-based default applies.
//
// This is the single source of truth for the ceiling — session start
// (session_webrtc.go), hardware-encoder swap (session_capture.go), and
// hardware-encoder restore (session_encoder_restore.go) all call it so they can
// never drift apart.
func resolveMaxBitrate(w, h int) int {
	if configured := configuredMaxBitrate(); configured > 0 {
		return configured
	}
	if w*h > hiResPixels {
		return defaultMaxBitrateHiRes
	}
	return defaultMaxBitrateHD
}
