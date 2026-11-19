package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	pathpkg "path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// verifiedTestAge is how old a test file's mtime is made, well past
// racyModTimeMargin, so a verification of it may be persisted.
const verifiedTestAge = time.Hour

// settledFile creates a source file whose mtime is old enough to be cached.
func settledFile(t *testing.T, dir, name, content string) string {
	t.Helper()
	p := createTempFile(t, dir, name, content)
	at := time.Now().Add(-verifiedTestAge).Truncate(time.Second)
	if err := os.Chtimes(p, at, at); err != nil {
		t.Fatal(err)
	}
	return p
}

// rewriteKeepingStat replaces a file's content without changing its size or
// mtime. Only a run that really re-hashes the file can notice: this is what
// tells "re-hash skipped" apart from "re-hashed and matched".
func rewriteKeepingStat(t *testing.T, p, content string) {
	t.Helper()
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if int64(len(content)) != info.Size() {
		t.Fatalf("rewrite must keep the size: %d != %d", len(content), info.Size())
	}
	if err := os.WriteFile(p, []byte(content), info.Mode()); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
}

// seedVerifiedJournal writes a current-format journal whose lines each carry
// their verification; a nil verification writes the plain line every earlier
// helper wrote.
func seedVerifiedJournal(t *testing.T, staging, identity, snapshotID, job string, lines ...journalEntryLine) {
	t.Helper()
	journalDir, ok := resolveJournalDir(staging)
	if !ok {
		t.Fatal("no journal dir")
	}
	if err := os.MkdirAll(journalDir, 0o700); err != nil {
		t.Fatal(err)
	}
	header := journalHeader{SnapshotID: snapshotID, CreatedAt: time.Now().UTC(), Identity: identity,
		FormatVersion: journalFormatVersion, JobID: job}
	raw, _ := json.Marshal(header)
	content := append(raw, '\n')
	for _, l := range lines {
		b, err := json.Marshal(l)
		if err != nil {
			t.Fatal(err)
		}
		content = append(content, append(b, '\n')...)
	}
	if err := os.WriteFile(pathpkg.Join(journalDir, journalFileName(identity)), content, 0o600); err != nil {
		t.Fatal(err)
	}
}

// recordFor is the verification an earlier pass persisted for the journal
// brokeredJournalID (base "" = a full dispatch).
func recordFor(check storedObjectCheck, age time.Duration) *journalVerification {
	return &journalVerification{
		StoredObjectCheck: check,
		VerifiedAt:        time.Now().UTC().Add(-age),
		BaseGeneration:    journalBaseGeneration(brokeredJournalID, ""),
	}
}

// continuingIssuer is a brokered provider that lets a later job continue
// brokeredJournalID, whose objects it holds as given.
func continuingIssuer(objects map[string]string) *fakeIssuer {
	p := newFakeIssuer(brokeredIssuedID)
	p.resume = func(string) (providers.ResumeMode, error) { return providers.ResumeWrite, nil }
	for k, v := range objects {
		p.backing.files[k] = []byte(v)
	}
	return p
}

func uploadedSource(p *fakeIssuer, name string) bool {
	for _, k := range p.uploadedKeys() {
		if strings.HasSuffix(k, "/"+name) || strings.Contains(k, "/"+name+".") {
			return true
		}
	}
	return false
}

func manifestPublished(p *fakeIssuer, snapshotID string) bool {
	key := path.Join(snapshotRootDir, snapshotID, snapshotManifestKey)
	for _, k := range p.uploadedKeys() {
		if k == key {
			return true
		}
	}
	return false
}

// --- journal round trip and compatibility ---

func TestJournalVerification_RoundTripAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	j, _, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	_ = j.BindRun("job-1", "base-1")
	e := SnapshotFile{SourcePath: "/a", BackupPath: "snapshots/x/files/a.gz", Size: 3,
		ModTime: time.Now().Add(-time.Hour).UTC().Truncate(time.Second), Checksum: strings.Repeat("a", 64)}
	if err := j.Record(e); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC().Truncate(time.Second)
	v := journalVerification{StoredObjectCheck: storedCheckOK, VerifiedAt: at, BaseGeneration: j.baseGeneration()}
	if err := j.recordVerification(e, v); err != nil {
		t.Fatal(err)
	}
	gen := j.baseGeneration()
	j.Abandon()

	j2, resumed, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil || !resumed {
		t.Fatalf("reopen: resumed=%v err=%v", resumed, err)
	}
	defer j2.Abandon()
	if len(j2.entries) != 1 {
		t.Fatalf("a verification line added an entry: %d", len(j2.entries))
	}
	if got, ok := j2.Lookup("/a", e.Size, e.ModTime); !ok || got.Checksum != e.Checksum {
		t.Fatalf("entry lost: %+v ok=%v", got, ok)
	}
	got, ok := j2.verifications["/a"]
	if !ok {
		t.Fatal("verification lost on reopen")
	}
	if got.StoredObjectCheck != storedCheckOK || !got.VerifiedAt.Equal(at) || got.BaseGeneration != gen {
		t.Fatalf("verification = %+v", got)
	}
}

