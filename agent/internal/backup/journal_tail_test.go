package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	pathpkg "path/filepath"
	"strings"
	"testing"
	"time"
)

const tornTestIdentity = "identity-torn"

func tornTestEntry(name string) SnapshotFile {
	return SnapshotFile{
		SourcePath: "/" + name,
		BackupPath: "snapshots/x/files/" + name + ".gz",
		Size:       3,
		ModTime:    time.Now().Add(-time.Hour).UTC().Truncate(time.Second),
		Checksum:   strings.Repeat("a", 64),
	}
}

func openTornTestJournal(t *testing.T, dir string) (*snapshotJournal, bool) {
	t.Helper()
	j, resumed, err := openSnapshotJournal(dir, tornTestIdentity, journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal: %v", err)
	}
	return j, resumed
}

// seedTornTestJournal writes a real journal holding entries a and b, the way a
// run does, and returns its path and snapshot id. b carries a record when
// verifyB is set.
func seedTornTestJournal(t *testing.T, dir string, verifyB bool) (string, string) {
	t.Helper()
	j, _ := openTornTestJournal(t, dir)
	if err := j.BindRun("job-1", "base-1"); err != nil {
		t.Fatal(err)
	}
	if err := j.Record(tornTestEntry("a")); err != nil {
		t.Fatal(err)
	}
	if err := j.Record(tornTestEntry("b")); err != nil {
		t.Fatal(err)
	}
	if verifyB {
		err := j.recordVerification(tornTestEntry("b"), journalVerification{
			StoredObjectCheck: storedCheckOK,
			VerifiedAt:        time.Now().UTC(),
			BaseGeneration:    j.baseGeneration(),
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	j.Abandon()
	return j.path, j.snapshotID
}

func appendRaw(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

// longFragment is a torn entry line longer than the line repairing it, so only
// truncating the tail removes all of it.
func longFragment(t *testing.T) string {
	t.Helper()
	e := tornTestEntry("c-" + strings.Repeat("c", 2000))
	raw, err := json.Marshal(journalEntryLine{SnapshotFile: e})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw[:len(raw)-5])
}

func requireEntries(t *testing.T, j *snapshotJournal, names ...string) {
	t.Helper()
	if len(j.entries) != len(names) {
		t.Errorf("entries = %d, want %d (%v)", len(j.entries), len(names), names)
	}
	for _, n := range names {
		if _, ok := j.entries["/"+n]; !ok {
			t.Errorf("entry %s is missing", n)
		}
	}
}

// requireWellFormedFile fails unless every line of the journal is terminated and
// is JSON an older reader can parse.
func requireWellFormedFile(t *testing.T, path string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) == 0 || raw[len(raw)-1] != '\n' {
		t.Fatalf("journal does not end in a newline: %q", tailOf(raw))
	}
	for i, line := range bytes.Split(bytes.TrimSuffix(raw, []byte("\n")), []byte("\n")) {
		if !json.Valid(line) {
			t.Fatalf("line %d is not JSON: %q", i, tailOf(line))
		}
	}
}

func tailOf(b []byte) []byte {
	if len(b) > 200 {
		return b[len(b)-200:]
	}
	return b
}

func TestJournalTornTail_KeepsEveryEntryBeforeIt(t *testing.T) {
	dir := t.TempDir()
	path, id := seedTornTestJournal(t, dir, false)
	appendRaw(t, path, longFragment(t))

	j, resumed := openTornTestJournal(t, dir)
	defer j.Abandon()
	if !resumed {
		t.Fatal("a torn last line must not discard the journal")
	}
	if j.snapshotID != id {
		t.Errorf("snapshot id = %q, want %q", j.snapshotID, id)
	}
	requireEntries(t, j, "a", "b")
	if got, want := j.ResumedBytes(), int64(6); got != want {
		t.Errorf("ResumedBytes = %d, want %d", got, want)
	}
	if h := j.Header(); h.JobID != "job-1" || h.DispatchedBaseSnapshotID != "base-1" {
		t.Errorf("run bindings lost: %+v", h)
	}
}

// What counts as torn: the last line, when it is unterminated or unparseable.
func TestJournalTornTail_Shapes(t *testing.T) {
	entryLine, err := json.Marshal(journalEntryLine{SnapshotFile: tornTestEntry("c")})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"partial entry":                  string(entryLine[:20]),
		"one byte":                       "{",
		"whole line missing its newline": string(entryLine),
		"partial header update":          `{"headerUpdate":{"snapshotId":"x","jobId":"other-j`,
		"zeroes from a power loss":       strings.Repeat("\x00", 4096),
		"a lone carriage return":         "\r",
		"unparseable, terminated":        `{"sourcePath":"/c` + "\n",
		"unparseable, then blank lines":  `{"sourcePath":"/c` + "\n\n\n",
		"not JSON at all, terminated":    "garbage\n",
	}
	for name, tail := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path, id := seedTornTestJournal(t, dir, false)
			appendRaw(t, path, tail)

			j, resumed := openTornTestJournal(t, dir)
			if !resumed || j.snapshotID != id {
				t.Fatalf("resumed = %v, snapshot %q, want the journal kept", resumed, j.snapshotID)
			}
			requireEntries(t, j, "a", "b")
			if h := j.Header(); h.JobID != "job-1" {
				t.Errorf("the torn line reached the header: %+v", h)
			}
			j.Abandon()
			requireWellFormedFile(t, path)
		})
	}
}

