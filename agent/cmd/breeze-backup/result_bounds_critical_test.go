package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/wire"
)

// The server validates verify / test-restore / restore results against list
// limits (failedFiles <= 1000, warnings <= 100, entries <= 4096 code points)
// and a 512 KiB structured-size cap. One entry over any of them rejected the
// WHOLE result, so a large run with many failures lost its counts and status.
// These tests pin that the helper bounds those lists to the server's limits
// and keeps the true counts.

const (
	manyFailedFiles = 5000
	manyWarnings    = 500
)

func realisticPath(i int) string {
	return fmt.Sprintf(`C:\Users\jdoe\Documents\Projects\Quarterly Reports\2026\archive\scan_%06d_final_v2.pdf`, i)
}

func manyPaths(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = realisticPath(i)
	}
	return out
}

func manyWarningTexts(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("size mismatch on volatile entry %s (expected 1024, got 2048)", realisticPath(i))
	}
	return out
}

func criticalResultFor(t *testing.T, body any) backupipc.BackupCommandResult {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	return backupipc.BackupCommandResult{CommandID: "cmd-1", Success: true, Stdout: string(data)}
}

// boundedLists decodes the fields every critical result shares.
type boundedLists struct {
	Status             string   `json:"status"`
	FilesFailed        int      `json:"filesFailed"`
	FilesVerified      int      `json:"filesVerified"`
	FilesRestored      int      `json:"filesRestored"`
	FailedFiles        []string `json:"failedFiles"`
	Warnings           []string `json:"warnings"`
	FailedFilesOmitted int      `json:"failedFilesOmitted"`
	WarningsOmitted    int      `json:"warningsOmitted"`
	Error              string   `json:"error"`
}

func decodeBounded(t *testing.T, stdout string) boundedLists {
	t.Helper()
	var out boundedLists
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	return out
}

// assertWithinServerLimits checks every limit the server's critical schemas
// enforce on the fields these tests exercise.
func assertWithinServerLimits(t *testing.T, fitted backupipc.BackupCommandResult, out boundedLists) {
	t.Helper()
	if len(fitted.Stdout) > wire.CriticalResultBudget {
		t.Errorf("stdout is %d bytes, over the %d-byte critical result budget", len(fitted.Stdout), wire.CriticalResultBudget)
	}
	if len(out.FailedFiles) > wire.CriticalResultFailedFilesMax {
		t.Errorf("failedFiles has %d entries, over the server's %d", len(out.FailedFiles), wire.CriticalResultFailedFilesMax)
	}
	if len(out.Warnings) > wire.CriticalResultWarningsMax {
		t.Errorf("warnings has %d entries, over the server's %d", len(out.Warnings), wire.CriticalResultWarningsMax)
	}
	for _, list := range [][]string{out.FailedFiles, out.Warnings} {
		for i, s := range list {
			if s == "" {
				t.Errorf("entry %d is empty; the server requires min(1)", i)
			}
			if n := utf8.RuneCountInString(s); n > wire.CriticalResultListEntryMaxChars {
				t.Errorf("entry %d is %d code points, over the server's %d", i, n, wire.CriticalResultListEntryMaxChars)
			}
			if !utf8.ValidString(s) {
				t.Errorf("entry %d is not valid UTF-8", i)
			}
		}
	}
	if n := utf8.RuneCountInString(out.Error); n > wire.CriticalResultErrorMaxChars {
		t.Errorf("error is %d code points, over the server's %d", n, wire.CriticalResultErrorMaxChars)
	}
}

func TestFitCriticalResultBoundsVerifyLists(t *testing.T) {
	verify := backup.VerifyResult{
		SnapshotID:    "snap-1",
		Status:        "failed",
		FilesVerified: 120000,
		FilesFailed:   manyFailedFiles,
		FailedFiles:   manyPaths(manyFailedFiles),
		Warnings:      manyWarningTexts(manyWarnings),
	}
	fitted, notes, _ := fitBackupResultForCommand("backup_verify", criticalResultFor(t, verify))
	if notes == "" {
		t.Fatal("expected the oversize lists to be reported as bounded")
	}
	out := decodeBounded(t, fitted.Stdout)
	assertWithinServerLimits(t, fitted, out)

	if out.Status != "failed" || out.FilesFailed != manyFailedFiles || out.FilesVerified != 120000 {
		t.Fatalf("counts/status changed: status=%q filesFailed=%d filesVerified=%d", out.Status, out.FilesFailed, out.FilesVerified)
	}
	if len(out.FailedFiles) == 0 {
		t.Fatal("failedFiles was dropped entirely; it should be bounded, not removed")
	}
	if got := len(out.FailedFiles) + out.FailedFilesOmitted; got != manyFailedFiles {
		t.Errorf("failedFiles kept (%d) + omitted (%d) = %d, want %d", len(out.FailedFiles), out.FailedFilesOmitted, got, manyFailedFiles)
	}
	// Deterministic: the first N, in order.
	for i, p := range out.FailedFiles {
		if p != realisticPath(i) {
			t.Fatalf("failedFiles[%d] = %q, want the first entries in order", i, p)
		}
	}
	last := out.Warnings[len(out.Warnings)-1]
	if !strings.Contains(last, fmt.Sprintf("%d more failed file", out.FailedFilesOmitted)) {
		t.Errorf("last warning %q does not say how many failed files were not listed", last)
	}
	if got := len(out.Warnings) - 1 + out.WarningsOmitted; got != manyWarnings {
		t.Errorf("warnings kept (%d, excluding the note) + omitted (%d) = %d, want %d", len(out.Warnings)-1, out.WarningsOmitted, got, manyWarnings)
	}
}