func TestJournalVerification_AnUploadSupersedesIt(t *testing.T) {
	dir := t.TempDir()
	j, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	_ = j.BindRun("job-1", "")
	e := SnapshotFile{SourcePath: "/a", BackupPath: "k", Size: 1, Checksum: strings.Repeat("a", 64)}
	_ = j.Record(e)
	_ = j.recordVerification(e, journalVerification{StoredObjectCheck: storedCheckOK, VerifiedAt: time.Now().UTC(), BaseGeneration: j.baseGeneration()})
	// The same thing an older helper's Record does after a rollback.
	_ = j.Record(e)
	if _, ok := j.verifications["/a"]; ok {
		t.Fatal("a new upload left the old verification in memory")
	}
	j.Abandon()

	j2, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	defer j2.Abandon()
	if _, ok := j2.verifications["/a"]; ok {
		t.Fatal("a new upload left the old verification on disk")
	}
}

// An older helper reads every line into a plain SnapshotFile. A verified line
// must give it exactly the entry it had, so rollback is a full verify, nothing
// worse. Plain entry lines must stay byte-identical to what it wrote.
func TestJournalVerification_OlderReaderSeesTheSameEntry(t *testing.T) {
	dir := t.TempDir()
	j, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	defer j.Abandon()
	e := SnapshotFile{SourcePath: "/a", OriginalPath: "/orig/a", BackupPath: "k", Size: 1,
		ModTime: time.Now().UTC().Truncate(time.Second), Checksum: strings.Repeat("a", 64), SDIndex: 3}
	_ = j.Record(e)
	_ = j.recordVerification(e, journalVerification{StoredObjectCheck: storedCheckOK, VerifiedAt: time.Now().UTC(), BaseGeneration: "g"})

	raw, err := os.ReadFile(j.path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	plain, verified := lines[len(lines)-2], lines[len(lines)-1]
	want, _ := json.Marshal(e)
	if plain != string(want) {
		t.Fatalf("plain entry line changed:\n%s\n%s", plain, want)
	}
	var old SnapshotFile
	if err := json.Unmarshal([]byte(verified), &old); err != nil {
		t.Fatal(err)
	}
	if !old.ModTime.Equal(e.ModTime) || old.SourcePath != e.SourcePath || old.OriginalPath != e.OriginalPath ||
		old.BackupPath != e.BackupPath || old.Size != e.Size || old.Checksum != e.Checksum || old.SDIndex != e.SDIndex {
		t.Fatalf("older reader sees %+v, want %+v", old, e)
	}
	if !strings.Contains(verified, `"verification":`) {
		t.Fatalf("no verification on the line: %s", verified)
	}
}

// Bumping journalFormatVersion would make openSnapshotJournalAt discard every
// journal in flight when this build ships, the opposite of "old journals get a
// full verify, once".
func TestJournalVerification_FormatVersionNotBumped(t *testing.T) {
	if journalFormatVersion != 2 {
		t.Fatalf("journalFormatVersion = %d: a bump discards in-flight journals on upgrade", journalFormatVersion)
	}
}

// --- skip rules, through a whole run ---

func TestResumeVerify_VerifiedUnchangedEntryIsNotCheckedAgain(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)})
	// Same size and mtime, different bytes: a re-hash would re-upload it.
	rewriteKeepingStat(t, a, "ALPHA")

	job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if uploadedSource(p, "a.txt") {
		t.Fatalf("verified entry was re-hashed and re-uploaded: %v", p.uploadedKeys())
	}
	if p.storedDigests != 0 {
		t.Fatalf("verified entry was read back %d times", p.storedDigests)
	}
	if job.Snapshot.ID != brokeredJournalID {
		t.Fatalf("snapshot id = %s", job.Snapshot.ID)
	}
}

func TestResumeVerify_ChangedFileIsUploadedEvenWithARecord(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)})
	// The mtime moved.
	later := ea.ModTime.Add(time.Minute)
	if err := os.WriteFile(a, []byte("ALPHA"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(a, later, later); err != nil {
		t.Fatal(err)
	}

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if !uploadedSource(p, "a.txt") {
		t.Fatalf("changed file not uploaded: %v", p.uploadedKeys())
	}
}

func TestResumeVerify_OtherBaseGenerationIsVerifiedAgain(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	other := recordFor(storedCheckOK, time.Hour)
	other.BaseGeneration = journalBaseGeneration(brokeredJournalID, "some-other-base")
	seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: other})
	rewriteKeepingStat(t, a, "ALPHA")

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if !uploadedSource(p, "a.txt") {
		t.Fatalf("a record from another base skipped the source hash: %v", p.uploadedKeys())
	}
}

