package wire

import "sort"

// Limits the server applies to the results of its "critical" command families
// (restore, verification, vault, DR, topology diagnostic) on top of the general
// command_result caps above.
//
// MIRRORS apps/api/src/services/agentCommandResultValidation.ts, where the
// `CRITICAL_RESULT_*` constants of the same names are declared and used by the
// result schemas. Pinned by TestCriticalResultLimitsMatchServerValidator, which
// parses that file.
//
// These are much tighter than MaxCommandResultBytes, and one value over any of
// them rejects the WHOLE result: a verification with 5,000 failed files lost
// its counts and status because its path list was 5x the list limit. A
// critical result therefore has to be bounded against these, not against the
// general 5 MB budget backup_run uses.
//
// The *Chars limits are counted the way zod 4 counts string length: in Unicode
// code points, not bytes. Go's len() counts bytes, so compare with
// utf8.RuneCountInString.
const (
	// CriticalResultStdoutMaxBytes caps the command_result `stdout` string.
	CriticalResultStdoutMaxBytes = 1_048_576
	// CriticalResultStderrMaxBytes caps the command_result `stderr` string.
	CriticalResultStderrMaxBytes = 262_144
	// CriticalResultStructuredMaxBytes caps JSON.stringify of the structured
	// `result` (the parsed stdout body) — the binding size limit.
	CriticalResultStructuredMaxBytes = 524_288

	// CriticalResultFailedFilesMax is the most entries a failedFiles path list
	// may carry.
	CriticalResultFailedFilesMax = 1000
	// CriticalResultWarningsMax is the most entries a warnings list may carry.
	CriticalResultWarningsMax = 100
	// CriticalResultListEntryMaxChars caps one failedFiles or warnings entry.
	CriticalResultListEntryMaxChars = 4096
	// CriticalResultWarningTextMaxChars caps warnings sent as a single string.
	CriticalResultWarningTextMaxChars = 10_000
	// CriticalResultErrorMaxChars caps the in-body `error` string.
	CriticalResultErrorMaxChars = 10_000
)

// CriticalResultBudget is the encoded size agent-side code should keep a
// critical result body under. The headroom is the same absolute allowance as
// CommandResultBudget's, for the same reason: the server re-encodes with
// JSON.stringify, which Go's encoder can differ from.
const CriticalResultBudget = CriticalResultStructuredMaxBytes - CommandResultHeadroom

// criticalResultCommandTypes is the union of the server's RESTORE, DR,
// VERIFICATION, TOPOLOGY_DIAGNOSTIC and VAULT command-type sets. Pinned by
// TestCriticalResultCommandTypesMatchServer.
var criticalResultCommandTypes = map[string]struct{}{
	"backup_restore":         {},
	"vm_restore_from_backup": {},
	"vm_instant_boot":        {},
	"bare_metal_rebuild":     {},
	"hyperv_restore":         {},
	"mssql_restore":          {},
	"bmr_recover":            {},
	"backup_verify":          {},
	"backup_test_restore":    {},
	"network_diagnostic":     {},
	"vault_sync":             {},
}

// IsCriticalResultCommand reports whether the server validates commandType's
// result against the critical limits above.
func IsCriticalResultCommand(commandType string) bool {
	_, ok := criticalResultCommandTypes[commandType]
	return ok
}

// CriticalResultCommandTypes returns the critical command types, sorted.
func CriticalResultCommandTypes() []string {
	out := make([]string, 0, len(criticalResultCommandTypes))
	for typ := range criticalResultCommandTypes {
		out = append(out, typ)
	}
	sort.Strings(out)
	return out
}
