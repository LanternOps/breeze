package main

import (
	"encoding/json"
	"fmt"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/wire"
)

// The server validates the results of its critical command families (verify,
// test restore, restore, DR, vault) against limits far tighter than the 5 MB
// cap backup_run is bounded to: failedFiles <= 1,000 entries, warnings <= 100,
// each entry <= 4,096 code points, `error` <= 10,000, and the whole structured
// body <= 512 KiB (wire.CriticalResult*). One value over any of them rejects
// the WHOLE result, so a verification of a large snapshot with many failures
// lost its counts and status along with the path list that tripped the limit.
//
// These lists are display detail; the counts (filesFailed, filesVerified,
// filesUnchecked, ...) are what the server persists and acts on. So the lists
// are bounded here — the first N entries kept, in order — the counts are never
// touched, and the result says what it left out: `failedFilesOmitted` /
// `warningsOmitted` carry the numbers, and a final warning says it in words.
// Old servers keep the extra keys (the critical schemas are passthrough).

// limitCriticalLists attributes a degradation to the server's list limits
// rather than to a byte budget.
var limitCriticalLists = deliveryLimit{
	name:  "server critical result list limits (wire.CriticalResult*Max / *MaxChars)",
	label: "server result list limits",
}

// criticalListEllipsis marks a list entry or string that was cut short.
const criticalListEllipsis = "…"

// fitBackupResultForCommand bounds result for delivery as a reply to
// commandType. Critical command families get their lists bounded to the
// server's schema limits and their body to wire.CriticalResultBudget; every
// other command keeps the general bounding (fitBackupResult) unchanged.
func fitBackupResultForCommand(commandType string, result backupipc.BackupCommandResult) (
	backupipc.BackupCommandResult, string, deliveryLimit,
) {
	if !wire.IsCriticalResultCommand(commandType) {
		return fitBackupResult(result)
	}
	// Lists first: the generic tiers drop any container over 4 KiB wholesale,
	// which would lose every path where keeping the first ones costs nothing.
	bounded, listNotes := boundCriticalResultLists(result)
	fitted, notes, limit := fitBackupResultAgainst(bounded, limitCriticalResult)
	if listNotes != "" {
		if notes == "" {
			notes = listNotes
		} else {
			notes = listNotes + "; " + notes
		}
		if !limit.fired() || limit == limitResultText {
			limit = limitCriticalLists
		}
	}
	return fitted, notes, limit
}