func TestResumeVerify_ExpiredRecordForcesTheStoredReadBack(t *testing.T) {
	cases := []struct {
		name string
		age  time.Duration
		// wantRead: the stored object must be read back.
		wantRead bool
	}{
		{"inside the window", storedCheckMaxAge - time.Hour, false},
		{"past the window", storedCheckMaxAge + time.Hour, true},
		{"from the future", -time.Hour, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := t.TempDir()
			a := settledFile(t, src, "a.txt", "alpha")
			staging := t.TempDir()
			ea := journaledEntry(t, a, brokeredJournalID, "alpha")
			p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
			seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
				journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, tc.age)})

			if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
				t.Fatalf("RunBackupContext: %v", err)
			}
			if got := p.storedDigests > 0; got != tc.wantRead {
				t.Fatalf("read back = %v (%d), want %v", got, p.storedDigests, tc.wantRead)
			}
			if uploadedSource(p, "a.txt") {
				t.Fatalf("a matching object was uploaded again: %v", p.uploadedKeys())
			}
		})
	}
}

func TestResumeVerify_OldJournalLineGetsAFullVerify(t *testing.T) {
	// A line with no verification: journals written before this build, and
	// every entry an upload recorded. Source first: a changed one re-uploads.
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	b := settledFile(t, src, "b.txt", "bravo")
	staging := t.TempDir()
	ea, eb := journaledEntry(t, a, brokeredJournalID, "alpha"), journaledEntry(t, b, brokeredJournalID, "bravo")
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha", eb.BackupPath: "bravo"})
	seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea}, journalEntryLine{SnapshotFile: eb})
	rewriteKeepingStat(t, b, "BRAVO")

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if p.storedDigests != 1 {
		t.Fatalf("stored read-backs = %d, want 1 (the entry whose source matched)", p.storedDigests)
	}
	if !uploadedSource(p, "b.txt") {
		t.Fatalf("never-verified changed file was not re-hashed: %v", p.uploadedKeys())
	}
	if uploadedSource(p, "a.txt") {
		t.Fatalf("matching file uploaded again: %v", p.uploadedKeys())
	}
}

func TestResumeVerify_RecordedFailureIsVerifiedAgain(t *testing.T) {
	for _, check := range []storedObjectCheck{storedCheckMissing, storedCheckMismatch} {
		t.Run(string(check)+" and the object is still wrong", func(t *testing.T) {
			src := t.TempDir()
			a := settledFile(t, src, "a.txt", "alpha")
			staging := t.TempDir()
			ea := journaledEntry(t, a, brokeredJournalID, "alpha")
			p := continuingIssuer(map[string]string{ea.BackupPath: "other"})
			seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
				journalEntryLine{SnapshotFile: ea, Verification: recordFor(check, time.Hour)})

			job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
			if err != nil {
				t.Fatalf("RunBackupContext: %v", err)
			}
			if p.storedDigests == 0 {
				t.Fatal("recorded failure was not read back")
			}
			if !uploadedSource(p, "a.txt") {
				t.Fatalf("mismatching object not re-uploaded: %v", p.uploadedKeys())
			}
			if len(job.Snapshot.Files) != 1 {
				t.Fatalf("manifest entries = %d, want 1", len(job.Snapshot.Files))
			}
			if got := string(p.backing.files[job.Snapshot.Files[0].BackupPath]); got != "alpha" {
				t.Fatalf("the manifest's object holds %q", got)
			}
		})
		t.Run(string(check)+" forces a source re-hash too", func(t *testing.T) {
			src := t.TempDir()
			a := settledFile(t, src, "a.txt", "alpha")
			staging := t.TempDir()
			ea := journaledEntry(t, a, brokeredJournalID, "alpha")
			p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
			seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
				journalEntryLine{SnapshotFile: ea, Verification: recordFor(check, time.Hour)})
			rewriteKeepingStat(t, a, "ALPHA")

			if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
				t.Fatalf("RunBackupContext: %v", err)
			}
			if !uploadedSource(p, "a.txt") {
				t.Fatalf("source not re-hashed after a recorded %s: %v", check, p.uploadedKeys())
			}
		})
	}
}

