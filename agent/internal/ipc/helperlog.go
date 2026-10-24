package ipc

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// TypeHelperLog relays one warn+ log record from a helper that has no log
// shipper of its own to the agent, which logs it so it reaches Agent Logs
// (#9266). helper -> agent, fire-and-forget, never answered.
//
// The Windows helpers are the reason: no user-readable file carries the
// helper token, so they cannot ship directly, and the user-role helper cannot
// even write the shared log directory. Without the relay their warnings —
// "WinRT toast failed", "toast notifications are disabled" — were readable
// nowhere.
const TypeHelperLog = "helper_log"

// Bounds a HelperLogRecord is held to on both sides of the IPC boundary. The
// agent re-applies them: the record comes from a process running with the
// logged-in user's token, so it is untrusted input.
const (
	MaxHelperLogMessageBytes    = 1024
	MaxHelperLogComponentBytes  = 64
	MaxHelperLogFields          = 16
	MaxHelperLogFieldKeyBytes   = 64
	MaxHelperLogFieldValueBytes = 512
)

const helperLogTruncSuffix = "...[truncated]"

// HelperLogRecord is the TypeHelperLog payload.
type HelperLogRecord struct {
	Time      time.Time         `json:"time"`
	Level     string            `json:"level"` // "warn" or "error"
	Component string            `json:"component,omitempty"`
	Message   string            `json:"message"`
	Fields    map[string]string `json:"fields,omitempty"`
	// Dropped is how many records the helper discarded (queue full or a
	// failed send) since the last one it delivered.
	Dropped uint64 `json:"dropped,omitempty"`
}

// SanitizeHelperLogRecord normalises the level and truncates every string to
// its bound. ok is false when the level is anything but warn or error: only
// warn+ crosses the boundary, so the relay can never become a chatty channel.
func SanitizeHelperLogRecord(rec HelperLogRecord) (HelperLogRecord, bool) {
	rec.Level = strings.ToLower(strings.TrimSpace(rec.Level))
	if rec.Level != "warn" && rec.Level != "error" {
		return HelperLogRecord{}, false
	}
	rec.Message = truncateHelperLog(rec.Message, MaxHelperLogMessageBytes, true)
	rec.Component = truncateHelperLog(rec.Component, MaxHelperLogComponentBytes, false)
	if len(rec.Fields) > 0 {
		keys := make([]string, 0, len(rec.Fields))
		for k := range rec.Fields {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if len(keys) > MaxHelperLogFields {
			keys = keys[:MaxHelperLogFields]
		}
		fields := make(map[string]string, len(keys))
		for _, k := range keys {
			key := truncateHelperLog(k, MaxHelperLogFieldKeyBytes, false)
			if key == "" {
				continue
			}
			fields[key] = truncateHelperLog(rec.Fields[k], MaxHelperLogFieldValueBytes, true)
		}
		rec.Fields = fields
	}
	return rec, true
}

// Rate cap on relayed helper records, applied by the helper before sending
// and again by the agent per session: a burst of HelperLogBurst, then one per
// HelperLogRefill (20/minute sustained). Generous for real warnings, small
// enough that a helper stuck in a loop can neither crowd the IPC connection
// nor flood Agent Logs.
const (
	HelperLogBurst  = 20
	HelperLogRefill = 3 * time.Second
)

// HelperLogCap is a token bucket that also counts what it refused, so the
// next admitted record can say how many were lost. Safe for concurrent use.
type HelperLogCap struct {
	mu      sync.Mutex
	tokens  float64
	last    time.Time
	dropped uint64
}

// NewHelperLogCap returns a full bucket as of now.
func NewHelperLogCap(now time.Time) *HelperLogCap {
	return &HelperLogCap{tokens: HelperLogBurst, last: now}
}

// Allow reports whether a record may pass at now and, when it may, how many
// were refused since the last one that passed. A clock that steps backwards
// mints nothing.
func (c *HelperLogCap) Allow(now time.Time) (bool, uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if elapsed := now.Sub(c.last); elapsed > 0 {
		c.tokens += float64(elapsed) / float64(HelperLogRefill)
		if c.tokens > HelperLogBurst {
			c.tokens = HelperLogBurst
		}
		c.last = now
	}
	if c.tokens < 1 {
		c.dropped++
		return false, 0
	}
	c.tokens--
	dropped := c.dropped
	c.dropped = 0
	return true, dropped
}

// truncateHelperLog cuts s to max bytes without splitting a UTF-8 sequence.
// marked appends a visible suffix (beyond max) so a cut message is not
// mistaken for the whole one; keys and components are cut silently.
func truncateHelperLog(s string, max int, marked bool) string {
	if len(s) <= max {
		return strings.ToValidUTF8(s, "?")
	}
	cut := strings.ToValidUTF8(s[:max], "")
	if marked {
		return cut + helperLogTruncSuffix
	}
	return cut
}