// Without the repair the next append lands on the fragment and turns the journal
// into one the next open has to discard, or loses that append.
func TestJournalTornTail_NextAppendIsWellFormed(t *testing.T) {
	dir := t.TempDir()
	path, id := seedTornTestJournal(t, dir, false)
	appendRaw(t, path, longFragment(t))

	j, _ := openTornTestJournal(t, dir)
	if err := j.Record(tornTestEntry("d")); err != nil {
		t.Fatal(err)
	}
	j.Abandon()

	requireWellFormedFile(t, path)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte(strings.Repeat("c", 100))) {
		t.Error("the torn fragment is still in the journal")
	}

	j2, resumed := openTornTestJournal(t, dir)
	defer j2.Abandon()
	if !resumed || j2.snapshotID != id {
		t.Fatalf("resumed = %v, snapshot %q, want %q", resumed, j2.snapshotID, id)
	}
	requireEntries(t, j2, "a", "b", "d")
}

func TestJournalTornTail_AnythingButTheLastLineIsCorruption(t *testing.T) {
	entryLine, err := json.Marshal(journalEntryLine{SnapshotFile: tornTestEntry("c")})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"malformed line, then an entry":         `{"sourcePath":"/torn` + "\n" + string(entryLine) + "\n",
		"malformed update, then an entry":       `{"headerUpdate":{"jobId":"x` + "\n" + string(entryLine) + "\n",
		"two malformed lines":                   `{"sourcePath":"/x` + "\n" + `{"sourcePath":"/y` + "\n",
		"malformed line, then a fragment":       `{"sourcePath":"/x` + "\n" + `{"sourcePath":"/y`,
		"malformed line, a blank, then a whole": `{"sourcePath":"/x` + "\n\n" + string(entryLine) + "\n",
	}
	for name, tail := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path, id := seedTornTestJournal(t, dir, false)
			appendRaw(t, path, tail)

			j, resumed := openTornTestJournal(t, dir)
			defer j.Abandon()
			if resumed {
				t.Fatal("a malformed line that is not the last one must discard the journal")
			}
			if j.snapshotID == id {
				t.Error("a discarded journal must start a new snapshot")
			}
			requireEntries(t, j)
		})
	}
}

// A torn header names no snapshot, so there is nothing to keep, even when only
// its newline is missing.
func TestJournalTornTail_TheHeaderIsNeverTolerated(t *testing.T) {
	full, err := json.Marshal(journalHeader{SnapshotID: "snapshot-h", CreatedAt: time.Now().UTC(),
		Identity: tornTestIdentity, FormatVersion: journalFormatVersion})
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]string{
		"partial header":         string(full[:20]),
		"header with no newline": string(full),
		"garbage header":         "garbage\n",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := pathpkg.Join(dir, journalFileName(tornTestIdentity))
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			j, resumed := openTornTestJournal(t, dir)
			defer j.Abandon()
			if resumed || j.snapshotID == "snapshot-h" {
				t.Fatalf("resumed = %v, snapshot %q, want a new snapshot", resumed, j.snapshotID)
			}
		})
	}
}

