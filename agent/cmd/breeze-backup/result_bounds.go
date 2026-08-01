package main

import (
	"encoding/json"
	"fmt"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

// Issue #3001: a backup run's terminal result is unbounded, but the IPC frame
// is not. A 123k-file run produced a 64 MB result against the 16 MiB
// ipc.MaxMessageSize cap; conn.Send rejected it, the result was dropped
// entirely, and the backup_jobs row stayed `running` until the stale-backup
// reaper failed it 15 minutes later — for a backup that had SUCCEEDED.
//
// The failure mode scales perversely: the bigger/worse a run goes, the more
// likely its outcome never arrives. So the terminal status is treated as the
// one thing that must always land. Everything else (per-file index, warning
// text, stderr detail) is dropped in tiers until the payload fits.
//
// Deliberately NOT fixed by raising ipc.MaxMessageSize: the payload has to be
// bounded regardless, and a bigger cap only moves the cliff.

const (
	// resultEnvelopeHeadroom reserves room for the ipc.Envelope fields wrapped
	// around the marshalled result payload (id, seq, type, hmac) plus slack.
	// Payload is a json.RawMessage, so the envelope adds those fields' bytes
	// without re-escaping the payload itself.
	resultEnvelopeHeadroom = 64 * 1024

	// resultPayloadBudget is the largest marshalled BackupCommandResult we will
	// hand to conn.Send.
	resultPayloadBudget = ipc.MaxMessageSize - resultEnvelopeHeadroom

	// maxResultTextBytes caps free-text fields (warning, stderr) that are built
	// by joining per-file errors. summarizeUploadFailures already caps the
	// number of detail entries it renders, but a hard-failed run routes
	// errors.Join(<every per-file error>) straight through fail(err.Error()),
	// which nothing bounds. Both land in DB text columns and the UI.
	maxResultTextBytes = 8 * 1024

	// maxLastResortFieldBytes bounds every string in the last-resort result so
	// the "always fits" postcondition is total, not merely likely.
	maxLastResortFieldBytes = 1024
)

// snapshotIdentityKeys are the snapshot fields kept when the per-file index is
// dropped: enough for the server to record a usable restore point
// (backupResultPersistence reads snapshot.id / .timestamp / .size).
var snapshotIdentityKeys = []string{"id", "timestamp", "size", "formatVersion", "baseSnapshotId"}

// resultIdentityKeys are the top-level result fields kept in the reduced tier —
// the terminal status and the counters the server persists. Notably errorCount
// survives even when every individual failure detail is gone.
var resultIdentityKeys = []string{
	"id", "jobId", "snapshotId", "status", "backupType",
	"startedAt", "completedAt",
	"filesBackedUp", "bytesBackedUp",
	"referencedFiles", "referencedBytes",
	"errorCount", "warning",
}

// fitBackupResultToIPC returns result bounded so its marshalled payload fits
// resultPayloadBudget, degrading in tiers and stopping at the first that fits:
//
//  1. always: truncate the free-text warning/stderr fields;
//  2. drop the per-file snapshot index (snapshot.files), keeping snapshot
//     identity — this is what actually blows the budget on a real run;
//  3. reduce stdout to the terminal-status identity fields only;
//  4. last resort: a hand-built minimal status object.
//
// The second return value describes what was dropped, and is "" when the result
// was already within budget. It is non-empty exactly when the caller should log
// loudly — a degraded result is a real (if survivable) loss of detail.
func fitBackupResultToIPC(result backupipc.BackupCommandResult) (backupipc.BackupCommandResult, string) {
	var notes []string

	// Tier 1 — always applied, and cheap (no JSON parse). Bounding the failure
	// detail BEFORE marshalling is the primary fix; the tiers below are the
	// defensive net behind it. Stderr is the unbounded one on this path: a hard
	// failure routes errors.Join(<every per-file error>) through
	// fail(err.Error()), which nothing caps.
	if truncated, dropped := truncateText(result.Stderr, maxResultTextBytes); dropped > 0 {
		result.Stderr = truncated
		notes = append(notes, fmt.Sprintf("stderr truncated (%d bytes dropped)", dropped))
	}
	if fits(result) {
		return result, joinNotes(notes)
	}

	// Tier 2 — drop the per-file snapshot index and cap the warning text. Only
	// reached when the result is actually oversize, so the ordinary path never
	// pays for parsing a multi-megabyte stdout.
	//
	// The index is dropped whole rather than truncated: the server sets
	// hasIndexedFiles from snapshot.files.length, so a partial index would
	// present as a complete browsable file list that is silently missing
	// entries.
	if stdout, warnDropped := boundStdoutWarning(result.Stdout); warnDropped > 0 {
		result.Stdout = stdout
		notes = append(notes, fmt.Sprintf("warning truncated (%d bytes dropped)", warnDropped))
	}
	if reduced, dropped, ok := dropSnapshotFiles(result.Stdout); ok {
		result.Stdout = reduced
		if dropped > 0 {
			notes = append(notes, fmt.Sprintf("snapshot file index dropped (%d entries, result exceeded the %d byte IPC limit)", dropped, ipc.MaxMessageSize))
		}
		if fits(result) {
			return result, joinNotes(notes)
		}
	}

	// Tier 3 — terminal status + counters only.
	if reduced, ok := reduceToIdentity(result.Stdout); ok {
		result.Stdout = reduced
		notes = append(notes, "result reduced to terminal status only")
		if fits(result) {
			return result, joinNotes(notes)
		}
	}

	// Tier 4 — last resort. Every field is bounded by construction, so this
	// always fits: a terminal status must land even when nothing else can.
	notes = append(notes, "result replaced with a minimal terminal status")
	result.Stdout = lastResortStdout(result.Stdout)
	result.Stderr, _ = truncateText(result.Stderr, maxLastResortFieldBytes)
	result.CommandID, _ = truncateText(result.CommandID, maxLastResortFieldBytes)
	return result, joinNotes(notes)
}

// sendBackupResult sends a terminal backup_result envelope, bounding the
// payload first so an oversize result degrades instead of being dropped.
//
// A dropped terminal result is invisible server-side — the job just stops
// reporting — so both the degradation and any residual send failure are logged
// at ERROR under component=backup, which puts them above the default warn
// log-shipping threshold and therefore on the server.
func sendBackupResult(conn *ipc.Conn, envelopeID string, result backupipc.BackupCommandResult) error {
	log := logging.L("backup")
	fitted, degraded := fitBackupResultToIPC(result)
	if degraded != "" {
		// Sizes are reported from the raw fields rather than a full marshal of
		// the original: re-marshalling tens of megabytes just to populate a log
		// field is not worth it at the tail of a backup run.
		log.Error("backup result payload exceeded the IPC limit and was degraded to fit",
			"commandId", result.CommandID,
			"degraded", degraded,
			"originalStdoutBytes", len(result.Stdout),
			"originalStderrBytes", len(result.Stderr),
			"sentBytes", marshalledSize(fitted),
			"limitBytes", ipc.MaxMessageSize,
		)
	}
	if err := conn.SendTyped(envelopeID, backupipc.TypeBackupResult, fitted); err != nil {
		log.Error("failed to send backup result — the job will have no terminal status server-side",
			"commandId", result.CommandID,
			"envelopeId", envelopeID,
			"sentBytes", marshalledSize(fitted),
			"error", err.Error(),
		)
		return err
	}
	return nil
}

// --- helpers ---

// fits reports whether result's marshalled payload is within budget. The raw
// text fields are checked first as a cheap lower bound — JSON string encoding
// never shrinks its input — so an oversize result is rejected without
// marshalling tens of megabytes on the endpoint.
func fits(result backupipc.BackupCommandResult) bool {
	if len(result.Stdout)+len(result.Stderr)+len(result.CommandID) > resultPayloadBudget {
		return false
	}
	return marshalledSize(result) <= resultPayloadBudget
}

// marshalledSize returns the marshalled byte length of result, or -1 when it
// cannot be marshalled at all (which conn.Send would reject anyway).
func marshalledSize(result backupipc.BackupCommandResult) int {
	data, err := json.Marshal(result)
	if err != nil {
		return -1
	}
	return len(data)
}

// truncateText clips s to at most max bytes on a UTF-8 rune boundary, returning
// the clipped string and how many bytes were dropped. The head is kept: for a
// joined per-file error list the first entries are the representative sample.
func truncateText(s string, max int) (string, int) {
	if len(s) <= max {
		return s, 0
	}
	dropped := len(s) - max
	cut := max
	// Back off to a rune boundary so the field stays valid UTF-8 (invalid
	// UTF-8 would be re-encoded by json.Marshal as replacement chars).
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut] + fmt.Sprintf("… (+%d bytes truncated)", dropped), dropped
}

