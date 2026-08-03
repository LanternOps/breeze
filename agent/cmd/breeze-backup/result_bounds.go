package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

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

	// maxResultNoteBytes caps ONE bounding note. dropBulkFields renders
	// strings.Join(<every dropped key>, ", ") into its note, which is bounded by
	// nothing on a wide body — so the notes need a cap of their own rather than
	// inheriting whatever is left of the warning's.
	maxResultNoteBytes = 512

	// maxResultNotesBytes is the tail of the warning reserved for bounding
	// notes. Tiers 2-4 emit at most four (snapshot index, bulk fields, tier-3
	// containers, tier-4 last resort), so this is several times the realizable
	// total; it is a backstop, not a working limit.
	maxResultNotesBytes = 4 * 1024

	// maxTruncationSuffixBytes is the worst-case length of the marker
	// truncateText appends ("… (+N bytes truncated)" with N at its widest).
	maxTruncationSuffixBytes = 48

	// maxResultWarningTextBytes is the budget for the RUN's own warning text.
	// Splitting the budget is what makes "clamp the text" and "keep every note"
	// independent operations.
	//
	// The subtractions are what make the split TOTAL rather than merely roomy:
	// text + marker + notes, each with its truncation suffix, comes to at most
	// maxResultTextBytes. So a composed warning can never exceed the generic
	// free-text cap, and no other clamp in this file can bite it and take the
	// notes with it. Left as slack instead, the arithmetic would silently stop
	// holding the day someone raised a cap or added a fifth note.
	maxResultWarningTextBytes = maxResultTextBytes - maxResultNotesBytes -
		2*maxTruncationSuffixBytes - len(resultNoteMarker)
)

// resultNoteMarker separates the run's own warning text from the bounding notes
// these tiers append to it.
//
// Without a boundary the warning is one opaque string, and every clamp is
// forced to head-truncate the whole thing — which evicts the notes, because
// notes are always at the tail. That is not hypothetical: tier 2 appends twice
// (emptySnapshotFiles then dropBulkFields), so on a warning already at the cap
// the second append silently deleted the first one's note, and the
// snapshot-file-index note is the single most consequential signal in this file
// (it is the only thing distinguishing "this snapshot has no files" from "we
// deleted the index to fit a frame"). The marker lets composeResultWarning
// clamp the text and the notes against separate budgets so neither can evict
// the other.
const resultNoteMarker = " || bounded: "

// snapshotIdentityKeys are the snapshot fields kept when the per-file index is
// dropped: enough for the server to record a usable restore point
// (backupResultPersistence reads snapshot.id / .timestamp / .size).
var snapshotIdentityKeys = []string{"id", "timestamp", "size", "formatVersion", "baseSnapshotId"}

// bulkFieldThreshold is the encoded size past which a top-level container
// (array/object) field counts as "bulk" and is dropped ahead of the scalars.
// Anything under it is cheaper to keep than to reason about.
const bulkFieldThreshold = 4 * 1024