// A complete journal, however it ends, is left byte for byte as it was and keeps
// its records.
func TestJournalTornTail_CleanEndingsAreLeftAlone(t *testing.T) {
	for name, tail := range map[string]string{
		"ends in a newline": "",
		"one blank line":    "\n",
		"two blank lines":   "\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path, id := seedTornTestJournal(t, dir, true)
			appendRaw(t, path, tail)
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}

			j, resumed := openTornTestJournal(t, dir)
			defer j.Abandon()
			if !resumed || j.snapshotID != id {
				t.Fatalf("resumed = %v, snapshot %q", resumed, j.snapshotID)
			}
			requireEntries(t, j, "a", "b")
			if _, ok := j.verifications["/b"]; !ok {
				t.Error("a complete journal lost its record")
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Errorf("a complete journal was rewritten:\n%q\n%q", tailOf(before), tailOf(after))
			}
		})
	}
}

func TestJournalTornTail_ATornRecordKeepsTheEntryItExtends(t *testing.T) {
	dir := t.TempDir()
	path, _ := seedTornTestJournal(t, dir, false)
	raw, err := json.Marshal(journalEntryLine{SnapshotFile: tornTestEntry("b"), Verification: &journalVerification{
		StoredObjectCheck: storedCheckOK, VerifiedAt: time.Now().UTC(), BaseGeneration: "generation",
	}})
	if err != nil {
		t.Fatal(err)
	}
	appendRaw(t, path, string(raw[:len(raw)-10]))

	j, resumed := openTornTestJournal(t, dir)
	defer j.Abandon()
	if !resumed {
		t.Fatal("a torn record must not discard the journal")
	}
	e := tornTestEntry("b")
	if _, ok := j.Lookup("/b", e.Size, e.ModTime); !ok {
		t.Error("the entry the torn record extends was lost")
	}
	if _, ok := j.verifications["/b"]; ok {
		t.Error("a torn record must not count as evidence")
	}
}

// The torn line may be the retraction of a record, and a writer whose flush
// failed loses every line after it, so no record older than a tear can be
// trusted. The drop has to outlive the repair: once the fragment is gone, a later
// open has nothing left to tell it the records are stale.
func TestJournalTornTail_DropsEveryRecordDurably(t *testing.T) {
	dir := t.TempDir()
	path, _ := seedTornTestJournal(t, dir, true)
	appendRaw(t, path, longFragment(t))

	j, resumed := openTornTestJournal(t, dir)
	if !resumed {
		t.Fatal("want a resume")
	}
	requireEntries(t, j, "a", "b")
	if len(j.verifications) != 0 {
		t.Errorf("records survived the tear: %v", j.verifications)
	}
	j.Abandon()

	j2, resumed := openTornTestJournal(t, dir)
	if !resumed {
		t.Fatal("want a resume")
	}
	requireEntries(t, j2, "a", "b")
	if len(j2.verifications) != 0 {
		t.Errorf("records came back on the open after the repair: %v", j2.verifications)
	}
	// A record made after the repair stands on its own.
	if err := j2.recordVerification(tornTestEntry("a"), journalVerification{
		StoredObjectCheck: storedCheckOK, VerifiedAt: time.Now().UTC(), BaseGeneration: j2.baseGeneration(),
	}); err != nil {
		t.Fatal(err)
	}
	j2.Abandon()

	j3, _ := openTornTestJournal(t, dir)
	defer j3.Abandon()
	if _, ok := j3.verifications["/a"]; !ok {
		t.Error("a record written after the repair was lost")
	}
	if _, ok := j3.verifications["/b"]; ok {
		t.Error("a record from before the tear came back")
	}
	requireWellFormedFile(t, path)
}

