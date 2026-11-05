package agentapp

import (
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/logging"
)

// wsReconnectConfig maps ws_first_reconnect_window_seconds to
// websocket.Config.FirstReconnectWindow. It is always non-nil: the config
// layer has already applied the default and the 0..300 bounds, and a nil
// pointer would mean "websocket default", which would hide an operator's
// explicit 0 (the 1-5 s spread of #9145).
func wsReconnectConfig(cfg *config.Config) *time.Duration {
	d := time.Duration(cfg.WsFirstReconnectWindowSeconds) * time.Second
	return &d
}

// applyRetryAfterSettings applies loop_retry_after to both copies of the
// loop-level Retry-After switch (httputil and the log shipper, which cannot
// share one for import-cycle reasons). It must run before anything that uses
// httputil.Do or the shipper starts.
func applyRetryAfterSettings(cfg *config.Config) {
	httputil.SetLoopRetryAfter(cfg.LoopRetryAfter)
	logging.SetLoopRetryAfter(cfg.LoopRetryAfter)
	log.Info("reconnect settings applied",
		"loopRetryAfter", cfg.LoopRetryAfter,
		"wsFirstReconnectWindowSeconds", cfg.WsFirstReconnectWindowSeconds)
}
