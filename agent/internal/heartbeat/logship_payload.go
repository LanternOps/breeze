package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

// LogShippingPayload is the agent's log-shipping health in the heartbeat
// (#8406 / #8610). Its shape must match the API's strict parse
// (apps/api/src/services/logShippingHealth.ts `reportSchema`): a mismatch is
// classified `invalid` and changes nothing server-side. Optional fields are
// omitted, never null.
//
// Only the main agent's shipper is reported; helper processes run their own
// shippers and do not own device-level shipping health.
type LogShippingPayload struct {
	SchemaVersion int `json:"schemaVersion"`
	// Diagnostics only: the API classifies on LastAttemptOk, never on agent
	// timestamps (agent clock skew).
	LastAttemptAt string `json:"lastAttemptAt,omitempty"`
	LastSuccessAt string `json:"lastSuccessAt,omitempty"`
	// LastAttemptOk is the outcome of the last completed attempt; absent when
	// there is none or it is older than the shipper's 10-minute expiry.
	LastAttemptOk *bool  `json:"lastAttemptOk,omitempty"`
	LastError     string `json:"lastError,omitempty"`
	// Required by the API even when zero, so no omitempty.
	QueueDepth  int   `json:"queueDepth"`
	DroppedLogs int64 `json:"droppedLogs"`
}

// API zod bounds; a value above them would make the whole object invalid.
const (
	logShippingSchemaVersion = 1
	maxWireQueueDepth        = 1_000_000
	maxWireDroppedLogs       = 1_000_000_000
	maxWireLastErrorBytes    = 160
)

// Seams for tests: the shipper's dropped counter is unexported.
var (
	logShippingSnapshot   = logging.LogShippingSnapshot
	commitDroppedLogCount = logging.CommitDroppedLogCount
)

// attachLogShipping sets the nested logShipping object and the legacy
// top-level droppedLogs from ONE snapshot, so both carry the same pre-commit
// value. No shipper → both absent (unknown, never healthy).
func attachLogShipping(payload *HeartbeatPayload) {
	snap := logShippingSnapshot()
	if !snap.Initialized {
		return
	}
	// Top-level droppedLogs is kept one more release for rollback safety
	// (unread by the API); remove it in a follow-up.
	if snap.Dropped > 0 {
		payload.DroppedLogs = snap.Dropped
	}
	payload.LogShipping = buildLogShippingPayload(snap)
}

func buildLogShippingPayload(snap logging.HealthSnapshot) *LogShippingPayload {
	p := &LogShippingPayload{
		SchemaVersion: logShippingSchemaVersion,
		LastAttemptAt: wireTime(snap.LastAttemptAt),
		LastSuccessAt: wireTime(snap.LastSuccessAt),
		QueueDepth:    min(max(snap.QueueDepth, 0), maxWireQueueDepth),
		DroppedLogs:   min(max(snap.Dropped, 0), maxWireDroppedLogs),
	}
	if snap.LastAttemptOk != nil {
		ok := *snap.LastAttemptOk
		p.LastAttemptOk = &ok
		if !ok {
			p.LastError = snap.LastError
			if len(p.LastError) > maxWireLastErrorBytes {
				p.LastError = p.LastError[:maxWireLastErrorBytes]
			}
		}
	}
	return p
}

func wireTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}