// A record older than a tear must not vouch for the source: the file is hashed
// again and uploaded, while an unchanged entry is still reused.
func TestResumeVerify_ATornTailKeepsTheEntriesButNotTheirRecords(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	b := settledFile(t, src, "b.txt", "bravo")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	eb := journaledEntry(t, b, brokeredJournalID, "bravo")
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha", eb.BackupPath: "bravo"})
	identity := backupIdentity(p, []string{src})
	seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)},
		journalEntryLine{SnapshotFile: eb, Verification: recordFor(storedCheckOK, time.Hour)})
	journalDir, ok := resolveJournalDir(staging)
	if !ok {
		t.Fatal("no journal dir")
	}
	appendRaw(t, pathpkg.Join(journalDir, journalFileName(identity)), longFragment(t))
	rewriteKeepingStat(t, a, "ALPHA")

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if !manifestPublished(p, brokeredJournalID) {
		t.Fatalf("the interrupted snapshot was not completed: %v", p.uploadedKeys())
	}
	if !uploadedSource(p, "a.txt") {
		t.Errorf("a record older than the tear skipped the source hash: %v", p.uploadedKeys())
	}
	if uploadedSource(p, "b.txt") {
		t.Errorf("an unchanged entry was uploaded again, the journal was not resumed: %v", p.uploadedKeys())
	}
	if p.storedDigests == 0 {
		t.Error("a record older than the tear skipped the stored read-back")
	}
}

// Disk still full: the journal cannot be repaired, but what it holds is worth far
// more than the writes this run would add. It resumes without checkpointing and
// leaves the tear for a later run to repair.
func TestJournalTornTail_AFailedRepairResumesWithoutWriting(t *testing.T) {
	dir := t.TempDir()
	path, id := seedTornTestJournal(t, dir, true)
	appendRaw(t, path, longFragment(t))
	torn, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	restore := setJournalTailRepairFnForTest(func(string, int64, journalHeader) error {
		return errors.New("no space left on device")
	})
	j, resumed := openTornTestJournal(t, dir)
	if !resumed || j.snapshotID != id {
		t.Fatalf("resumed = %v, snapshot %q, want the journal kept", resumed, j.snapshotID)
	}
	requireEntries(t, j, "a", "b")
	if len(j.verifications) != 0 {
		t.Errorf("records survived the tear: %v", j.verifications)
	}
	if err := j.Record(tornTestEntry("d")); err == nil {
		t.Error("Record must report that it wrote nothing")
	}
	if err := j.rewriteHeader(); err == nil {
		t.Error("rewriteHeader must report that it wrote nothing")
	}
	j.clearVerification("/b")
	j.Abandon()
	restore()

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(torn, after) {
		t.Fatalf("nothing may land on an unrepaired tail:\n%q", tailOf(after))
	}

	j2, resumed := openTornTestJournal(t, dir)
	defer j2.Abandon()
	if !resumed || j2.snapshotID != id {
		t.Fatalf("resumed = %v, snapshot %q, want the journal kept", resumed, j2.snapshotID)
	}
	requireEntries(t, j2, "a", "b")
	if len(j2.verifications) != 0 {
		t.Errorf("records survived the tear: %v", j2.verifications)
	}
	if err := j2.Record(tornTestEntry("d")); err != nil {
		t.Fatal(err)
	}
	requireWellFormedFile(t, path)
}