func TestResumeVerify_VolatileEntryIsAlwaysRehashed(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	ea.Volatile = true
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)})
	rewriteKeepingStat(t, a, "ALPHA")

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if !uploadedSource(p, "a.txt") {
		t.Fatalf("volatile entry skipped its re-hash: %v", p.uploadedKeys())
	}
}

func TestResumeVerify_VolatileEntryNeverUsesARecordedStoredCheck(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	ea.Volatile = true
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)})

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if p.storedDigests != 1 {
		t.Fatalf("stored read-backs = %d, want 1", p.storedDigests)
	}
}

func TestResumeVerify_EntriesThatCannotBeReusedLoseTheirRecord(t *testing.T) {
	// Each of these ends in an upload that may overwrite the object the record
	// vouched for, and the run dies before recording that upload.
	cases := []struct {
		name  string
		setup func(ea *SnapshotFile) []journalEntryLine
		check func(t *testing.T, v journalVerification, ok bool)
	}{
		{
			name: "case twin",
			setup: func(ea *SnapshotFile) []journalEntryLine {
				twin := SnapshotFile{SourcePath: "/elsewhere", BackupPath: strings.Replace(ea.BackupPath, "a.txt", "A.TXT", 1),
					Size: ea.Size, ModTime: ea.ModTime, Checksum: ea.Checksum}
				return []journalEntryLine{{SnapshotFile: *ea, Verification: recordFor(storedCheckOK, time.Hour)}, {SnapshotFile: twin}}
			},
			check: func(t *testing.T, v journalVerification, ok bool) {
				if ok {
					t.Fatalf("record survived: %+v", v)
				}
			},
		},
		{
			name: "reference into another snapshot",
			setup: func(ea *SnapshotFile) []journalEntryLine {
				ea.BackupPath = path.Join(snapshotRootDir, "snapshot-older", snapshotFilesDir, "a.txt")
				return []journalEntryLine{{SnapshotFile: *ea, Verification: recordFor(storedCheckOK, time.Hour)}}
			},
			check: func(t *testing.T, v journalVerification, ok bool) {
				if ok {
					t.Fatalf("record survived: %+v", v)
				}
			},
		},
		{
			name: "expired ok whose read-back fails",
			setup: func(ea *SnapshotFile) []journalEntryLine {
				return []journalEntryLine{{SnapshotFile: *ea, Verification: recordFor(storedCheckOK, storedCheckMaxAge+time.Hour)}}
			},
			check: func(t *testing.T, v journalVerification, ok bool) {
				if !ok || v.StoredObjectCheck != storedCheckNone {
					t.Fatalf("record = %+v ok=%v, want the source hash kept and the ok gone", v, ok)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fastUploadRetries(t)
			src := t.TempDir()
			a := settledFile(t, src, "a.txt", "alpha")
			staging := t.TempDir()
			ea := journaledEntry(t, a, brokeredJournalID, "alpha")
			lines := tc.setup(&ea)
			backing := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
			identity := backupIdentity(backing, []string{src})
			seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob, lines...)
			backing.digestErr = errors.New("session expired")
			p := &failingDigester{fakeIssuer: backing, failAfter: 0, err: errors.New("session expired")}
			_, _ = brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)

			j := journalAfter(t, staging, identity)
			v, ok := j.verifications[journalEntryKey(ea)]
			tc.check(t, v, ok)
		})
	}
}

func TestResumeVerify_TaintedEntryIsUploadedEvenWithARecord(t *testing.T) {
	// A pre-#5582 journal's case twins share one object on a case-insensitive
	// store. A record must not excuse that check.
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	twin := SnapshotFile{SourcePath: pathpkg.Join(src, "elsewhere"), BackupPath: strings.Replace(ea.BackupPath, "a.txt", "A.TXT", 1),
		Size: ea.Size, ModTime: ea.ModTime, Checksum: ea.Checksum}
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)},
		journalEntryLine{SnapshotFile: twin})

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if !uploadedSource(p, "a.txt") {
		t.Fatalf("tainted entry reused on its record: %v", p.uploadedKeys())
	}
}

func TestResumeVerify_SameJobResumeSkipsRehashAndNeverListsOrReads(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredIssuedID, "alpha")
	p := newFakeIssuer(brokeredIssuedID)
	p.backing.files[ea.BackupPath] = []byte("alpha")
	gen := journalBaseGeneration(brokeredIssuedID, "")
	seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredIssuedID, testJobID,
		journalEntryLine{SnapshotFile: ea, Verification: &journalVerification{VerifiedAt: time.Now().UTC().Add(-time.Hour), BaseGeneration: gen}})
	rewriteKeepingStat(t, a, "ALPHA")

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if uploadedSource(p, "a.txt") {
		t.Fatalf("same-job resume re-hashed a verified entry: %v", p.uploadedKeys())
	}
	if p.storedDigests != 0 {
		t.Fatalf("same-job resume read back %d objects", p.storedDigests)
	}
}

