package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/backupipc"
)

// Every operator-facing degradation signal the backup path emits travels in ONE
// field: BackupJob.Warning (`warning` on the wire). appendWarning in
// internal/backup/backup.go joins them with "; " — the live-volume read note
// (#3025/#3027), the uncaptured-system-state-artifacts note (#3029), the
// partial-upload summary, the system-state-not-collected note. The server
// persists that string to the job's errorLog and the UI renders it; nothing
// else carries them. The bounding tiers then append notes of their own saying
// what they dropped, and those notes are the only thing distinguishing "this
// snapshot has no files" from "we deleted the index to fit the IPC frame".
//
// So the tiers in result_bounds.go have a hard invariant, and these tests are
// its enforcement:
//
//	A tier may TRUNCATE the run's own warning text and may APPEND its own
//	notes. No tier may REPLACE the text, and no tier may evict a note — its
//	own or an earlier tier's.
//
// The failure mode this guards is quiet by construction: a warning that lost a
// note still looks like a perfectly ordinary warning. Nothing downstream can
// tell, which is why it has to be pinned here rather than reasoned about.

// operatorWarning is a stand-in for the real signals: the live-volume read note
// plus the uncaptured-artifacts note, joined the way appendWarning joins them.
const operatorWarning = "read from the live volume, not the VSS shadow copy: C:\\ProgramData\\breeze; " +
	"system state artifacts were not captured: the manifest described 7 artifacts but none reached the snapshot"

// atCapWarning is operatorWarning padded past maxResultTextBytes — the whole
// warning budget, not just the text share. Several of these tests only bite
// when a clamp actually fires: below the cap a clamp is a no-op and an eviction
// bug is invisible. Padding to the LARGEST cap in the file rather than to the
// text budget keeps that true no matter how the budget is later split.
func atCapWarning() string {
	return operatorWarning + "; " + strings.Repeat("filler ", maxResultTextBytes/7)
}