// A repair can stop at any point, and none of them may leave a journal whose stale
// records read as good again: the journal the next open sees still drops them, and
// that open finishes the repair.
func TestJournalTornTail_ARepairThatStoppedPartWayStillDropsRecords(t *testing.T) {
	cases := map[string]func(line []byte) []byte{
		"update written, fragment not cut off": func(line []byte) []byte { return line },
		"part of the update written":           func(line []byte) []byte { return line[:len(line)/2] },
	}
	for name, written := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path, id := seedTornTestJournal(t, dir, true)
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			appendRaw(t, path, longFragment(t))
			j, _ := openTornTestJournal(t, dir)
			header := j.Header()
			j.Abandon()

			// Put the tear back, then redo the repair's first step only.
			if err := os.Truncate(path, info.Size()); err != nil {
				t.Fatal(err)
			}
			appendRaw(t, path, longFragment(t))
			header.VerificationAware = false
			line, err := json.Marshal(journalHeaderUpdate{HeaderUpdate: header})
			if err != nil {
				t.Fatal(err)
			}
			f, err := os.OpenFile(path, os.O_WRONLY, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.WriteAt(written(append(line, '\n')), info.Size()); err != nil {
				t.Fatal(err)
			}
			if err := f.Close(); err != nil {
				t.Fatal(err)
			}

			j2, resumed := openTornTestJournal(t, dir)
			if !resumed || j2.snapshotID != id {
				t.Fatalf("resumed = %v, snapshot %q, want the journal kept", resumed, j2.snapshotID)
			}
			requireEntries(t, j2, "a", "b")
			if len(j2.verifications) != 0 {
				t.Errorf("records survived a repair that stopped part way: %v", j2.verifications)
			}
			j2.Abandon()
			requireWellFormedFile(t, path)

			j3, _ := openTornTestJournal(t, dir)
			defer j3.Abandon()
			if len(j3.verifications) != 0 {
				t.Errorf("records came back after the repair finished: %v", j3.verifications)
			}
		})
	}
}

// The manifest reached storage, and the line recording it was torn. The snapshot
// is adopted rather than uploaded again, but its control objects cannot be shown
// to be this run's, so it goes without an attestation.
func TestResume_ATornPublishRecordIsAdoptedWithoutAnAttestation(t *testing.T) {
	f := newAdoptionFixture(t)
	journalDir, ok := resolveJournalDir(f.staging)
	if !ok {
		t.Fatal("no journal dir")
	}
	path := pathpkg.Join(journalDir, journalFileName(backupIdentity(f.provider, []string{f.src})))
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(path, info.Size()-10); err != nil {
		t.Fatal(err)
	}

	job, err := f.manager(testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("resumed run: %v", err)
	}
	if job.Snapshot == nil || job.Snapshot.ID != f.snapID {
		t.Fatalf("resumed run did not adopt the published snapshot %s", f.snapID)
	}
	if job.Attestation != nil {
		t.Error("an object the journal never finished recording was attested")
	}
	if !strings.Contains(job.Warning, warnAttestationUnavailableResumedPublish) {
		t.Errorf("warning %q does not carry %s", job.Warning, warnAttestationUnavailableResumedPublish)
	}
}

// A tail too long for the line scanner is torn on the same terms as a short one:
// a power loss can leave megabytes of zeroes, and that must not cost the journal.
func TestJournalTornTail_AnOversizedTail(t *testing.T) {
	oversized := strings.Repeat("\x00", 1024*1024+10)
	entryLine, err := json.Marshal(journalEntryLine{SnapshotFile: tornTestEntry("c")})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("unterminated last line is torn", func(t *testing.T) {
		dir := t.TempDir()
		path, id := seedTornTestJournal(t, dir, true)
		appendRaw(t, path, oversized)

		j, resumed := openTornTestJournal(t, dir)
		if !resumed || j.snapshotID != id {
			t.Fatalf("resumed = %v, snapshot %q, want the journal kept", resumed, j.snapshotID)
		}
		requireEntries(t, j, "a", "b")
		if len(j.verifications) != 0 {
			t.Errorf("records survived the tear: %v", j.verifications)
		}
		if err := j.Record(tornTestEntry("d")); err != nil {
			t.Fatal(err)
		}
		j.Abandon()
		requireWellFormedFile(t, path)

		j2, resumed := openTornTestJournal(t, dir)
		defer j2.Abandon()
		if !resumed {
			t.Fatal("the repaired journal must resume")
		}
		requireEntries(t, j2, "a", "b", "d")
	})
	for name, tail := range map[string]string{
		"with a newline after it": oversized + "\n",
		"with a line after it":    oversized + "\n" + string(entryLine) + "\n",
		"after a malformed line":  `{"sourcePath":"/x` + "\n" + oversized,
	} {
		t.Run(name+" is corruption", func(t *testing.T) {
			dir := t.TempDir()
			path, id := seedTornTestJournal(t, dir, false)
			appendRaw(t, path, tail)

			j, resumed := openTornTestJournal(t, dir)
			defer j.Abandon()
			if resumed || j.snapshotID == id {
				t.Fatalf("resumed = %v, snapshot %q, want a new snapshot", resumed, j.snapshotID)
			}
		})
	}
}