func TestFitCriticalResultBoundsTestRestoreLists(t *testing.T) {
	tr := backup.TestRestoreResult{
		SnapshotID:    "snap-1",
		Status:        "partial",
		FilesVerified: 9000,
		FilesFailed:   manyFailedFiles,
		RestorePath:   `C:\ProgramData\Breeze\test-restore`,
		CleanedUp:     true,
		FailedFiles:   manyPaths(manyFailedFiles),
		Warnings:      manyWarningTexts(manyWarnings),
	}
	fitted, _, _ := fitBackupResultForCommand("backup_test_restore", criticalResultFor(t, tr))
	out := decodeBounded(t, fitted.Stdout)
	assertWithinServerLimits(t, fitted, out)
	if out.Status != "partial" || out.FilesFailed != manyFailedFiles || out.FilesVerified != 9000 {
		t.Fatalf("counts/status changed: %+v", out)
	}
	if len(out.FailedFiles)+out.FailedFilesOmitted != manyFailedFiles {
		t.Errorf("kept+omitted failed files = %d, want %d", len(out.FailedFiles)+out.FailedFilesOmitted, manyFailedFiles)
	}
}

func TestFitCriticalResultBoundsRestoreLists(t *testing.T) {
	restore := backup.RestoreResult{
		SnapshotID:    "snap-1",
		Status:        "partial",
		FilesRestored: 40000,
		FilesFailed:   manyFailedFiles,
		FailedFiles:   manyPaths(manyFailedFiles),
		Warnings:      manyWarningTexts(manyWarnings),
		Error:         strings.Repeat("x", 25000),
	}
	fitted, _, _ := fitBackupResultForCommand("backup_restore", criticalResultFor(t, restore))
	out := decodeBounded(t, fitted.Stdout)
	assertWithinServerLimits(t, fitted, out)
	if out.Status != "partial" || out.FilesFailed != manyFailedFiles || out.FilesRestored != 40000 {
		t.Fatalf("counts/status changed: %+v", out)
	}
	if out.Error == "" {
		t.Error("error was dropped; it should be truncated")
	}
}

// Within the count limits, but long entries push the body past the 512 KiB
// structured cap: the lists shrink further rather than being dropped.
func TestFitCriticalResultShrinksListsToTheByteBudget(t *testing.T) {
	paths := make([]string, wire.CriticalResultFailedFilesMax)
	for i := range paths {
		paths[i] = fmt.Sprintf("/srv/share/%s/file_%04d.bin", strings.Repeat("deep-directory/", 180), i)
	}
	verify := backup.VerifyResult{SnapshotID: "snap-1", Status: "failed", FilesFailed: len(paths), FailedFiles: paths}
	in := criticalResultFor(t, verify)
	if len(in.Stdout) <= wire.CriticalResultStructuredMaxBytes {
		t.Fatalf("fixture is %d bytes; it must exceed the structured cap to test anything", len(in.Stdout))
	}
	fitted, _, _ := fitBackupResultForCommand("backup_verify", in)
	out := decodeBounded(t, fitted.Stdout)
	assertWithinServerLimits(t, fitted, out)
	if len(out.FailedFiles) == 0 {
		t.Fatal("failedFiles was emptied; it should keep as many entries as fit")
	}
	if len(out.FailedFiles)+out.FailedFilesOmitted != len(paths) || out.FilesFailed != len(paths) {
		t.Errorf("kept %d + omitted %d, filesFailed %d; want %d", len(out.FailedFiles), out.FailedFilesOmitted, out.FilesFailed, len(paths))
	}
}

// Go measures bytes, the server counts code points: an over-long multi-byte
// entry must come out valid UTF-8 and within the code-point limit.
func TestFitCriticalResultTruncatesOverlongEntries(t *testing.T) {
	long := strings.Repeat("目录", 6000) // 12,000 code points, 36,000 bytes
	ascii := strings.Repeat("a", 9000)
	verify := backup.VerifyResult{
		SnapshotID: "snap-1", Status: "failed", FilesFailed: 3,
		FailedFiles: []string{long, ascii, ""},
		Warnings:    []string{ascii},
	}
	fitted, _, _ := fitBackupResultForCommand("backup_verify", criticalResultFor(t, verify))
	out := decodeBounded(t, fitted.Stdout)
	assertWithinServerLimits(t, fitted, out)
	if len(out.FailedFiles) != 2 {
		t.Fatalf("want the two non-empty entries kept, got %d", len(out.FailedFiles))
	}
	if !strings.HasPrefix(long, strings.TrimSuffix(out.FailedFiles[0], "…")) {
		t.Error("truncated entry is not a prefix of the original")
	}
	if out.FilesFailed != 3 {
		t.Errorf("filesFailed = %d, want 3 unchanged", out.FilesFailed)
	}
}