// fitBackupResultToIPC returns result bounded so its marshalled payload fits
// resultPayloadBudget, degrading in tiers and stopping at the first that fits:
//
//  1. always: truncate the free-text stderr field (cheap, no JSON parse);
//  2. empty the per-file snapshot index, cap the warning text, and drop any
//     other bulk container field — this is what actually blows the budget;
//  3. reduce stdout to its SCALAR fields plus the snapshot's identity;
//  4. last resort: a hand-built minimal status object.
//
// Tiers 2 and 3 are deliberately shape-agnostic — they drop bulk containers and
// keep scalars rather than matching an enumerated field list. Every command has
// its own body (backup.BackupJob, backup.RestoreResult, verify results, …) and
// the unbounded field is always a per-file array (Snapshot.Files,
// RestoreResult.FailedFiles, …) while the fields the server persists are always
// summary scalars. An enumerated keep-list would silently zero
// filesRestored/filesFailed on the paths it forgot; keeping every scalar cannot.
//
// A stdout that is not a JSON object at all (e.g. backup_list's array) cannot be
// summarised this way, so it degrades to an explicit failure instead of a
// success with an empty body — an empty snapshot list read as "no backups" is
// worse than a loud error.
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
	// fail(err.Error()), which nothing caps — as does the vault auto-sync
	// result, whose Stderr joins one entry per failed file.
	if truncated, dropped := truncateText(result.Stderr, maxResultTextBytes); dropped > 0 {
		result.Stderr = truncated
		notes = append(notes, fmt.Sprintf("stderr truncated (%d bytes dropped)", dropped))
	}
	if fits(result) {
		return result, joinNotes(notes)
	}

	// Only reached when the result is actually oversize, so the ordinary path
	// never pays for parsing a multi-megabyte stdout.
	obj, isObject := decodeStdoutObject(result.Stdout)
	if !isObject {
		notes = append(notes, "result body could not be summarised and was replaced with an oversize failure")
		return oversizeFailureResult(result), joinNotes(notes)
	}

	// Tier 2 — cap the warning text, empty the per-file snapshot index, and
	// drop any other bulk container.
	//
	// The snapshot index is emptied rather than truncated: the server derives
	// hasIndexedFiles from snapshot.files.length, so a partial index would
	// present as a complete browsable file list silently missing entries. It is
	// emptied rather than removed because the server's stale-row cleanup is
	// gated on the KEY being present (`if (snapshot && result.snapshot?.files)`
	// in backupResultPersistence.ts) — omitting it would leave a previous
	// delivery's file rows in place while hasIndexedFiles flipped to false.
	if dropped := boundObjectWarning(obj); dropped > 0 {
		notes = append(notes, fmt.Sprintf("warning truncated (%d bytes dropped)", dropped))
	}
	if entries, ok := emptySnapshotFiles(obj); ok {
		notes = append(notes, fmt.Sprintf("snapshot file index dropped (%d entries)", entries))
	}
	for _, key := range dropBulkFields(obj) {
		notes = append(notes, fmt.Sprintf("%s dropped (bulk field)", key))
	}
	result.Stdout = encodeStdoutObject(obj, result.Stdout)
	if fits(result) {
		return result, joinNotes(notes)
	}

	// Tier 3 — scalar fields plus the snapshot identity only.
	if reduced, ok := reduceToScalars(result.Stdout); ok {
		result.Stdout = reduced
		notes = append(notes, "result reduced to summary scalars only")
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
	size := marshalledSize(result)
	// A result that cannot be marshalled at all is not "fitting" — treating
	// marshalledSize's -1 sentinel as a small size would return an unsendable
	// payload from a function whose contract is that the send will succeed.
	// (BackupCommandResult is only strings/bool/int64, so this is unreachable
	// today; it is guarded so it stays unreachable if the type grows a field.)
	if size < 0 {
		return false
	}
	return size <= resultPayloadBudget
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

// boundObjectWarning truncates the run's own text in the object's `warning`
// field in place, returning how many bytes were dropped. Any bounding notes
// already on the field are preserved — only the free text is clamped.
func boundObjectWarning(obj map[string]json.RawMessage) int {
	raw, present := obj["warning"]
	if !present {
		return 0
	}
	text, notes := splitResultWarning(decodeResultWarning(raw))
	_, dropped := truncateText(text, maxResultWarningTextBytes)
	if dropped == 0 {
		return 0
	}
	obj["warning"] = mustRawString(composeResultWarning(text, notes))
	return dropped
}

// emptySnapshotFiles replaces snapshot.files with an empty array and records
// the drop in the result's `warning`, so it is visible server-side (the warning
// is persisted to the job's errorLog) rather than only in an endpoint log line.
// Reports the number of entries dropped and whether anything was dropped.
func emptySnapshotFiles(obj map[string]json.RawMessage) (int, bool) {
	rawSnap, present := obj["snapshot"]
	if !present {
		return 0, false
	}
	var snap map[string]json.RawMessage
	if err := json.Unmarshal(rawSnap, &snap); err != nil || snap == nil {
		return 0, false
	}
	raw, hasFiles := snap["files"]
	if !hasFiles {
		return 0, false
	}
	var files []json.RawMessage
	if err := json.Unmarshal(raw, &files); err != nil || len(files) == 0 {
		return 0, false
	}
	snap["files"] = json.RawMessage("[]")
	rebuilt, err := json.Marshal(snap)
	if err != nil {
		return 0, false
	}
	obj["snapshot"] = rebuilt
	obj["warning"] = mustRawString(appendResultWarning(obj["warning"], fmt.Sprintf(
		"snapshot file index omitted (%d entries): the result exceeded the %d byte agent IPC limit, so per-file restore browsing is unavailable for this snapshot",
		len(files), ipc.MaxMessageSize)))
	return len(files), true
}

// dropBulkFields removes every top-level container field whose encoded size
// exceeds bulkFieldThreshold — the per-file arrays (restore's failedFiles /
// warnings, verify's failedFiles) that are unbounded for the same reason
// Snapshot.Files is. `snapshot` is exempt: emptySnapshotFiles already handled
// its bulk and the rest of it is the identity the server needs. Returns the
// keys dropped, sorted for a deterministic note, and records them in `warning`.
func dropBulkFields(obj map[string]json.RawMessage) []string {
	var dropped []string
	for key, raw := range obj {
		if key == "snapshot" || len(raw) <= bulkFieldThreshold {
			continue
		}
		if !isJSONContainer(raw) {
			continue
		}
		delete(obj, key)
		dropped = append(dropped, key)
	}
	if len(dropped) == 0 {
		return nil
	}
	sort.Strings(dropped)
	obj["warning"] = mustRawString(appendResultWarning(obj["warning"], fmt.Sprintf(
		"detail field(s) omitted (%s): the result exceeded the %d byte agent IPC limit",
		strings.Join(dropped, ", "), ipc.MaxMessageSize)))
	return dropped
}

// isJSONContainer reports whether raw encodes a JSON array or object — the only
// shapes that can grow without bound. Scalars are always kept: they are the
// summary counters the server persists (filesRestored, filesFailed, errorCount).
func isJSONContainer(raw json.RawMessage) bool {
	for _, b := range raw {
		switch b {
		case ' ', '\t', '\n', '\r':
			continue
		case '[', '{':
			return true
		default:
			return false
		}
	}
	return false
}

// reduceToScalars strips stdout down to its scalar fields plus the snapshot's
// identity. Keeping every scalar — rather than an enumerated allow-list — is
// what stops this tier from silently zeroing a counter the server reads
// (filesRestored, filesFailed, errorCount, …) on a command shape it never
// anticipated.
func reduceToScalars(stdout string) (string, bool) {
	obj, ok := decodeStdoutObject(stdout)
	if !ok {
		return stdout, false
	}
	var containers []string
	kept := make(map[string]json.RawMessage, len(obj))
	for key, raw := range obj {
		if isJSONContainer(raw) {
			containers = append(containers, key)
			continue
		}
		kept[key] = raw
	}
	// Keep the snapshot's identity — without it the server records no
	// providerSnapshotId and the successful run yields no restore point.
	if rawSnap, present := obj["snapshot"]; present {
		var snap map[string]json.RawMessage
		if err := json.Unmarshal(rawSnap, &snap); err == nil && snap != nil {
			identity := make(map[string]json.RawMessage, len(snapshotIdentityKeys)+1)
			for _, key := range snapshotIdentityKeys {
				if v, exists := snap[key]; exists {
					identity[key] = v
				}
			}
			identity["files"] = json.RawMessage("[]")
			if rawIdentity, err := json.Marshal(identity); err == nil {
				kept["snapshot"] = rawIdentity
			}
		}
	}
	// A pathological scalar (e.g. a megabyte-long snapshot id) would keep this
	// tier over budget; bound every retained string.
	//
	// `warning` needs no special case here only because composeResultWarning's
	// budget is total: a composed warning is already at most maxResultTextBytes,
	// so this clamp cannot bite it and take its bounding notes (which live at
	// the tail, where a head-keeping clamp cuts) with it.
	for key, raw := range kept {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil {
			continue
		}
		if bounded, dropped := truncateText(s, maxResultTextBytes); dropped > 0 {
			kept[key] = mustRawString(bounded)
		}
	}
	if len(containers) > 0 {
		sort.Strings(containers)
		kept["warning"] = mustRawString(appendResultWarning(kept["warning"], fmt.Sprintf(
			"detail field(s) omitted (%s): the result exceeded the %d byte agent IPC limit",
			strings.Join(containers, ", "), ipc.MaxMessageSize)))
	}
	return encodeStdoutObject(kept, stdout), true
}

// oversizeFailureResult replaces a result whose body cannot be summarised (a
// stdout that is not a JSON object, e.g. backup_list's array) with an explicit
// failure. A terminal status still lands — the point of #3001 — but an empty
// body is never handed back under Success: true, where the server would read it
// as a complete, empty answer.
func oversizeFailureResult(result backupipc.BackupCommandResult) backupipc.BackupCommandResult {
	// Size is captured before the fields are cleared — reporting it after would
	// print the size of the replacement, not of what was dropped.
	original := len(result.Stdout) + len(result.Stderr)
	result.Stdout = ""
	result.Success = false
	result.Stderr = fmt.Sprintf(
		"backup helper result exceeded the %d byte agent IPC limit (%d bytes) and could not be summarised; the command may have succeeded but its output could not be delivered",
		ipc.MaxMessageSize, original)
	result.CommandID, _ = truncateText(result.CommandID, maxLastResortFieldBytes)
	return result
}

// lastResortStdout builds a minimal terminal-status object from whatever can
// still be recovered from stdout. Every field is bounded by construction.
//
// `warning` is carried over rather than rebuilt. It is the ONLY channel the
// backup path has for operator-facing degradation signals — appendWarning in
// internal/backup/backup.go joins the live-volume-read note (#3025/#3027), the
// uncaptured-system-state-artifacts note (#3029), the VSS health note (#3030)
// and the partial-upload summary into it, and the server persists it to the
// job's errorLog. Replacing it here would turn a degraded restore point into a
// clean-looking one on exactly the runs most likely to be degraded, since a
// large run is what reaches this tier at all. The tier may truncate the warning
// and must append its own note to it; it must never substitute for it.
func lastResortStdout(stdout string) string {
	minimal := map[string]string{}
	var existingWarning json.RawMessage
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
		existingWarning = obj["warning"]
	}
	// appendResultWarning bounds the text and the notes against their own
	// budgets, so the field comes out under maxResultTextBytes whatever stdout
	// carried and the note lands intact — the "always fits" postcondition holds.
	// The warning gets the same allowance as tiers 2 and 3 rather than
	// maxLastResortFieldBytes: 8 KiB against a ~16 MiB budget is free, and
	// clipping an operator signal to 1 KiB would defeat the point of keeping it.
	minimal["warning"] = appendResultWarning(existingWarning, fmt.Sprintf(
		"backup result exceeded the %d byte agent IPC limit and was reduced to a terminal status; detail was dropped",
		ipc.MaxMessageSize))
	data, err := json.Marshal(minimal)
	if err != nil {
		return `{"warning":"backup result could not be encoded"}`
	}
	return string(data)
}

