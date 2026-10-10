package heartbeat

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// Bounds of the API schema for a summary (agentWs.ts desktopCommandResultSchema):
// two directions × three content types, and per-counter maxima. Counters are
// saturated to them, never sent over: the API rejects the whole summary on any
// out-of-range value, so a viewer spamming blocked frames could otherwise
// erase the session's audit row.
const (
	maxClipboardSummaryEntries = 6
	maxClipboardSummaryCount   = 1_000_000
	maxClipboardSummaryBytes   = 1_000_000_000_000
)

// forwardDesktopClipboardSummary sends an accepted helper report on to the
// API. A var so tests can observe what the IPC handler accepted.
var forwardDesktopClipboardSummary = (*Heartbeat).sendDesktopClipboardSummary

var (
	clipboardSummaryDirections = map[string]bool{"host_to_viewer": true, "viewer_to_host": true}
	clipboardSummaryTypes      = map[string]bool{"text": true, "rtf": true, "image": true}
	// clipboardSegmentIDPattern matches the API schema's segmentId.
	clipboardSegmentIDPattern = regexp.MustCompile(`^[0-9a-f]{16,64}$`)
)

func newClipboardSegmentID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// desktopOwnerTombstoneTTL is how long an ended desktop session still accepts
// its former helper's teardown report. A var so tests can shorten it.
var desktopOwnerTombstoneTTL = 2 * time.Minute

type desktopOwnerTombstone struct {
	endedAt time.Time
}

// desktopOwnerKey keys a tombstone by session and helper: after a session
// switch the session has a new owner while the previous helper's teardown
// report is still on its way.
func desktopOwnerKey(desktopSessionID, helperSessionID string) string {
	return desktopSessionID + "\x00" + helperSessionID
}

func (h *Heartbeat) tombstoneDesktopOwner(desktopSessionID string, owner any) {
	if helper, ok := owner.(string); ok && helper != "" {
		h.endedDesktopOwners.Store(desktopOwnerKey(desktopSessionID, helper), desktopOwnerTombstone{endedAt: time.Now()})
	}
}

// desktopOwnerMatches reports whether helperSessionID owns desktopSessionID,
// or owned it until it ended (or was handed to another helper) within
// desktopOwnerTombstoneTTL. Stops and peer disconnects forget the owner as
// soon as they happen, but the helper's clipboard summary is sent from
// session teardown and can arrive after that.
func (h *Heartbeat) desktopOwnerMatches(desktopSessionID, helperSessionID string) bool {
	if desktopSessionID == "" || helperSessionID == "" {
		return false
	}
	if owner, ok := h.desktopOwners.Load(desktopSessionID); ok && owner == helperSessionID {
		return true
	}
	key := desktopOwnerKey(desktopSessionID, helperSessionID)
	v, ok := h.endedDesktopOwners.Load(key)
	if !ok {
		return false
	}
	ts, ok := v.(desktopOwnerTombstone)
	if !ok || time.Since(ts.endedAt) > desktopOwnerTombstoneTTL {
		h.endedDesktopOwners.Delete(key)
		return false
	}
	return true
}

// consumeEndedDesktopOwner drops a helper's tombstone for a session once its
// teardown report has been accepted: a helper's Session sends exactly one.
func (h *Heartbeat) consumeEndedDesktopOwner(desktopSessionID, helperSessionID string) {
	h.endedDesktopOwners.Delete(desktopOwnerKey(desktopSessionID, helperSessionID))
}

// sweepEndedDesktopOwners drops expired tombstones. Most sessions never send a
// report, so a tombstone is usually never looked up again.
func (h *Heartbeat) sweepEndedDesktopOwners() {
	h.endedDesktopOwners.Range(func(key, value any) bool {
		if ts, ok := value.(desktopOwnerTombstone); !ok || time.Since(ts.endedAt) > desktopOwnerTombstoneTTL {
			h.endedDesktopOwners.Delete(key)
		}
		return true
	})
}

// desktopClipboardSummaryPayload builds the `result` of the desk-clipsum
// command_result. Entries the API does not declare are dropped and negative
// counters clamped, because its .strict() schema would otherwise reject the
// whole summary.
func desktopClipboardSummaryPayload(sessionID string, in ipc.ClipboardSummary) map[string]any {
	out := ipc.ClipboardSummary{
		Transfers: make([]ipc.ClipboardTransferCount, 0, len(in.Transfers)),
		Blocked:   min(max(in.Blocked, 0), maxClipboardSummaryCount),
		SegmentID: in.SegmentID,
	}
	// The API records one row per segment and rejects a malformed id; a
	// report without a usable one is still its own segment.
	if !clipboardSegmentIDPattern.MatchString(out.SegmentID) {
		out.SegmentID = newClipboardSegmentID()
	}
	for _, t := range in.Transfers {
		if len(out.Transfers) == maxClipboardSummaryEntries {
			break
		}
		if !clipboardSummaryDirections[t.Direction] || !clipboardSummaryTypes[t.Type] {
			continue
		}
		t.Count = min(max(t.Count, 0), maxClipboardSummaryCount)
		t.Bytes = min(max(t.Bytes, 0), maxClipboardSummaryBytes)
		out.Transfers = append(out.Transfers, t)
	}
	return map[string]any{
		"sessionId": sessionID,
		"event":     "clipboard_summary",
		"clipboard": out,
	}
}

// sendDesktopClipboardSummary reports a desktop session's clipboard traffic to
// the API, which records it as one audit row (#1012). It is its own message
// rather than a field on desk-disconnect: the API's result schema is strict,
// so an older API would otherwise drop the disconnect itself. An older API
// drops this one, with no effect on the session.
func (h *Heartbeat) sendDesktopClipboardSummary(sessionID string, summary ipc.ClipboardSummary) {
	if h.wsClient == nil {
		return
	}
	if !desktopSessionIDPattern.MatchString(sessionID) {
		log.Warn("refusing to send desktop clipboard summary with invalid session ID", "sessionId", sessionID)
		return
	}
	result := websocket.CommandResult{
		Type:      "command_result",
		CommandID: "desk-clipsum-" + sessionID,
		Status:    "completed",
		Result:    desktopClipboardSummaryPayload(sessionID, summary),
	}
	if err := h.wsClient.SendResult(result); err != nil {
		log.Warn("failed to send desktop clipboard summary", "session", sessionID, "error", err.Error())
	}
}
