package wire

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// criticalValidationPath is the TypeScript file that validates the results of
// the server's "critical" command families (restore, verification, vault, DR,
// topology diagnostic). Relative to this package's directory.
const criticalValidationPath = "../../../apps/api/src/services/agentCommandResultValidation.ts"

func readCriticalValidationSource(t *testing.T) string {
	t.Helper()
	path := filepath.Clean(criticalValidationPath)
	data, err := os.ReadFile(path)
	if err != nil {
		// A missing file is a failure, not a skip: a silently skipped
		// cross-language pin is the same as no pin at all.
		t.Fatalf("cannot read the server validator at %s to verify the mirrored limits: %v", path, err)
	}
	return string(data)
}

// serverConstant parses `export const NAME = <number>` out of the validator.
// Anchored on the declaration so a comment mentioning the name cannot retarget
// the pin onto prose.
func serverConstant(t *testing.T, src, name string) int {
	t.Helper()
	re := regexp.MustCompile(`export\s+const\s+` + regexp.QuoteMeta(name) + `\s*=\s*([0-9_]+)\s*;`)
	m := re.FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("no `export const %s = <number>;` declaration in %s — if it was renamed or moved, "+
			"update the Go mirror and this test together", name, criticalValidationPath)
	}
	v, err := strconv.Atoi(strings.ReplaceAll(m[1], "_", ""))
	if err != nil {
		t.Fatalf("could not parse %s value %q: %v", name, m[1], err)
	}
	return v
}

// TestCriticalResultLimitsMatchServerValidator pins every Go mirror of a
// critical-result limit to the server's declaration. The agent bounds a
// verify/restore result's lists and size against these values; if the server
// tightens one and the Go side does not follow, the server rejects the whole
// result again and its counts and status are lost.
func TestCriticalResultLimitsMatchServerValidator(t *testing.T) {
	src := readCriticalValidationSource(t)
	for _, tc := range []struct {
		server string
		goName string
		goVal  int
	}{
		{"CRITICAL_RESULT_STDOUT_MAX_BYTES", "CriticalResultStdoutMaxBytes", CriticalResultStdoutMaxBytes},
		{"CRITICAL_RESULT_STDERR_MAX_BYTES", "CriticalResultStderrMaxBytes", CriticalResultStderrMaxBytes},
		{"CRITICAL_RESULT_STRUCTURED_MAX_BYTES", "CriticalResultStructuredMaxBytes", CriticalResultStructuredMaxBytes},
		{"CRITICAL_RESULT_FAILED_FILES_MAX", "CriticalResultFailedFilesMax", CriticalResultFailedFilesMax},
		{"CRITICAL_RESULT_WARNINGS_MAX", "CriticalResultWarningsMax", CriticalResultWarningsMax},
		{"CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS", "CriticalResultListEntryMaxChars", CriticalResultListEntryMaxChars},
		{"CRITICAL_RESULT_WARNING_TEXT_MAX_CHARS", "CriticalResultWarningTextMaxChars", CriticalResultWarningTextMaxChars},
		{"CRITICAL_RESULT_ERROR_MAX_CHARS", "CriticalResultErrorMaxChars", CriticalResultErrorMaxChars},
		{"RESTORE_QUARANTINED_PATHS_MAX", "CriticalResultQuarantinedPathsMax", CriticalResultQuarantinedPathsMax},
		{"RESTORE_QUARANTINED_PATH_MAX_CHARS", "CriticalResultQuarantinedPathMaxChars", CriticalResultQuarantinedPathMaxChars},
	} {
		if got := serverConstant(t, src, tc.server); got != tc.goVal {
			t.Errorf("server %s = %d but Go %s = %d; update both in the same commit", tc.server, got, tc.goName, tc.goVal)
		}
	}
}

// TestCriticalResultSchemasUseTheNamedLimits proves the named constants are
// what the schemas actually enforce. Pinning a constant the schema no longer
// reads would let the real limit drift behind a passing test.
func TestCriticalResultSchemasUseTheNamedLimits(t *testing.T) {
	src := readCriticalValidationSource(t)
	for _, want := range []string{
		"z.array(z.string().max(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS)).max(CRITICAL_RESULT_WARNINGS_MAX)",
		"z.string().max(CRITICAL_RESULT_WARNING_TEXT_MAX_CHARS)",
	} {
		if !strings.Contains(src, want) {
			t.Errorf("warning list schema no longer reads %q", want)
		}
	}
	failedFiles := "z.array(z.string().min(1).max(CRITICAL_RESULT_LIST_ENTRY_MAX_CHARS)).max(CRITICAL_RESULT_FAILED_FILES_MAX)"
	if n := strings.Count(src, failedFiles); n != 2 {
		t.Errorf("expected the restore and verification failedFiles schemas to read %q, found it %d time(s)", failedFiles, n)
	}
	if n := strings.Count(src, "error: z.string().max(CRITICAL_RESULT_ERROR_MAX_CHARS)"); n != 2 {
		t.Errorf("expected the restore and verification error schemas to read CRITICAL_RESULT_ERROR_MAX_CHARS, found it %d time(s)", n)
	}
}

// TestCriticalResultCommandTypesMatchServer pins the set of command types whose
// results the server validates with the critical schemas. A type the server
// adds but the agent does not know would be bounded only to the general 5 MB
// budget and rejected at 512 KiB.
func TestCriticalResultCommandTypesMatchServer(t *testing.T) {
	src := readCriticalValidationSource(t)
	setRe := regexp.MustCompile(`(?s)const\s+(RESTORE|DR|VERIFICATION|TOPOLOGY_DIAGNOSTIC|VAULT)_COMMAND_TYPES\s*=\s*new Set\(\[(.*?)\]\)`)
	strRe := regexp.MustCompile(`'([a-z0-9_]+)'`)
	matches := setRe.FindAllStringSubmatch(src, -1)
	if len(matches) != 5 {
		t.Fatalf("found %d of the 5 critical command-type sets in %s; update this test if they moved", len(matches), criticalValidationPath)
	}
	server := map[string]bool{}
	for _, m := range matches {
		for _, s := range strRe.FindAllStringSubmatch(m[2], -1) {
			server[s[1]] = true
		}
	}
	var missing, extra []string
	for typ := range server {
		if !IsCriticalResultCommand(typ) {
			missing = append(missing, typ)
		}
	}
	for _, typ := range CriticalResultCommandTypes() {
		if !server[typ] {
			extra = append(extra, typ)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) > 0 || len(extra) > 0 {
		t.Fatalf("critical command types drifted: server-only %v, agent-only %v", missing, extra)
	}
}

// TestCriticalResultBudgetLeavesHeadroom: the agent targets a budget strictly
// under the server's structured cap, and that budget is also under the stdout
// cap (a verify result can arrive as stdout alone on the failure path).
func TestCriticalResultBudgetLeavesHeadroom(t *testing.T) {
	if CriticalResultBudget >= CriticalResultStructuredMaxBytes {
		t.Fatalf("CriticalResultBudget (%d) must be below CriticalResultStructuredMaxBytes (%d)",
			CriticalResultBudget, CriticalResultStructuredMaxBytes)
	}
	if CriticalResultBudget >= CriticalResultStdoutMaxBytes {
		t.Fatalf("CriticalResultBudget (%d) must be below CriticalResultStdoutMaxBytes (%d)",
			CriticalResultBudget, CriticalResultStdoutMaxBytes)
	}
	if CriticalResultBudget <= 0 {
		t.Fatalf("CriticalResultBudget (%d) must be positive", CriticalResultBudget)
	}
}
