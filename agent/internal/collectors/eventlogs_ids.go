package collectors

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"unicode/utf8"
)

// Event-log ids for the Linux and macOS collectors.
//
// The API stores events behind a unique index on (device_id, source,
// event_id) and inserts with ON CONFLICT DO NOTHING
// (apps/api/src/routes/agents/eventlogs.ts), so an id must be:
//   - unique per log entry, or every later entry that shares it is dropped
//     (#10731: source+PID ids lost all but the first event of a daemon);
//   - stable across re-collection of the same entry, so overlapping windows
//     and retry passes still deduplicate;
//   - at most 100 characters (device_event_logs.event_id is varchar(100); a
//     longer value fails the whole insert batch);
//   - non-numeric before the first ':', because numericEventID (reliability.go)
//     and the API's numericEventIdPrefix read that segment as a Windows event id.
//
// Ids therefore keep a readable "<source>:<pid>" head and end in a short hash
// of the source's own per-entry identity (journald cursor, unified-log mach
// timestamp/thread/trace id).

// eventLogIDMaxLen mirrors device_event_logs.event_id varchar(100). Postgres
// counts characters, not bytes, for varchar(n).
const eventLogIDMaxLen = 100

// eventLogIDHashLen is the hex length of the per-entry hash suffix (64 bits).
const eventLogIDHashLen = 16

// eventLogIDHash hashes the parts with a separator so ("ab","c") and
// ("a","bc") differ.
func eventLogIDHash(parts ...string) string {
	h := sha256.New()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:eventLogIDHashLen]
}

// entryEventID returns "<head>:<hash(keyParts)>", bounded to eventLogIDMaxLen.
func entryEventID(head string, keyParts ...string) string {
	return boundEventID(head + ":" + eventLogIDHash(keyParts...))
}

// boundEventID strips control characters (Postgres rejects NUL in text, and
// a raw unified-log subsystem/image path is not pre-cleaned), then returns
// the id unchanged when it is valid UTF-8 and fits the API column. Otherwise
// it keeps a rune-safe prefix and appends a hash of the full id, so two long
// ids that share a prefix stay distinct and the result is deterministic.
func boundEventID(id string) string {
	id = stripCollectorControlChars(id)
	if utf8.ValidString(id) && utf8.RuneCountInString(id) <= eventLogIDMaxLen {
		return id
	}
	suffix := ":" + eventLogIDHash(id)
	keep := eventLogIDMaxLen - len(suffix)
	clean := strings.ToValidUTF8(id, "")
	var b strings.Builder
	n := 0
	for _, r := range clean {
		if n == keep {
			break
		}
		b.WriteRune(r)
		n++
	}
	return b.String() + suffix
}

// journalEntryEventID builds the id for a journald entry. __CURSOR uniquely
// and stably identifies an entry in the journal; it is too long (~130 chars)
// to store, so it is hashed. Without a cursor (never expected from
// journalctl --output=json) fall back to the entry's own content.
func journalEntryEventID(head string, e journalEntry) string {
	if e.Cursor != "" {
		return entryEventID(head, e.Cursor)
	}
	return entryEventID(head, "nocursor", e.BootID, e.RealtimeTimestamp, e.PID, e.Message)
}

// rawJSONScalar renders an identity field captured as json.RawMessage; an
// absent or null field is "".
func rawJSONScalar(raw []byte) string {
	s := strings.TrimSpace(string(raw))
	if s == "null" {
		return ""
	}
	return s
}

// unifiedLogEntryEventID builds the id for a `log show --style json` entry.
// The mach timestamp is per-boot monotonic, so (bootUUID, machTimestamp,
// threadID, traceID) identifies one entry. The wall-clock timestamp string is
// only used when the mach timestamp is missing, since it is rendered in the
// device's local zone and would change if the zone changed between passes.
func unifiedLogEntryEventID(head string, e unifiedLogEntry) string {
	mach := rawJSONScalar(e.MachTimestamp)
	wall := ""
	if mach == "" {
		wall = e.Timestamp
	}
	return entryEventID(head,
		rawJSONScalar(e.BootUUID), mach, wall,
		rawJSONScalar(e.ThreadID), rawJSONScalar(e.TraceID),
		e.EventMessage,
	)
}

// crashReportEventID builds the id for a DiagnosticReports file. The file
// name already carries the report's own timestamp
// (<process>-YYYY-MM-DD-HHMMSS.ips), so it is unique per report; it is only
// bounded so a long process name cannot exceed the API column.
func crashReportEventID(fileName string) string {
	return boundEventID("crash:" + fileName)
}