// --- persistence during the pass ---

// fastUploadRetries keeps a run whose uploads are made to fail from waiting out
// the real backoff.
func fastUploadRetries(t *testing.T) {
	t.Helper()
	t.Cleanup(setUploadRetryDelayForTest(time.Millisecond))
	t.Cleanup(setShortUploadRetryDelayForTest(time.Millisecond))
}

// journalAfter opens the journal a run left behind.
func journalAfter(t *testing.T, staging, identity string) *snapshotJournal {
	t.Helper()
	journalDir, ok := resolveJournalDir(staging)
	if !ok {
		t.Fatal("no journal dir")
	}
	j, resumed, err := openSnapshotJournal(journalDir, identity, journalMaxAge)
	if err != nil || !resumed {
		t.Fatalf("journal after the run: resumed=%v err=%v", resumed, err)
	}
	t.Cleanup(j.Abandon)
	return j
}

// failingDigester answers read-backs from fakeIssuer until failAfter calls,
// then with the given error, like a session that died partway through.
type failingDigester struct {
	*fakeIssuer
	failAfter int
	err       error
	calls     int
}

func (d *failingDigester) StoredObjectDigest(ctx context.Context, key string) (providers.UploadDigest, error) {
	d.calls++
	if d.calls > d.failAfter {
		return providers.UploadDigest{}, d.err
	}
	return d.fakeIssuer.StoredObjectDigest(ctx, key)
}

func TestResumeVerify_AnInterruptedPassKeepsWhatItVerified(t *testing.T) {
	// The whole point of #11043: the pass dies partway (here the read-backs
	// start failing, as they do when the session is reaped) and the next job
	// must not start over.
	fastUploadRetries(t)
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	b := settledFile(t, src, "b.txt", "bravo")
	staging := t.TempDir()
	ea, eb := journaledEntry(t, a, brokeredJournalID, "alpha"), journaledEntry(t, b, brokeredJournalID, "bravo")
	backing := continuingIssuer(map[string]string{ea.BackupPath: "alpha", eb.BackupPath: "bravo"})
	identity := backupIdentity(backing, []string{src})
	seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea}, journalEntryLine{SnapshotFile: eb})

	p := &failingDigester{fakeIssuer: backing, failAfter: 1, err: errors.New("session expired")}
	// Everything after the failed read-back fails too: nothing gets published,
	// and the journal is left behind as the resume state.
	p.digestErr = errors.New("session expired")
	_, _ = brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)

	j := journalAfter(t, staging, identity)
	va, oka := j.verifications[journalEntryKey(ea)]
	vb, okb := j.verifications[journalEntryKey(eb)]
	if !oka || va.StoredObjectCheck != storedCheckOK {
		t.Fatalf("a.txt verified before the failure was not kept: %+v ok=%v", va, oka)
	}
	if !okb {
		t.Fatal("b.txt's source hash was thrown away with its failed read-back")
	}
	if vb.StoredObjectCheck != storedCheckNone {
		t.Fatalf("an I/O error became a verdict: %q", vb.StoredObjectCheck)
	}
}

func TestResumeVerify_NotCheckedRecordReadsBackWithoutRehashing(t *testing.T) {
	// The next job after an interrupted pass: the source hash stands, only
	// the read-back is still owed.
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	p := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	seedVerifiedJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckNone, time.Hour)})
	rewriteKeepingStat(t, a, "ALPHA")

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if p.storedDigests != 1 {
		t.Fatalf("stored read-backs = %d, want 1", p.storedDigests)
	}
	if uploadedSource(p, "a.txt") {
		t.Fatalf("source re-hashed although its hash was recorded: %v", p.uploadedKeys())
	}
}

func TestResumeVerify_MissingObjectVerdictIsRecorded(t *testing.T) {
	fastUploadRetries(t)
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	backing := continuingIssuer(nil)
	identity := backupIdentity(backing, []string{src})
	seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob, journalEntryLine{SnapshotFile: ea})
	backing.digestErr = errors.New("session expired")
	_, _ = brokeredManager(backing, src, staging, testJobID).RunBackupContext(context.Background(), nil)

	j := journalAfter(t, staging, identity)
	if v, ok := j.verifications[journalEntryKey(ea)]; !ok || v.StoredObjectCheck != storedCheckMissing {
		t.Fatalf("verdict = %+v ok=%v, want missing", v, ok)
	}
}