// utf8Start reports whether b can start a UTF-8 encoded rune (i.e. it is not a
// 10xxxxxx continuation byte).
func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// decodeStdoutObject parses stdout as a JSON object. Non-object stdout (a bare
// string, an array, a non-JSON blob) is left to the caller's fallback tiers.
func decodeStdoutObject(stdout string) (map[string]json.RawMessage, bool) {
	if stdout == "" {
		return nil, false
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stdout), &obj); err != nil || obj == nil {
		return nil, false
	}
	return obj, true
}

func encodeStdoutObject(obj map[string]json.RawMessage, fallback string) string {
	data, err := json.Marshal(obj)
	if err != nil {
		return fallback
	}
	return string(data)
}

// boundStdoutWarning truncates the result's `warning` field in place, returning
// the rewritten stdout and how many bytes were dropped.
func boundStdoutWarning(stdout string) (string, int) {
	obj, ok := decodeStdoutObject(stdout)
	if !ok {
		return stdout, 0
	}
	raw, present := obj["warning"]
	if !present {
		return stdout, 0
	}
	var warning string
	if err := json.Unmarshal(raw, &warning); err != nil {
		return stdout, 0
	}
	truncated, dropped := truncateText(warning, maxResultTextBytes)
	if dropped == 0 {
		return stdout, 0
	}
	obj["warning"] = mustRawString(truncated)
	return encodeStdoutObject(obj, stdout), dropped
}