// A tear after a repair is a tear like the first: records made since the repair
// go, entries stay, and the offset is the new fragment's.
func TestJournalTornTail_ATearAfterARepair(t *testing.T) {
	dir := t.TempDir()
	path, id := seedTornTestJournal(t, dir, true)
	appendRaw(t, path, longFragment(t))

	j, _ := openTornTestJournal(t, dir)
	if err := j.Record(tornTestEntry("d")); err != nil {
		t.Fatal(err)
	}
	if err := j.recordVerification(tornTestEntry("a"), journalVerification{
		StoredObjectCheck: storedCheckOK, VerifiedAt: time.Now().UTC(), BaseGeneration: j.baseGeneration(),
	}); err != nil {
		t.Fatal(err)
	}
	j.Abandon()
	appendRaw(t, path, longFragment(t))

	j2, resumed := openTornTestJournal(t, dir)
	if !resumed || j2.snapshotID != id {
		t.Fatalf("resumed = %v, snapshot %q, want the journal kept", resumed, j2.snapshotID)
	}
	requireEntries(t, j2, "a", "b", "d")
	if len(j2.verifications) != 0 {
		t.Errorf("records survived the second tear: %v", j2.verifications)
	}
	j2.Abandon()
	requireWellFormedFile(t, path)
}

// The real repair, failing for real: a journal it cannot open for writing.
func TestJournalTornTail_ARepairThatCannotWriteLeavesTheFileAlone(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root writes to a read-only file")
	}
	dir := t.TempDir()
	path, id := seedTornTestJournal(t, dir, true)
	appendRaw(t, path, longFragment(t))
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o400); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })

	j, resumed := openTornTestJournal(t, dir)
	defer j.Abandon()
	if !resumed || j.snapshotID != id {
		t.Fatalf("resumed = %v, snapshot %q, want the journal kept", resumed, j.snapshotID)
	}
	requireEntries(t, j, "a", "b")
	if !j.CheckpointingDisabled() {
		t.Error("a journal that was not repaired must not take writes")
	}
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Errorf("the failed repair changed the file:\n%q", tailOf(after))
	}
}

// A run that cannot checkpoint says so on the job: if it dies, its progress is
// lost, and nothing else tells anyone. It still finishes the same snapshot.
func TestRunBackupContext_AFailedRepairWarnsAndStillResumes(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	identity := backupIdentity(p, []string{src})
	seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob, journalEntryLine{SnapshotFile: ea})
	journalDir, ok := resolveJournalDir(staging)
	if !ok {
		t.Fatal("no journal dir")
	}
	appendRaw(t, pathpkg.Join(journalDir, journalFileName(identity)), longFragment(t))
	defer setJournalTailRepairFnForTest(func(string, int64, journalHeader) error {
		return errors.New("no space left on device")
	})()

	job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if !strings.Contains(job.Warning, warnJournalCheckpointingDisabled) {
		t.Errorf("warning %q does not carry %s", job.Warning, warnJournalCheckpointingDisabled)
	}
	if !manifestPublished(p, brokeredJournalID) {
		t.Fatalf("the interrupted snapshot was not completed: %v", p.uploadedKeys())
	}
	if uploadedSource(p, "a.txt") {
		t.Errorf("an unchanged entry was uploaded again: %v", p.uploadedKeys())
	}
}

