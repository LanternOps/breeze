package desktop

import (
	"context"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

// pion logs through its own LoggerFactory, which by default writes to stderr
// and only at Error unless PION_LOG_WARN/PION_LOG_* is set in the process
// environment. A service has no visible stderr, so a TURN Allocate failure —
// logged by pion at Warn — was invisible in the field (#8980, #9182). This
// factory routes pion into the agent's slog instead:
//
//   - Error → slog.Warn, always (rare, and always worth shipping);
//   - Warn  → slog.Warn when desktop_debug is on, slog.Debug otherwise (pion
//     warns are chatty during normal ICE churn);
//   - Info and below → dropped.

var pionWarnElevated atomic.Bool

// SetPionWarnLogging elevates pion's Warn-level messages to the agent's Warn
// level. Wired from `desktop_debug` in the agent and helper configs.
func SetPionWarnLogging(enabled bool) {
	pionWarnElevated.Store(enabled)
}

type pionLoggerFactory struct{}

func (pionLoggerFactory) NewLogger(scope string) logging.LeveledLogger {
	return pionLogger{scope: scope}
}

type pionLogger struct{ scope string }

func (l pionLogger) Trace(string)                  {}
func (l pionLogger) Tracef(string, ...interface{}) {}
func (l pionLogger) Debug(string)                  {}
func (l pionLogger) Debugf(string, ...interface{}) {}
func (l pionLogger) Info(string)                   {}
func (l pionLogger) Infof(string, ...interface{})  {}

func (l pionLogger) Warn(msg string) { l.warn(msg) }
func (l pionLogger) Warnf(format string, args ...interface{}) {
	l.warn(fmt.Sprintf(format, args...))
}

func (l pionLogger) Error(msg string) { l.error(msg) }
func (l pionLogger) Errorf(format string, args ...interface{}) {
	l.error(fmt.Sprintf(format, args...))
}

func (l pionLogger) warn(detail string) {
	level := slog.LevelDebug
	if pionWarnElevated.Load() {
		level = slog.LevelWarn
	}
	slog.Log(context.Background(), level, "pion warning", "scope", l.scope, "detail", detail)
}

func (l pionLogger) error(detail string) {
	slog.Warn("pion error", "scope", l.scope, "detail", detail)
}

// newDesktopSettingEngine is the pion SettingEngine every desktop peer
// connection uses: ICE timeouts tuned for screen sharing, mDNS off, and pion's
// logs routed into the agent log.
func newDesktopSettingEngine() webrtc.SettingEngine {
	se := webrtc.SettingEngine{}
	se.SetICETimeouts(
		5*time.Second,  // disconnectedTimeout — detect no-media quickly
		15*time.Second, // failedTimeout — reduced from 25s default for faster recovery
		2*time.Second,  // keepAliveInterval — refresh STUN bindings when no media
	)
	// pion promotes an unset mode to QueryOnly, which opens a multicast socket
	// in every session; on macOS that socket is in the user-session desktop
	// helper and can raise the Local Network privacy prompt (#12240). Our host
	// candidates were always plain IPs (only QueryAndGather publishes .local
	// names). A viewer's .local host candidates are now discarded instead of
	// resolved; on a LAN the session still connects because the viewer checks
	// our IP host candidates and we learn it as a peer-reflexive candidate.
	se.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	se.LoggerFactory = pionLoggerFactory{}
	return se
}