// dropSnapshotFiles removes snapshot.files, keeping the snapshot's identity
// fields, and records the drop in the result's `warning` so it is visible
// server-side (the warning is persisted to the job's errorLog) rather than only
// in a log line on the endpoint. Reports the number of entries dropped and
// whether stdout was a JSON object at all.
func dropSnapshotFiles(stdout string) (string, int, bool) {
	obj, ok := decodeStdoutObject(stdout)
	if !ok {
		return stdout, 0, false
	}
	rawSnap, present := obj["snapshot"]
	if !present {
		return stdout, 0, true
	}
	var snap map[string]json.RawMessage
	if err := json.Unmarshal(rawSnap, &snap); err != nil || snap == nil {
		return stdout, 0, true
	}
	var files []json.RawMessage
	if raw, hasFiles := snap["files"]; hasFiles {
		if err := json.Unmarshal(raw, &files); err != nil {
			files = nil
		}
	}
	if len(files) == 0 {
		return stdout, 0, true
	}

	kept := make(map[string]json.RawMessage, len(snapshotIdentityKeys))
	for _, key := range snapshotIdentityKeys {
		if v, exists := snap[key]; exists {
			kept[key] = v
		}
	}
	rawKept, err := json.Marshal(kept)
	if err != nil {
		return stdout, 0, true
	}
	obj["snapshot"] = rawKept
	obj["warning"] = mustRawString(appendResultWarning(obj["warning"], fmt.Sprintf(
		"snapshot file index omitted (%d entries): the result exceeded the %d byte agent IPC limit, so per-file restore browsing is unavailable for this snapshot",
		len(files), ipc.MaxMessageSize)))
	return encodeStdoutObject(obj, stdout), len(files), true
}