// An agent-provided omitted count is added to, not overwritten.
func TestFitCriticalResultAddsToAnExistingOmittedCount(t *testing.T) {
	body := map[string]any{
		"snapshotId": "snap-1", "status": "failed", "filesFailed": 3000,
		"failedFiles":        manyPaths(1500),
		"failedFilesOmitted": 1500,
	}
	fitted, _, _ := fitBackupResultForCommand("backup_verify", criticalResultFor(t, body))
	out := decodeBounded(t, fitted.Stdout)
	if len(out.FailedFiles)+out.FailedFilesOmitted != 3000 {
		t.Errorf("kept %d + omitted %d, want 3000", len(out.FailedFiles), out.FailedFilesOmitted)
	}
}

func TestFitCriticalResultLeavesASmallResultUntouched(t *testing.T) {
	verify := backup.VerifyResult{
		SnapshotID: "snap-1", Status: "failed", FilesVerified: 10, FilesFailed: 2,
		FailedFiles: manyPaths(2), Warnings: manyWarningTexts(3),
	}
	in := criticalResultFor(t, verify)
	fitted, notes, _ := fitBackupResultForCommand("backup_verify", in)
	if notes != "" || fitted.Stdout != in.Stdout {
		t.Fatalf("a small result was rewritten (notes %q)", notes)
	}
}

// bmr_recover reports failedFiles as a count, not a list.
func TestFitCriticalResultKeepsANumericFailedFiles(t *testing.T) {
	in := criticalResultFor(t, map[string]any{"status": "completed", "failedFiles": 7, "code": "ok"})
	fitted, notes, _ := fitBackupResultForCommand("bmr_recover", in)
	if notes != "" || fitted.Stdout != in.Stdout {
		t.Fatalf("a numeric failedFiles was rewritten: %q (notes %q)", fitted.Stdout, notes)
	}
}

// A restore whose bulk is the restricted-descriptor path list: that list is
// trimmed to the server's own limit, and the few failed files are kept rather
// than being cut to make room for it.
func TestFitCriticalResultTrimsQuarantinedPathsBeforeFailedFiles(t *testing.T) {
	quarantined := make([]string, 20000)
	for i := range quarantined {
		quarantined[i] = fmt.Sprintf(`C:\Data\Shared\Finance\ledger_%06d.xlsx`, i)
	}
	restore := backup.RestoreResult{
		SnapshotID: "snap-1", Status: "completed", FilesRestored: 20000, FilesFailed: 3,
		FailedFiles:                        manyPaths(3),
		SecurityDescriptorQuarantined:      len(quarantined),
		SecurityDescriptorQuarantinedPaths: quarantined,
	}
	in := criticalResultFor(t, restore)
	if len(in.Stdout) <= wire.CriticalResultBudget {
		t.Fatalf("fixture is %d bytes; it must exceed the critical budget", len(in.Stdout))
	}
	fitted, _, _ := fitBackupResultForCommand("backup_restore", in)
	var out backup.RestoreResult
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.FailedFiles) != 3 {
		t.Errorf("failedFiles kept %d of 3; the quarantine list should give way, not the failed files", len(out.FailedFiles))
	}
	if out.SecurityDescriptorQuarantined != len(quarantined) {
		t.Errorf("securityDescriptorQuarantined = %d, want %d", out.SecurityDescriptorQuarantined, len(quarantined))
	}
	if n := len(out.SecurityDescriptorQuarantinedPaths); n == 0 || n > wire.CriticalResultQuarantinedPathsMax {
		t.Errorf("quarantined paths kept %d, want 1..%d", n, wire.CriticalResultQuarantinedPathsMax)
	}
	for _, p := range out.SecurityDescriptorQuarantinedPaths {
		if n := utf8.RuneCountInString(p); n > wire.CriticalResultQuarantinedPathMaxChars {
			t.Errorf("quarantined path is %d code points, over %d", n, wire.CriticalResultQuarantinedPathMaxChars)
		}
	}
}

// backup_run is not a critical family: its snapshot index rides the general
// 5 MB budget and must not be held to the 512 KiB critical one.
func TestFitCriticalResultIgnoresBackupRun(t *testing.T) {
	result := mustRunResult(t, buildLargeRunJob(qaResidualFileCount, 3))
	if len(result.Stdout) <= wire.CriticalResultStructuredMaxBytes {
		t.Fatalf("fixture is %d bytes; it must exceed the critical cap to prove backup_run ignores it", len(result.Stdout))
	}
	fitted, notes, _ := fitBackupResultForCommand("backup_run", result)
	if notes != "" || fitted.Stdout != result.Stdout {
		t.Fatalf("backup_run result was degraded under the critical budget (notes %q)", notes)
	}
}