// decodeResultWarning recovers the warning text from a JSON-encoded field.
//
// A `warning` that is present but not a JSON string is carried through in its
// encoded form rather than dropped. These tiers are deliberately shape-agnostic
// about command bodies, so assuming this one field's type and silently
// discarding it when the assumption fails would be the same class of data loss
// they exist to make explicit.
func decodeResultWarning(existing json.RawMessage) string {
	if len(existing) == 0 {
		return ""
	}
	var current string
	if err := json.Unmarshal(existing, &current); err != nil {
		return string(existing)
	}
	return current
}

// splitResultWarning splits a composed warning into the run's own text and the
// bounding notes appended by these tiers. A warning that has never been through
// appendResultWarning is all text and no notes.
func splitResultWarning(warning string) (text, notes string) {
	if i := strings.Index(warning, resultNoteMarker); i >= 0 {
		return warning[:i], warning[i+len(resultNoteMarker):]
	}
	return warning, ""
}

// composeResultWarning re-joins a warning's text and notes, bounding each
// against its OWN budget. This is the only function that bounds a warning: a
// plain truncateText over the composed string would keep the head and drop the
// notes, which are what say the result was degraded at all.
func composeResultWarning(text, notes string) string {
	text, _ = truncateText(text, maxResultWarningTextBytes)
	notes, _ = truncateText(notes, maxResultNotesBytes)
	if notes == "" {
		return text
	}
	return text + resultNoteMarker + notes
}

// appendResultWarning appends fragment to an existing JSON-encoded warning as a
// bounding note, joining notes with "; " — mirroring the agent-side
// appendWarning convention. The fragment is clamped first so one note can never
// consume the reserve the other notes need.
func appendResultWarning(existing json.RawMessage, fragment string) string {
	text, notes := splitResultWarning(decodeResultWarning(existing))
	fragment, _ = truncateText(fragment, maxResultNoteBytes)
	if notes == "" {
		notes = fragment
	} else {
		notes += "; " + fragment
	}
	return composeResultWarning(text, notes)
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