// reduceToIdentity strips stdout down to the terminal-status identity fields.
func reduceToIdentity(stdout string) (string, bool) {
	obj, ok := decodeStdoutObject(stdout)
	if !ok {
		return stdout, false
	}
	kept := make(map[string]json.RawMessage, len(resultIdentityKeys)+1)
	for _, key := range resultIdentityKeys {
		if v, exists := obj[key]; exists {
			kept[key] = v
		}
	}
	// Keep the snapshot's identity — without it the server records no
	// providerSnapshotId and the successful run yields no restore point.
	if rawSnap, present := obj["snapshot"]; present {
		var snap map[string]json.RawMessage
		if err := json.Unmarshal(rawSnap, &snap); err == nil && snap != nil {
			identity := make(map[string]json.RawMessage, len(snapshotIdentityKeys))
			for _, key := range snapshotIdentityKeys {
				if v, exists := snap[key]; exists {
					identity[key] = v
				}
			}
			if rawIdentity, err := json.Marshal(identity); err == nil {
				kept["snapshot"] = rawIdentity
			}
		}
	}
	// A pathological identity field (e.g. a megabyte-long snapshot id) would
	// keep this tier over budget; bound every retained string.
	for key, raw := range kept {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			continue
		}
		if bounded, dropped := truncateText(s, maxResultTextBytes); dropped > 0 {
			kept[key] = mustRawString(bounded)
		}
	}
	return encodeStdoutObject(kept, stdout), true
}

// lastResortStdout builds a minimal terminal-status object from whatever can
// still be recovered from stdout. Every field is bounded by construction.
func lastResortStdout(stdout string) string {
	minimal := map[string]string{}
	if obj, ok := decodeStdoutObject(stdout); ok {
		for _, key := range []string{"id", "jobId", "status", "snapshotId"} {
			var s string
			if raw, exists := obj[key]; exists && json.Unmarshal(raw, &s) == nil {
				minimal[key], _ = truncateText(s, maxLastResortFieldBytes)
			}
		}
		if rawSnap, exists := obj["snapshot"]; exists {
			var snap struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(rawSnap, &snap) == nil && snap.ID != "" {
				minimal["snapshotId"], _ = truncateText(snap.ID, maxLastResortFieldBytes)
			}
		}
	}
	minimal["warning"] = fmt.Sprintf(
		"backup result exceeded the %d byte agent IPC limit and was reduced to a terminal status; detail was dropped",
		ipc.MaxMessageSize)
	data, err := json.Marshal(minimal)
	if err != nil {
		return `{"warning":"backup result could not be encoded"}`
	}
	return string(data)
}

// appendResultWarning appends fragment to an existing JSON-encoded warning,
// joining with "; " — mirroring the agent-side appendWarning convention.
func appendResultWarning(existing json.RawMessage, fragment string) string {
	var current string
	if len(existing) > 0 {
		_ = json.Unmarshal(existing, &current)
	}
	if current == "" {
		return fragment
	}
	bounded, _ := truncateText(current, maxResultTextBytes)
	return bounded + "; " + fragment
}

// mustRawString encodes s as a JSON string. json.Marshal of a string cannot
// fail, so the error branch is unreachable and returns a valid empty string.
func mustRawString(s string) json.RawMessage {
	data, err := json.Marshal(s)
	if err != nil {
		return json.RawMessage(`""`)
	}
	return data
}

func joinNotes(notes []string) string {
	switch len(notes) {
	case 0:
		return ""
	case 1:
		return notes[0]
	}
	out := notes[0]
	for _, n := range notes[1:] {
		out += "; " + n
	}
	return out
}