func TestResumeVerify_RecentlyWrittenFileIsNotCached(t *testing.T) {
	// Hashing a file in the same mtime tick it was written proves nothing
	// about the next write in that tick (git's "racy" problem).
	fastUploadRetries(t)
	src := t.TempDir()
	a := createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	backing := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	identity := backupIdentity(backing, []string{src})
	seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob, journalEntryLine{SnapshotFile: ea})
	// A failing upload of the manifest leaves the journal behind.
	backing.digestErr = errors.New("session expired")
	_, _ = brokeredManager(backing, src, staging, testJobID).RunBackupContext(context.Background(), nil)

	j := journalAfter(t, staging, identity)
	if v, ok := j.verifications[journalEntryKey(ea)]; ok {
		t.Fatalf("a file written just now was cached: %+v", v)
	}
}

func TestResumeVerify_ChangedFileLosesItsRecordBeforeTheUpload(t *testing.T) {
	// The upload overwrites the object the old "ok" vouched for. If that run
	// then dies before recording the upload and the file goes back to its old
	// size and mtime, the old "ok" must not vouch for the new object.
	fastUploadRetries(t)
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	backing := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	identity := backupIdentity(backing, []string{src})
	seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)})
	later := ea.ModTime.Add(time.Minute)
	if err := os.Chtimes(a, later, later); err != nil {
		t.Fatal(err)
	}
	backing.digestErr = errors.New("session expired")
	_, _ = brokeredManager(backing, src, staging, testJobID).RunBackupContext(context.Background(), nil)

	j := journalAfter(t, staging, identity)
	if v, ok := j.verifications[journalEntryKey(ea)]; ok {
		t.Fatalf("record survived the file changing: %+v", v)
	}
	if _, ok := j.entries[journalEntryKey(ea)]; !ok {
		t.Fatal("clearing the record lost the entry")
	}
}

func TestResumeVerify_FailedRehashRetractsTheRecord(t *testing.T) {
	// A Lookup hit can still end in an upload over the same key: a Volatile
	// entry whose bytes changed under the same size and mtime.
	fastUploadRetries(t)
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	ea.Volatile = true
	backing := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	identity := backupIdentity(backing, []string{src})
	seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)})
	rewriteKeepingStat(t, a, "ALPHA")
	backing.digestErr = errors.New("session expired")
	_, _ = brokeredManager(backing, src, staging, testJobID).RunBackupContext(context.Background(), nil)

	j := journalAfter(t, staging, identity)
	if v, ok := j.verifications[journalEntryKey(ea)]; ok {
		t.Fatalf("record survived the source no longer matching: %+v", v)
	}
}

func TestJournalVerification_ARetractionThatCannotBeWrittenPoisonsTheJournal(t *testing.T) {
	// The object is about to be overwritten and the record saying it is fine
	// cannot be retracted. The journal is not worth keeping at that price.
	dir := t.TempDir()
	j, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	_ = j.BindRun("job-1", "")
	e := SnapshotFile{SourcePath: "/a", BackupPath: "k", Size: 1, Checksum: strings.Repeat("a", 64)}
	_ = j.Record(e)
	if err := j.recordVerification(e, journalVerification{StoredObjectCheck: storedCheckOK, VerifiedAt: time.Now().UTC(), BaseGeneration: j.baseGeneration()}); err != nil {
		t.Fatal(err)
	}
	// Force the next write to fail.
	if err := j.file.Close(); err != nil {
		t.Fatal(err)
	}
	j.clearVerification("/a")
	if fi, err := os.Stat(j.path); err != nil || fi.Size() != 0 {
		t.Fatalf("journal not poisoned: %+v err=%v", fi, err)
	}
	j.Abandon()

	j2, resumed, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	defer j2.Abandon()
	if resumed || len(j2.verifications) != 0 {
		t.Fatalf("journal with an unretractable record was resumed: resumed=%v records=%d", resumed, len(j2.verifications))
	}
}

func TestJournalVerification_ALostWriteOnlyPoisonsWhenItRetractsTrust(t *testing.T) {
	// A full disk during a long pass must not throw away the checkpoint unless
	// the record left behind would say more than is true.
	ok := storedCheckOK
	none := storedCheckNone
	mismatch := storedCheckMismatch
	cases := []struct {
		name       string
		old        *storedObjectCheck
		new        storedObjectCheck
		wantPoison bool
	}{
		{"nothing recorded yet", nil, ok, false},
		{"ok refreshed with ok", &ok, ok, false},
		{"not checked becomes ok", &none, ok, false},
		{"not checked becomes mismatch", &none, mismatch, false},
		{"ok becomes not checked", &ok, none, true},
		{"ok becomes mismatch", &ok, mismatch, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			j, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
			_ = j.BindRun("job-1", "")
			e := SnapshotFile{SourcePath: "/a", BackupPath: "k", Size: 1, Checksum: strings.Repeat("a", 64)}
			_ = j.Record(e)
			if tc.old != nil {
				_ = j.recordVerification(e, journalVerification{StoredObjectCheck: *tc.old, VerifiedAt: time.Now().UTC(), BaseGeneration: "g"})
			}
			if err := j.file.Close(); err != nil {
				t.Fatal(err)
			}
			if err := j.recordVerification(e, journalVerification{StoredObjectCheck: tc.new, VerifiedAt: time.Now().UTC(), BaseGeneration: "g"}); err == nil {
				t.Fatal("setup: the write did not fail")
			}
			fi, err := os.Stat(j.path)
			if err != nil {
				t.Fatal(err)
			}
			if poisoned := fi.Size() == 0; poisoned != tc.wantPoison {
				t.Fatalf("poisoned = %v, want %v", poisoned, tc.wantPoison)
			}
			j.Abandon()
		})
	}
}