// fittedWarning runs a result through the real bounding logic and returns the
// warning the server would end up reading, plus the degradation note naming the
// tiers that fired.
func fittedWarning(t *testing.T, in backupCommandResultFixture) (warning string, degraded string) {
	t.Helper()
	fitted, degraded := fitBackupResultForDelivery(in.result())
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	var out struct {
		Warning string `json:"warning"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	return out.Warning, degraded
}

// assertTerminalTier pins WHICH tier the fixture ended at. `degraded`
// accumulates a note per tier that fired, so a bare Contains check reads as "at
// least this tier ran" and keeps passing if a fixture drifts into a later tier
// — silently retiring the test. Naming the tiers that must NOT appear is what
// keeps each fixture pinned to the tier it was built to exercise.
func assertTerminalTier(t *testing.T, degraded, want string, forbidden ...string) {
	t.Helper()
	if !strings.Contains(degraded, want) {
		t.Fatalf("expected the %q tier to fire, got %q", want, degraded)
	}
	for _, later := range forbidden {
		if strings.Contains(degraded, later) {
			t.Fatalf("fixture drifted past its tier: %q also fired (%q)", later, degraded)
		}
	}
}

const (
	tier2IndexNote  = "snapshot file index dropped"
	tier3ScalarNote = "result reduced to summary scalars only"
	tier4Note       = "result replaced with a minimal terminal status"
)

// --- fixtures ---

// backupCommandResultFixture is a lazily-marshalled stdout body. The tier-4
// fixtures are ~36 MB of JSON and the package already builds two of them; going
// through a builder keeps the new tests from adding two more full builds to a
// suite that runs under -race.
type backupCommandResultFixture struct {
	commandID string
	stdout    func() string
}

func (f backupCommandResultFixture) result() backupipc.BackupCommandResult {
	return backupipc.BackupCommandResult{CommandID: f.commandID, Success: true, Stdout: f.stdout()}
}

// tier2Stdout builds a body that tier 2 can absorb but only by BOTH of its
// appends firing: a snapshot index to empty and a bulk container to drop. That
// pairing is the point — a single append can never evict anything, so a fixture
// with only one of them cannot detect note eviction at all.
//
// 200 files is enough for the index note; the oversize container is what puts
// the body over budget, so this does not need the package's 60k-file job.
func tier2Stdout(warning string) func() string {
	return func() string {
		files := make([]map[string]any, 200)
		for i := range files {
			files[i] = map[string]any{
				"sourcePath": fmt.Sprintf("C:\\Users\\operator\\Documents\\report-%04d.docx", i),
				"backupPath": fmt.Sprintf("snapshot-tier2/%04d.dat", i),
				"size":       4096,
			}
		}
		failed := make([]string, 4000)
		for i := range failed {
			failed[i] = strings.Repeat("x", 5*1024)
		}
		return mustJSON(map[string]any{
			"id":            "job-tier2",
			"status":        "partial",
			"filesBackedUp": 200,
			"errorCount":    17,
			"warning":       warning,
			"snapshot":      map[string]any{"id": "snapshot-tier2", "size": 819200, "files": files},
			"failedFiles":   failed,
		})
	}
}

// tier3Stdout builds a body that survives tier 2 but not its budget:
//   - `blob` is a top-level SCALAR string, so dropBulkFields leaves it alone
//     (it only drops containers) and tier 2 stays over budget;
//   - `smallDetail` is a container UNDER bulkFieldThreshold, so tier 2 keeps it
//     too and tier 3 is the tier that drops it — which is what makes tier 3
//     append its "detail field(s) omitted" note.
//
// The snapshot index is present so tier 2 leaves a note of its own behind for
// tier 3 to preserve or evict.
func tier3Stdout(warning string) func() string {
	return func() string {
		return mustJSON(map[string]any{
			"id":            "job-tier3",
			"status":        "completed",
			"filesBackedUp": 42,
			"warning":       warning,
			"snapshot": map[string]any{
				"id":    "snapshot-tier3",
				"files": []map[string]any{{"sourcePath": "C:\\a", "size": 1}},
			},
			"smallDetail": []string{"a", "b", "c"},
			"blob":        strings.Repeat("z", 20<<20),
		})
	}
}

// tier4ScalarTail is the only way tier 4 can be forced: thousands of oversized
// top-level scalars. Tier 3 keeps every scalar (clamped), so a body with enough
// of them is still over budget afterwards. No body the helper produces today
// has this shape — tier 4 is a defensive tier — which is exactly why its
// behaviour has to be pinned by a test rather than by inspection.
//
// Memoised: it is ~36 MB and two tests below need it.
var tier4ScalarTail = sync.OnceValue(func() string {
	var b strings.Builder
	blob := strings.Repeat("z", 12*1024)
	for i := 0; i < 3000; i++ {
		fmt.Fprintf(&b, `,"note%04d":"%s"`, i, blob)
	}
	return b.String()
})

func tier4Stdout(warning string) func() string {
	return func() string {
		var b strings.Builder
		b.WriteString(`{"id":"job-tier4","status":"partial","snapshotId":"snapshot-tier4"`)
		b.WriteString(`,"warning":` + mustJSONString(warning))
		b.WriteString(tier4ScalarTail())
		b.WriteString("}")
		return b.String()
	}
}

// --- tests ---

// TestTier2PreservesWarningAndBothNotes covers the only tier that fires in the
// field (#3001: 123k files, index emptied, bulk detail dropped). Tier 2 appends
// twice, so it is the tier where an eviction bug actually reaches customers:
// with the warning at its cap, the second append's clamp would delete the first
// append's note, and the snapshot-file-index note is the highest-value signal
// in the file — without it the server records hasIndexedFiles=false with
// nothing saying why.
func TestTier2PreservesWarningAndBothNotes(t *testing.T) {
	warning, degraded := fittedWarning(t, backupCommandResultFixture{
		commandID: "cmd-tier2-warning",
		stdout:    tier2Stdout(atCapWarning()),
	})

	assertTerminalTier(t, degraded, tier2IndexNote, tier3ScalarNote, tier4Note)
	if !strings.Contains(warning, "read from the live volume") {
		t.Errorf("tier 2 lost the live-volume signal; warning = %.200q", warning)
	}
	if !strings.Contains(warning, "snapshot file index omitted") {
		t.Errorf("tier 2's snapshot-index note was evicted by its own second append; warning = %.400q", warning)
	}
	if !strings.Contains(warning, "failedFiles") {
		t.Errorf("tier 2 dropped failedFiles without recording it; warning = %.400q", warning)
	}
}

// TestTier3KeepsEveryNote pins that tier 3 preserves tier 2's notes as well as
// its own. Both are at the tail of the warning, which is exactly where a
// head-keeping clamp cuts.
func TestTier3KeepsEveryNote(t *testing.T) {
	warning, degraded := fittedWarning(t, backupCommandResultFixture{
		commandID: "cmd-tier3-warning",
		stdout:    tier3Stdout(atCapWarning()),
	})

	assertTerminalTier(t, degraded, tier3ScalarNote, tier4Note)
	if !strings.Contains(warning, "read from the live volume") {
		t.Errorf("tier 3 lost the live-volume signal; warning = %.200q", warning)
	}
	if !strings.Contains(warning, "snapshot file index omitted") {
		t.Errorf("tier 3 evicted tier 2's snapshot-index note; warning = %.400q", warning)
	}
	if !strings.Contains(warning, "smallDetail") {
		t.Errorf("tier 3 dropped smallDetail without recording it; warning = %.400q", warning)
	}
}

// TestTier4PreservesOperatorWarning is the core assertion for the last tier.
// lastResortStdout builds a fresh object from a four-key keep-list that does
// not include `warning`, so the run's own account of itself has to be carried
// across deliberately rather than rebuilt.
func TestTier4PreservesOperatorWarning(t *testing.T) {
	warning, degraded := fittedWarning(t, backupCommandResultFixture{
		commandID: "cmd-tier4-warning",
		stdout:    tier4Stdout(operatorWarning),
	})

	assertTerminalTier(t, degraded, tier4Note)
	if !strings.Contains(warning, "read from the live volume") {
		t.Errorf("tier 4 replaced the live-volume signal instead of appending to it; warning = %.300q", warning)
	}
	if !strings.Contains(warning, "system state artifacts were not captured") {
		t.Errorf("tier 4 replaced the uncaptured-artifacts signal; warning = %.300q", warning)
	}
	// The tier still has to say what it did — a preserved warning that hid the
	// truncation would be its own kind of lie.
	if !strings.Contains(warning, limitExceededPhrase) {
		t.Errorf("tier 4 stopped explaining itself; warning = %.300q", warning)
	}
}

// TestTier4BoundsThePreservedWarning pins that carrying the warning across did
// not cost tier 4 its "always fits" postcondition: a pathological multi-megabyte
// warning must still come out bounded, note intact.
func TestTier4BoundsThePreservedWarning(t *testing.T) {
	warning, degraded := fittedWarning(t, backupCommandResultFixture{
		commandID: "cmd-tier4-huge",
		stdout:    tier4Stdout(strings.Repeat("w", 4<<20)),
	})

	assertTerminalTier(t, degraded, tier4Note)
	if len(warning) > maxResultTextBytes {
		t.Errorf("tier 4 left the warning unbounded at %d bytes", len(warning))
	}
	if !strings.Contains(warning, limitExceededPhrase) {
		t.Errorf("tier 4 stopped explaining itself; warning = %.300q", warning)
	}
}

// TestBoundingNotesAreIndividuallyCapped pins that one note cannot consume the
// reserve the others need.
//
// dropBulkFields renders every dropped key name into its note via
// strings.Join, which is bounded by nothing on a wide body. Two harms follow if
// that note is left uncapped: the warning itself grows without limit into the
// job's errorLog and the UI, and — because the note reserve is clamped
// head-first, like everything else here — one enormous early note crowds out
// the notes appended after it. This fixture drives BOTH by running a
// 400-bulk-field body all the way to tier 4, so tier 2's note and tier 4's note
// are competing for the same reserve.
func TestBoundingNotesAreIndividuallyCapped(t *testing.T) {
	stdout := func() string {
		var b strings.Builder
		b.WriteString(`{"id":"job-wide","status":"completed"`)
		b.WriteString(`,"warning":` + mustJSONString(operatorWarning))
		for i := 0; i < 400; i++ {
			fmt.Fprintf(&b, `,"bulkFieldWithAnInconvenientlyLongName%04d":["%s"]`, i, strings.Repeat("q", 5*1024))
		}
		b.WriteString(tier4ScalarTail())
		b.WriteString("}")
		return b.String()
	}
	warning, degraded := fittedWarning(t, backupCommandResultFixture{
		commandID: "cmd-wide",
		stdout:    stdout,
	})

	assertTerminalTier(t, degraded, tier4Note)
	if len(warning) > maxResultTextBytes {
		t.Errorf("the omitted-fields note is unbounded: warning is %d bytes", len(warning))
	}
	if !strings.Contains(warning, "read from the live volume") {
		t.Errorf("the operator signal was evicted by an oversized note; warning = %.300q", warning)
	}
	if !strings.Contains(warning, limitExceededPhrase) {
		t.Errorf("an oversized earlier note crowded the last tier's note out of the reserve; warning = %.400q", warning)
	}
}

// TestCleanRunWarningIsJustTheNotes covers the majority case these tests
// otherwise all miss: a run with NO warning of its own, degraded only by the
// bounding. Every other fixture seeds a warning, so nothing here would notice
// the composed field acquiring a dangling boundary marker where the run's text
// should have been — which lands verbatim in the job's errorLog and the UI.
func TestCleanRunWarningIsJustTheNotes(t *testing.T) {
	warning, degraded := fittedWarning(t, backupCommandResultFixture{
		commandID: "cmd-clean-run",
		stdout:    tier2Stdout(""),
	})

	assertTerminalTier(t, degraded, tier2IndexNote, tier3ScalarNote, tier4Note)
	if !strings.HasPrefix(warning, resultNoteLabel+"snapshot file index omitted") {
		t.Errorf("a clean run's warning should be the label and its notes, got %.200q", warning)
	}
	// The full marker separates text from notes. With no text there is nothing
	// to separate, so emitting it would leave the warning opening on dangling
	// punctuation in the UI.
	if strings.Contains(warning, resultNoteMarker) {
		t.Errorf("a clean run's warning carries a boundary marker with no text on either side: %.200q", warning)
	}
	// Both of tier 2's notes still have to be there: the all-notes form is only
	// safe if a second append can still find the boundary.
	if !strings.Contains(warning, "failedFiles") {
		t.Errorf("the second append read the first note back as run text; warning = %.300q", warning)
	}
}

// TestRunWarningContainingTheMarkerCannotEvictNotes closes the one input-driven
// escape hatch from the split. The marker is a plain string, and the run's own
// warning embeds file paths and provider error text — so if a run's text ever
// contained the literal, splitResultWarning would read everything past it as
// "notes", overflow the note reserve, and clamp the real notes off the tail.
// That is precisely the failure the split exists to prevent, reintroduced from
// untrusted input, so it has to be neutralised rather than assumed away.
func TestRunWarningContainingTheMarkerCannotEvictNotes(t *testing.T) {
	hostile := "vss snapshot failed" + resultNoteMarker + strings.Repeat("payload ", 1024)

	warning, degraded := fittedWarning(t, backupCommandResultFixture{
		commandID: "cmd-marker-collision",
		stdout:    tier2Stdout(hostile),
	})

	assertTerminalTier(t, degraded, tier2IndexNote, tier3ScalarNote, tier4Note)
	if !strings.Contains(warning, "snapshot file index omitted") {
		t.Errorf("a marker in the run's own text evicted tier 2's index note; warning = %.400q", warning)
	}
	if !strings.Contains(warning, "failedFiles") {
		t.Errorf("a marker in the run's own text evicted tier 2's bulk-field note; warning = %.400q", warning)
	}
	if !strings.Contains(warning, "vss snapshot failed") {
		t.Errorf("the run's own signal was lost; warning = %.400q", warning)
	}
	if len(warning) > maxResultTextBytes {
		t.Errorf("composed warning is %d bytes, over the %d total budget", len(warning), maxResultTextBytes)
	}
}

// TestNotesSurviveAnOversizedWarningText is the invariant at unit level, and
// the one assertion here that does not depend on any particular body reaching
// any particular tier.
//
// The original defect was that appending re-clamped the WHOLE accumulated
// warning head-first, so the moment the text was at the cap each append deleted
// the note appended before it. Composing text and notes against separate
// budgets is what makes that structurally impossible rather than a consequence
// of the caps happening to leave enough slack.
func TestNotesSurviveAnOversizedWarningText(t *testing.T) {
	warning := appendResultWarning(mustRawString(strings.Repeat("t", 4<<20)), "first note")
	warning = appendResultWarning(mustRawString(warning), "second note")
	warning = appendResultWarning(mustRawString(warning), "third note")

	for _, want := range []string{"first note", "second note", "third note"} {
		if !strings.Contains(warning, want) {
			t.Errorf("%q was evicted by a later append; warning = %.300q", want, warning)
		}
	}
	if len(warning) > maxResultTextBytes {
		t.Errorf("composed warning is %d bytes, over the %d total budget", len(warning), maxResultTextBytes)
	}
}

// TestNonStringWarningIsNotSilentlyDropped pins that a `warning` these tiers
// cannot parse is carried through rather than replaced. The tiers are
// deliberately shape-agnostic about command bodies, so a future body whose
// warning is not a plain string must not lose it silently.
func TestNonStringWarningIsNotSilentlyDropped(t *testing.T) {
	got := appendResultWarning(json.RawMessage(`{"detail":"structured warning"}`), "bounding note")
	if !strings.Contains(got, "structured warning") {
		t.Errorf("a non-string warning was discarded instead of carried: %q", got)
	}
	if !strings.Contains(got, "bounding note") {
		t.Errorf("the bounding note did not land: %q", got)
	}
}

// --- helpers ---

func mustJSON(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(data)
}

func mustJSONString(s string) string { return mustJSON(s) }