// boundCriticalResultLists bounds the failedFiles / warnings lists and the
// `error` string of a critical result body to the server's limits, then
// shrinks the lists further (halving, keeping the head) until the body fits
// wire.CriticalResultBudget. It returns result unchanged, with no notes, when
// nothing was over a limit or stdout is not a JSON object.
func boundCriticalResultLists(result backupipc.BackupCommandResult) (backupipc.BackupCommandResult, string) {
	obj, ok := decodeStdoutObject(result.Stdout)
	if !ok {
		return result, ""
	}
	var notes []string
	changed := false

	// A failedFiles that is not a list of strings (bmr_recover sends a count)
	// is left alone.
	failed, hasFailed := decodeStringList(obj["failedFiles"])
	if hasFailed {
		var n int
		if failed, n = cleanCriticalEntries(failed); n > 0 {
			changed = true
			notes = append(notes, fmt.Sprintf("%d failedFiles entr(ies) emptied or shortened", n))
		}
	}
	warnings, hasWarningList := decodeStringList(obj["warnings"])
	if hasWarningList {
		var n int
		if warnings, n = cleanCriticalEntries(warnings); n > 0 {
			changed = true
			notes = append(notes, fmt.Sprintf("%d warnings entr(ies) emptied or shortened", n))
		}
	} else if text, isText := decodeString(obj["warnings"]); isText {
		// The server also accepts warnings as one string.
		if cut, truncated := truncateRunes(text, wire.CriticalResultWarningTextMaxChars); truncated {
			obj["warnings"] = mustRawString(cut)
			changed = true
			notes = append(notes, "warnings text shortened")
		}
	}
	if text, isText := decodeString(obj["error"]); isText {
		if cut, truncated := truncateRunes(text, wire.CriticalResultErrorMaxChars); truncated {
			obj["error"] = mustRawString(cut)
			changed = true
			notes = append(notes, "error text shortened")
		}
	}

	// The restricted-descriptor path list: the server trims it to its own
	// limit rather than rejecting it, but only AFTER the structured-size check,
	// so an oversize list must be trimmed here or it rejects the result (or
	// crowds the failed files out of the byte budget below). Its count,
	// securityDescriptorQuarantined, is the authoritative total.
	if paths, ok := decodeStringList(obj["securityDescriptorQuarantinedPaths"]); ok {
		trimmed := make([]string, 0, min(len(paths), wire.CriticalResultQuarantinedPathsMax))
		touched := len(paths) > wire.CriticalResultQuarantinedPathsMax
		for _, p := range paths[:min(len(paths), wire.CriticalResultQuarantinedPathsMax)] {
			cut, truncated := truncateRunes(p, wire.CriticalResultQuarantinedPathMaxChars)
			touched = touched || truncated
			trimmed = append(trimmed, cut)
		}
		if touched {
			obj["securityDescriptorQuarantinedPaths"] = mustRawJSON(trimmed)
			changed = true
			notes = append(notes, fmt.Sprintf("securityDescriptorQuarantinedPaths kept %d of %d", len(trimmed), len(paths)))
		}
	}

	priorFailedOmitted := decodeCount(obj["failedFilesOmitted"])
	priorWarningsOmitted := decodeCount(obj["warningsOmitted"])
	_, warningsPresent := obj["warnings"]
	// The note can only ride a warnings list: append it to the run's own list,
	// or start one when the run had none.
	canNote := hasWarningList || !warningsPresent

	failedKeep := min(len(failed), wire.CriticalResultFailedFilesMax)
	warnKeep := min(len(warnings), wire.CriticalResultWarningsMax)
	needNote := func() bool { return canNote && (failedKeep < len(failed) || warnKeep < len(warnings)) }
	if needNote() {
		// Reserve the last slot for the note.
		warnKeep = min(warnKeep, wire.CriticalResultWarningsMax-1)
	}

	apply := func() {
		if hasFailed {
			obj["failedFiles"] = mustRawJSON(failed[:failedKeep])
			setCount(obj, "failedFilesOmitted", priorFailedOmitted+len(failed)-failedKeep)
		}
		failedOmitted := priorFailedOmitted + len(failed) - failedKeep
		warningsOmitted := priorWarningsOmitted + len(warnings) - warnKeep
		if hasWarningList || needNote() {
			// Never nil: a nil slice encodes as null, which the server rejects.
			kept := append(make([]string, 0, warnKeep+1), warnings[:warnKeep]...)
			if needNote() {
				kept = append(kept, fmt.Sprintf(
					"%d more failed file(s) and %d more warning(s) not listed: the result exceeded the server's limits for detail lists; the file counts are complete",
					failedOmitted, warningsOmitted))
			}
			obj["warnings"] = mustRawJSON(kept)
			setCount(obj, "warningsOmitted", warningsOmitted)
		}
	}

	if failedKeep < len(failed) || warnKeep < len(warnings) {
		changed = true
		notes = append(notes, fmt.Sprintf("failedFiles kept %d of %d, warnings kept %d of %d (server list limits)",
			failedKeep, len(failed), warnKeep, len(warnings)))
	}
	if !changed {
		// Still subject to the byte budget below; nothing has been rewritten yet.
		if len(result.Stdout) <= wire.CriticalResultBudget {
			return result, ""
		}
	}

	apply()
	stdout := encodeStdoutObject(obj, result.Stdout)
	shrunk := false
	canShrink := failedKeep > 0 || warnKeep > 0
	if len(stdout) > wire.CriticalResultBudget && canShrink {
		// Cut the lists only if that can work: when the body is over budget
		// even with both emptied, the bulk is elsewhere and the generic tiers
		// own it — emptying the lists first would lose them for nothing.
		keptFailed, keptWarnings := failedKeep, warnKeep
		failedKeep, warnKeep = 0, 0
		apply()
		canShrink = len(encodeStdoutObject(obj, result.Stdout)) <= wire.CriticalResultBudget
		failedKeep, warnKeep = keptFailed, keptWarnings
		apply()
	}
	for canShrink && len(stdout) > wire.CriticalResultBudget && (failedKeep > 0 || warnKeep > 0) {
		if failedKeep > 0 {
			failedKeep /= 2
		} else {
			warnKeep /= 2
		}
		if needNote() {
			warnKeep = min(warnKeep, wire.CriticalResultWarningsMax-1)
		}
		shrunk = true
		apply()
		stdout = encodeStdoutObject(obj, result.Stdout)
	}
	if shrunk {
		changed = true
		notes = append(notes, fmt.Sprintf("failedFiles cut to %d and warnings to %d entries to fit the %s",
			failedKeep, warnKeep, limitCriticalResult.describe()))
	}
	if !changed {
		// Over the byte budget for reasons other than the lists; the generic
		// tiers own that.
		return result, ""
	}
	result.Stdout = stdout
	return result, joinNotes(notes)
}

// cleanCriticalEntries drops empty entries (the server requires min(1)) and
// shortens over-long ones to the server's per-entry limit, reporting how many
// entries it touched.
func cleanCriticalEntries(in []string) ([]string, int) {
	out := make([]string, 0, len(in))
	touched := 0
	for _, s := range in {
		if s == "" {
			touched++
			continue
		}
		cut, truncated := truncateRunes(s, wire.CriticalResultListEntryMaxChars)
		if truncated {
			touched++
		}
		out = append(out, cut)
	}
	return out, touched
}

// truncateRunes shortens s to at most max code points — how zod 4 counts a
// string's length — ending it with an ellipsis. Cutting on a rune boundary
// keeps it valid UTF-8.
func truncateRunes(s string, max int) (string, bool) {
	if len(s) <= max || utf8.RuneCountInString(s) <= max {
		return s, false
	}
	keep := max - utf8.RuneCountInString(criticalListEllipsis)
	i := 0
	for n := 0; n < keep && i < len(s); n++ {
		_, size := utf8.DecodeRuneInString(s[i:])
		i += size
	}
	return s[:i] + criticalListEllipsis, true
}

// decodeStringList decodes raw as a JSON array of strings; ok is false for any
// other shape (absent, a number, a string, mixed types).
func decodeStringList(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 || !isJSONContainer(raw) {
		return nil, false
	}
	var list []string
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, false
	}
	return list, true
}

func decodeString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	return s, true
}

// decodeCount reads a non-negative integer marker, treating anything else as 0.
func decodeCount(raw json.RawMessage) int {
	if len(raw) == 0 {
		return 0
	}
	var n int
	if err := json.Unmarshal(raw, &n); err != nil || n < 0 {
		return 0
	}
	return n
}

// setCount sets a non-zero marker count, and removes a zero one so an
// untruncated list carries no marker.
func setCount(obj map[string]json.RawMessage, key string, n int) {
	if n > 0 {
		obj[key] = mustRawJSON(n)
		return
	}
	delete(obj, key)
}

// mustRawJSON encodes v, which is always a []string or int here, so Marshal
// cannot fail; the fallback keeps the field valid JSON regardless.
func mustRawJSON(v any) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return data
}