func TestJournalVerification_AnOlderHelperInvalidatesEarlierRecords(t *testing.T) {
	// Rollback, overwrite, crash, upgrade: an older helper overwrites an object
	// and dies before recording it. It knows nothing of records, so it cannot
	// retract them. Its header rewrite, without the marker, gives it away.
	dir := t.TempDir()
	j, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	_ = j.BindRun("job-1", "")
	e := SnapshotFile{SourcePath: "/a", BackupPath: "k", Size: 1, Checksum: strings.Repeat("a", 64)}
	_ = j.Record(e)
	_ = j.recordVerification(e, journalVerification{StoredObjectCheck: storedCheckOK, VerifiedAt: time.Now().UTC(), BaseGeneration: j.baseGeneration()})
	legacy := j.Header()
	legacy.VerificationAware = false
	line, err := json.Marshal(journalHeaderUpdate{HeaderUpdate: legacy})
	if err != nil {
		t.Fatal(err)
	}
	j.Abandon()
	f, err := os.OpenFile(j.path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()

	j2, resumed, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil || !resumed {
		t.Fatalf("reopen: resumed=%v err=%v", resumed, err)
	}
	if len(j2.verifications) != 0 {
		t.Fatalf("records survived an older helper: %+v", j2.verifications)
	}
	if len(j2.entries) != 1 {
		t.Fatalf("entries = %d, want them kept", len(j2.entries))
	}
	// What this build proves after taking the journal back does count.
	_ = j2.StartAttempt()
	_ = j2.recordVerification(e, journalVerification{StoredObjectCheck: storedCheckOK, VerifiedAt: time.Now().UTC(), BaseGeneration: j2.baseGeneration()})
	_ = j2.StartAttempt()
	j2.Abandon()
	j3, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	defer j3.Abandon()
	if len(j3.verifications) != 1 {
		t.Fatalf("a record written after the older helper was dropped: %+v", j3.verifications)
	}
}

func TestJournalVerification_ThisBuildsHeaderUpdatesKeepRecords(t *testing.T) {
	dir := t.TempDir()
	j, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	_ = j.BindRun("job-1", "")
	e := SnapshotFile{SourcePath: "/a", BackupPath: "k", Size: 1, Checksum: strings.Repeat("a", 64)}
	_ = j.Record(e)
	_ = j.recordVerification(e, journalVerification{StoredObjectCheck: storedCheckOK, VerifiedAt: time.Now().UTC(), BaseGeneration: j.baseGeneration()})
	_ = j.StartAttempt()
	j.Abandon()

	j2, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	defer j2.Abandon()
	if len(j2.verifications) != 1 {
		t.Fatal("a header update from this build dropped the records")
	}
}

// --- the manifest-level check ---

func TestResumeVerify_CachedObjectGoneFailsThePublishThenHeals(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	b := settledFile(t, src, "b.txt", "bravo")
	staging := t.TempDir()
	ea, eb := journaledEntry(t, a, brokeredJournalID, "alpha"), journaledEntry(t, b, brokeredJournalID, "bravo")
	// a's object vanished after it was verified; b's is fine.
	p := continuingIssuer(map[string]string{eb.BackupPath: "bravo"})
	identity := backupIdentity(p, []string{src})
	seedVerifiedJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)},
		journalEntryLine{SnapshotFile: eb, Verification: recordFor(storedCheckOK, time.Hour)})

	_, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "missing from storage") {
		t.Fatalf("publishing over a missing object: err=%v", err)
	}
	if manifestPublished(p, brokeredJournalID) {
		t.Fatalf("a manifest naming a missing object was published: %v", p.uploadedKeys())
	}
	j := journalAfter(t, staging, identity)
	if v := j.verifications[journalEntryKey(ea)]; v.StoredObjectCheck != storedCheckMissing {
		t.Fatalf("missing object not recorded: %+v", v)
	}
	if v := j.verifications[journalEntryKey(eb)]; v.StoredObjectCheck != storedCheckOK {
		t.Fatalf("present object lost its record: %+v", v)
	}
	j.Abandon()

	// The next job re-uploads only what is missing and finishes.
	p2 := continuingIssuer(map[string]string{eb.BackupPath: "bravo"})
	job, err := brokeredManager(p2, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("next job: %v", err)
	}
	if !uploadedSource(p2, "a.txt") || uploadedSource(p2, "b.txt") {
		t.Fatalf("next job uploaded %v", p2.uploadedKeys())
	}
	if !manifestPublished(p2, job.Snapshot.ID) {
		t.Fatal("next job published nothing")
	}
}