// A journal that could not be repaired can still be replaced, and completes like
// any other.
func TestJournalTornTail_AnUnrepairedJournalCanStillRestartOrComplete(t *testing.T) {
	failRepair := func(string, int64, journalHeader) error { return errors.New("no space left on device") }

	t.Run("restart for another job", func(t *testing.T) {
		dir := t.TempDir()
		path, id := seedTornTestJournal(t, dir, false)
		appendRaw(t, path, longFragment(t))
		defer setJournalTailRepairFnForTest(failRepair)()
		j, _ := openTornTestJournal(t, dir)
		defer j.Abandon()
		if err := j.BindRun("job-2", "base-1"); err != nil {
			t.Fatal(err)
		}
		if j.snapshotID == id {
			t.Error("another job must start a new snapshot")
		}
		if j.CheckpointingDisabled() {
			t.Error("a restarted journal checkpoints again")
		}
		if err := j.Record(tornTestEntry("d")); err != nil {
			t.Fatalf("a restarted journal must write: %v", err)
		}
		requireWellFormedFile(t, path)
	})
	t.Run("a healthy journal whose restart failed is not called damaged", func(t *testing.T) {
		dir := t.TempDir()
		seedTornTestJournal(t, dir, false)
		j, _ := openTornTestJournal(t, dir)
		defer j.Abandon()
		j.path = pathpkg.Join(dir, "missing", "journal.jsonl")
		if err := j.restartFresh(); err == nil {
			t.Fatal("fixture: the restart must fail")
		}
		if j.CheckpointingDisabled() {
			t.Error("the warning would blame a tear that never happened")
		}
	})
	t.Run("complete", func(t *testing.T) {
		dir := t.TempDir()
		path, _ := seedTornTestJournal(t, dir, false)
		appendRaw(t, path, longFragment(t))
		defer setJournalTailRepairFnForTest(failRepair)()
		j, _ := openTornTestJournal(t, dir)
		if err := j.Complete(); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("journal still there: %v", err)
		}
	})
}

// Journals nobody resumes are thrown away for their own reasons, and a torn tail
// does not change the reason.
func TestJournalTornTail_OtherDiscardsStillApply(t *testing.T) {
	t.Run("stale", func(t *testing.T) {
		dir := t.TempDir()
		path, id := seedTornTestJournal(t, dir, false)
		appendRaw(t, path, longFragment(t))
		j, resumed, err := openSnapshotJournal(dir, tornTestIdentity, time.Nanosecond)
		if err != nil {
			t.Fatal(err)
		}
		defer j.Abandon()
		if resumed {
			t.Fatal("a stale journal must not resume")
		}
		if got, ok := j.StaleSnapshotID(); !ok || got != id {
			t.Errorf("StaleSnapshotID = %q, %v, want %q", got, ok, id)
		}
	})
	t.Run("older format", func(t *testing.T) {
		dir := t.TempDir()
		path := pathpkg.Join(dir, journalFileName(tornTestIdentity))
		old := fmt.Sprintf(`{"snapshotId":"snapshot-old","createdAt":%q,"identity":%q}`+"\n"+`{"sourcePath":"/a`,
			time.Now().UTC().Format(time.RFC3339Nano), tornTestIdentity)
		if err := os.WriteFile(path, []byte(old), 0o600); err != nil {
			t.Fatal(err)
		}
		j, resumed := openTornTestJournal(t, dir)
		defer j.Abandon()
		if resumed || !j.DiscardedOldFormat() {
			t.Errorf("resumed = %v, DiscardedOldFormat = %v", resumed, j.DiscardedOldFormat())
		}
	})
}

func TestJournalTornTail_WarnsOnceWithTheOffset(t *testing.T) {
	dir := t.TempDir()
	path, _ := seedTornTestJournal(t, dir, false)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	appendRaw(t, path, longFragment(t))

	var logged bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logged, nil)))
	defer slog.SetDefault(previous)

	j, _ := openTornTestJournal(t, dir)
	defer j.Abandon()
	if got := strings.Count(logged.String(), "torn last line"); got != 1 {
		t.Errorf("warned %d times, want once:\n%s", got, logged.String())
	}
	if want := fmt.Sprintf("offset=%d", info.Size()); !strings.Contains(logged.String(), want) {
		t.Errorf("no %s in:\n%s", want, logged.String())
	}
	if !strings.Contains(logged.String(), "level=WARN") {
		t.Errorf("not at Warn:\n%s", logged.String())
	}
}
