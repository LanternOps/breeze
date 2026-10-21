package sessionbroker

import (
	"encoding/json"
	"log/slog"
	"sort"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

// helperLogRelay is the logger relayed helper records are written through.
// Its component is "helper", never the helper's own: the record comes from a
// process running with the logged-in user's token, and must not be able to
// pass itself off as an agent component. The helper's component rides along
// as helperComponent.
var helperLogRelay = logging.L("helper")

// helperLogNow is the relay cap's clock; a var so tests can step it.
var helperLogNow = time.Now

// helperLogLimiter returns the session's relay cap, creating it on first use.
func (s *Session) helperLogLimiter() *ipc.HelperLogCap {
	s.helperLogOnce.Do(func() { s.helperLog = ipc.NewHelperLogCap(helperLogNow()) })
	return s.helperLog
}

// relayHelperLog writes a helper's forwarded warn+ record into the agent's
// own log, which ships it to Agent Logs (#9266). Malformed, sub-warn and
// over-cap records are dropped at Debug or silently: a warn here would be the
// flood the cap exists to prevent. The drop count rides on the next record
// that passes.
func (b *Broker) relayHelperLog(s *Session, env *ipc.Envelope) {
	var raw ipc.HelperLogRecord
	if err := json.Unmarshal(env.Payload, &raw); err != nil {
		log.Debug("invalid helper_log payload", "sessionId", s.SessionID, "error", err.Error())
		return
	}
	rec, ok := ipc.SanitizeHelperLogRecord(raw)
	if !ok {
		log.Debug("dropping helper_log below warn", "sessionId", s.SessionID, "level", raw.Level)
		return
	}
	allowed, droppedByAgent := s.helperLogLimiter().Allow(helperLogNow())
	if !allowed {
		return
	}

	attrs := []any{
		"helperSessionId", s.SessionID,
		"helperRole", string(s.HelperRole),
	}
	if rec.Component != "" {
		attrs = append(attrs, "helperComponent", rec.Component)
	}
	if !rec.Time.IsZero() {
		attrs = append(attrs, "helperTime", rec.Time.UTC().Format(time.RFC3339Nano))
	}
	if rec.Dropped > 0 {
		attrs = append(attrs, "droppedByHelper", rec.Dropped)
	}
	if droppedByAgent > 0 {
		attrs = append(attrs, "droppedByAgent", droppedByAgent)
	}
	if len(rec.Fields) > 0 {
		keys := make([]string, 0, len(rec.Fields))
		for k := range rec.Fields {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		group := make([]any, 0, len(keys))
		for _, k := range keys {
			group = append(group, slog.String(k, rec.Fields[k]))
		}
		attrs = append(attrs, slog.Group("helperFields", group...))
	}

	if rec.Level == "error" {
		helperLogRelay.Error(rec.Message, attrs...)
		return
	}
	helperLogRelay.Warn(rec.Message, attrs...)
}