type failingLister struct {
	*fakeIssuer
	err error
}

func (l *failingLister) List(string) ([]string, error) { return nil, l.err }

func TestResumeVerify_ListFailureFailsClosed(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	backing := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	seedVerifiedJournal(t, staging, backupIdentity(backing, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)})
	p := &failingLister{fakeIssuer: backing, err: errors.New("list refused")}

	_, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "list refused") {
		t.Fatalf("err = %v", err)
	}
	if manifestPublished(backing, brokeredJournalID) {
		t.Fatal("published without confirming the cached objects")
	}
}

// staleLister lists only what was stored before the run: an object this run
// uploaded is gone by the time the listing runs.
type staleLister struct {
	*fakeIssuer
	keys []string
}

func (l *staleLister) List(string) ([]string, error) { return l.keys, nil }

func TestResumeVerify_TheCheckCoversEveryObjectTheManifestNames(t *testing.T) {
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	settledFile(t, src, "b.txt", "bravo")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	backing := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	seedVerifiedJournal(t, staging, backupIdentity(backing, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea, Verification: recordFor(storedCheckOK, time.Hour)})
	p := &staleLister{fakeIssuer: backing, keys: []string{ea.BackupPath}}

	_, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err == nil || !strings.Contains(err.Error(), "missing from storage") {
		t.Fatalf("err = %v", err)
	}
	if manifestPublished(backing, brokeredJournalID) {
		t.Fatal("published over an uploaded object that is gone")
	}
}

func TestConfirmStoredBeforePublish_ChecksOnlyThisSnapshotsOwnObjects(t *testing.T) {
	own := path.Join(snapshotRootDir, "s1", snapshotFilesDir, "a")
	p := newMockProvider()
	p.files[own] = []byte("x")
	j, _, err := openSnapshotJournal(t.TempDir(), "identity-a", journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Abandon()
	v := &resumeVerifier{journal: j, reliedOnCachedStored: true, generation: "g"}
	snapshot := &Snapshot{ID: "s1", Files: []SnapshotFile{
		{SourcePath: "/a", BackupPath: own},
		{SourcePath: "/link", Kind: KindSymlink},
		// Stored under an older snapshot: this prefix's listing never shows it.
		{SourcePath: "/ref", BackupPath: path.Join(snapshotRootDir, "s0", snapshotFilesDir, "ref")},
	}}
	if err := v.confirmStoredBeforePublish(p, snapshot); err != nil {
		t.Fatalf("own object is listed and the rest is not this snapshot's: %v", err)
	}
	// A control: the same check does see an own object that is gone.
	delete(p.files, own)
	if err := v.confirmStoredBeforePublish(p, snapshot); err == nil || !strings.Contains(err.Error(), "missing from storage") {
		t.Fatalf("err = %v", err)
	}
}

func TestResumeVerify_NothingCachedMeansNoListing(t *testing.T) {
	// A run that read everything back owes no listing: it is not worth a
	// failure mode for runs this change does not affect.
	src := t.TempDir()
	a := settledFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	backing := continuingIssuer(map[string]string{ea.BackupPath: "alpha"})
	seedVerifiedJournal(t, staging, backupIdentity(backing, []string{src}), brokeredJournalID, brokeredOtherJob,
		journalEntryLine{SnapshotFile: ea})
	p := &failingLister{fakeIssuer: backing, err: errors.New("list refused")}

	if _, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
}

func TestJournalBaseGeneration_DependsOnSnapshotAndBase(t *testing.T) {
	g := journalBaseGeneration("s1", "b1")
	for _, other := range []string{journalBaseGeneration("s2", "b1"), journalBaseGeneration("s1", "b2"), journalBaseGeneration("s1", "")} {
		if g == other {
			t.Fatalf("generations collide: %s", fmt.Sprint(g))
		}
	}
	if g != journalBaseGeneration("s1", "b1") {
		t.Fatal("generation is not stable")
	}
}
