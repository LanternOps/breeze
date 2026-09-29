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
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

const (
	brokeredIssuedID  = "snapshot-20261128T101500Z-111111111111111111111111"
	brokeredJournalID = "snapshot-20261127T090000Z-222222222222222222222222"
	brokeredOtherJob  = "11111111-2222-3333-4444-555555555555"
)

// fakeIssuer models a brokered write provider: it writes only under the
// snapshot id it currently owns, records every operation in order, and
// answers a resume the way the test configures.
type fakeIssuer struct {
	backing *mockProvider

	mu            sync.Mutex
	id            string
	readOnly      bool
	events        []string
	resume        func(journalID string) (providers.ResumeMode, error)
	digestErr     error
	storedDigests int
	// fenceErr / fenceDelay shape AwaitWriteAccess; busyOnce names keys
	// (substrings) whose first upload finds an earlier writer still active.
	fenceErr   error
	fenceDelay time.Duration
	busyOnce   map[string]bool
}

func (p *fakeIssuer) AwaitWriteAccess(ctx context.Context) error {
	p.record("fence")
	if p.fenceDelay > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(p.fenceDelay):
		}
	}
	return p.fenceErr
}

func newFakeIssuer(id string) *fakeIssuer {
	return &fakeIssuer{backing: newMockProvider(), id: id}
}

func (p *fakeIssuer) record(e string) {
	p.mu.Lock()
	p.events = append(p.events, e)
	p.mu.Unlock()
}

func (p *fakeIssuer) eventList() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.events...)
}

func (p *fakeIssuer) owns(key string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !strings.HasPrefix(key, "snapshots/"+p.id+"/") {
		return fmt.Errorf("key %s is outside snapshot %s", key, p.id)
	}
	if p.readOnly {
		return errors.New("read-only session")
	}
	return nil
}

func (p *fakeIssuer) BackupIdentity() string { return "s3-session|cfg-1" }

func (p *fakeIssuer) SnapshotID() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.id
}

func (p *fakeIssuer) ResumeSnapshot(_ context.Context, journalID string) (providers.ResumeMode, error) {
	p.record("resume:" + journalID)
	if p.resume == nil {
		return 0, providers.ErrSnapshotNotResumable
	}
	mode, err := p.resume(journalID)
	if err != nil {
		return 0, err
	}
	p.mu.Lock()
	p.id = journalID
	p.readOnly = mode == providers.ResumeReadOnlyCompletion
	p.mu.Unlock()
	return mode, nil
}

func (p *fakeIssuer) Upload(localPath, remotePath string) error {
	_, err := p.UploadWithDigest(context.Background(), localPath, remotePath)
	return err
}

func (p *fakeIssuer) UploadContext(ctx context.Context, localPath, remotePath string) error {
	_, err := p.UploadWithDigest(ctx, localPath, remotePath)
	return err
}

func (p *fakeIssuer) UploadWithDigest(_ context.Context, localPath, remotePath string) (providers.UploadDigest, error) {
	p.record("upload:" + remotePath)
	if err := p.owns(remotePath); err != nil {
		return providers.UploadDigest{}, err
	}
	p.mu.Lock()
	for sub, busy := range p.busyOnce {
		if busy && strings.Contains(remotePath, sub) {
			p.busyOnce[sub] = false
			p.mu.Unlock()
			return providers.UploadDigest{}, fmt.Errorf("%w: test", providers.ErrPreviousWriterActive)
		}
	}
	p.mu.Unlock()
	if p.digestErr != nil {
		return providers.UploadDigest{}, p.digestErr
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return providers.UploadDigest{}, err
	}
	p.backing.mu.Lock()
	p.backing.files[remotePath] = data
	p.backing.mu.Unlock()
	return digestBytes(data), nil
}

func (p *fakeIssuer) Download(remotePath, localPath string) error {
	p.record("download:" + remotePath)
	return p.backing.Download(remotePath, localPath)
}

func (p *fakeIssuer) List(prefix string) ([]string, error) {
	p.record("list:" + prefix)
	return p.backing.List(prefix)
}

func (p *fakeIssuer) Delete(remotePath string) error {
	p.record("delete:" + remotePath)
	if err := p.owns(remotePath); err != nil {
		return err
	}
	return p.backing.Delete(remotePath)
}

func (p *fakeIssuer) StoredObjectDigest(_ context.Context, remotePath string) (providers.UploadDigest, error) {
	p.mu.Lock()
	p.storedDigests++
	p.mu.Unlock()
	p.backing.mu.Lock()
	data, ok := p.backing.files[remotePath]
	p.backing.mu.Unlock()
	if !ok {
		return providers.UploadDigest{}, fmt.Errorf("%w: %s", providers.ErrObjectNotFound, remotePath)
	}
	return digestBytes(data), nil
}

func (p *fakeIssuer) uploadedKeys() []string {
	var keys []string
	for _, e := range p.eventList() {
		if k, ok := strings.CutPrefix(e, "upload:"); ok {
			keys = append(keys, k)
		}
	}
	return keys
}

func brokeredManager(p providers.BackupProvider, src, staging, jobID string) *BackupManager {
	base := ""
	return NewBackupManager(BackupConfig{
		Provider:              p,
		Paths:                 []string{src},
		StagingDir:            staging,
		AgentID:               testAgentID,
		JobID:                 jobID,
		BaseSnapshotID:        &base,
		PublishLeaseExpiresAt: time.Now().Add(4 * time.Hour),
	})
}

// seedBrokeredJournal writes a current-format journal naming snapshotID,
// bound to job and base, holding entries.
func seedBrokeredJournal(t *testing.T, staging, identity, snapshotID, job, base string, entries ...SnapshotFile) {
	t.Helper()
	journalDir, ok := resolveJournalDir(staging)
	if !ok {
		t.Fatal("no journal dir")
	}
	if err := os.MkdirAll(journalDir, 0o700); err != nil {
		t.Fatal(err)
	}
	header := journalHeader{SnapshotID: snapshotID, CreatedAt: time.Now().UTC(), Identity: identity,
		FormatVersion: journalFormatVersion, JobID: job, DispatchedBaseSnapshotID: base}
	line, _ := json.Marshal(header)
	content := append(line, '\n')
	for _, e := range entries {
		l, _ := json.Marshal(e)
		content = append(content, append(l, '\n')...)
	}
	if err := os.WriteFile(pathpkg.Join(journalDir, journalFileName(identity)), content, 0o600); err != nil {
		t.Fatal(err)
	}
}

// journaledEntry is the entry an earlier attempt recorded for a file it
// uploaded to snapshotID with content.
func journaledEntry(t *testing.T, sourcePath, snapshotID, content string) SnapshotFile {
	t.Helper()
	info, err := os.Stat(sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	return SnapshotFile{
		SourcePath: sourcePath,
		BackupPath: path.Join(snapshotRootDir, snapshotID, snapshotFilesDir, pathpkg.Base(sourcePath)),
		Size:       info.Size(),
		ModTime:    info.ModTime(),
		Checksum:   digestBytes([]byte(content)).SHA256,
	}
}

func TestBrokeredRun_UsesTheIssuedSnapshotID(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	p := newFakeIssuer(brokeredIssuedID)
	job, err := brokeredManager(p, src, t.TempDir(), testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot.ID != brokeredIssuedID {
		t.Fatalf("snapshot id = %s, want the issued %s", job.Snapshot.ID, brokeredIssuedID)
	}
	for _, e := range p.eventList() {
		if strings.HasPrefix(e, "resume:") {
			t.Fatalf("a fresh run asked to resume: %v", p.eventList())
		}
	}
	if len(p.uploadedKeys()) == 0 {
		t.Fatal("nothing uploaded")
	}
	if s := decodeAttestation(t, job); s.SnapshotID != brokeredIssuedID {
		t.Fatalf("attested snapshot %s", s.SnapshotID)
	}
}

func TestBrokeredRun_ResumesBeforeCheckingForAPublishedManifest(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	p := newFakeIssuer(brokeredIssuedID)
	p.resume = func(string) (providers.ResumeMode, error) { return providers.ResumeWrite, nil }
	seedBrokeredJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, testJobID, "")

	job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	events := p.eventList()
	if len(events) == 0 || events[0] != "resume:"+brokeredJournalID {
		t.Fatalf("first storage operation was not the resume: %v", events)
	}
	if job.Snapshot.ID != brokeredJournalID {
		t.Fatalf("snapshot id = %s, want the resumed %s", job.Snapshot.ID, brokeredJournalID)
	}
}

func TestBrokeredRun_ReadOnlyCompletionOnlyReportsThePublishedManifest(t *testing.T) {
	setup := func(t *testing.T, withManifest bool) (*fakeIssuer, *BackupManager) {
		src := t.TempDir()
		createTempFile(t, src, "a.txt", "alpha")
		staging := t.TempDir()
		p := newFakeIssuer(brokeredIssuedID)
		p.resume = func(string) (providers.ResumeMode, error) { return providers.ResumeReadOnlyCompletion, nil }
		seedBrokeredJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob, "")
		if withManifest {
			m := Snapshot{ID: brokeredJournalID, Timestamp: time.Now().UTC(), Files: []SnapshotFile{}}
			data, _ := json.Marshal(&m)
			p.backing.files[path.Join(snapshotRootDir, brokeredJournalID, snapshotManifestKey)] = data
		}
		return p, brokeredManager(p, src, staging, testJobID)
	}

	t.Run("manifest present", func(t *testing.T) {
		p, mgr := setup(t, true)
		job, err := mgr.RunBackupContext(context.Background(), nil)
		if err != nil {
			t.Fatalf("RunBackupContext: %v", err)
		}
		if job.Snapshot == nil || job.Snapshot.ID != brokeredJournalID {
			t.Fatalf("did not report the published snapshot: %+v", job.Snapshot)
		}
		if job.Attestation != nil {
			t.Fatal("attested a manifest another job published")
		}
		for _, e := range p.eventList() {
			if strings.HasPrefix(e, "upload:") || strings.HasPrefix(e, "delete:") {
				t.Fatalf("read-only completion changed storage: %v", p.eventList())
			}
		}
	})

	t.Run("manifest missing", func(t *testing.T) {
		p, mgr := setup(t, false)
		if _, err := mgr.RunBackupContext(context.Background(), nil); err == nil {
			t.Fatal("read-only completion without a manifest succeeded")
		}
		for _, e := range p.eventList() {
			if strings.HasPrefix(e, "upload:") || strings.HasPrefix(e, "delete:") {
				t.Fatalf("read-only completion changed storage: %v", p.eventList())
			}
		}
	})
}

func TestBrokeredRun_RefusedResumeStartsFreshUnderTheIssuedID(t *testing.T) {
	for _, refusal := range []error{providers.ErrSnapshotNotResumable, providers.ErrPreviousWriterActive} {
		t.Run(refusal.Error(), func(t *testing.T) {
			src := t.TempDir()
			createTempFile(t, src, "a.txt", "alpha")
			staging := t.TempDir()
			p := newFakeIssuer(brokeredIssuedID)
			p.resume = func(string) (providers.ResumeMode, error) { return 0, refusal }
			seedBrokeredJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob, "")

			job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
			if err != nil {
				t.Fatalf("RunBackupContext: %v", err)
			}
			if job.Snapshot.ID != brokeredIssuedID {
				t.Fatalf("snapshot id = %s, want the issued %s", job.Snapshot.ID, brokeredIssuedID)
			}
			if !strings.Contains(job.Warning, warnJournalDiscardedOtherRun) {
				t.Fatalf("warning %q does not say the checkpoint was discarded", job.Warning)
			}
		})
	}
}

func TestBrokeredRun_JournalForAnotherBaseNeverAsksToResume(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	p := newFakeIssuer(brokeredIssuedID)
	p.resume = func(string) (providers.ResumeMode, error) { return providers.ResumeWrite, nil }
	seedBrokeredJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob,
		"snapshot-20260101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa")

	job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	for _, e := range p.eventList() {
		if strings.HasPrefix(e, "resume:") {
			t.Fatalf("asked to resume a checkpoint written for another base: %v", p.eventList())
		}
	}
	if job.Snapshot.ID != brokeredIssuedID {
		t.Fatalf("snapshot id = %s", job.Snapshot.ID)
	}
}

func TestBrokeredRun_ContinuationFromAnotherJobReusesOnlyVerifiedEntries(t *testing.T) {
	src := t.TempDir()
	a := createTempFile(t, src, "a.txt", "alpha")       // stored object matches
	b := createTempFile(t, src, "b.txt", "bravo")       // stored object differs
	c := createTempFile(t, src, "c.txt", "charlie now") // source changed since upload
	d := createTempFile(t, src, "d.txt", "delta")       // stored object missing
	staging := t.TempDir()
	p := newFakeIssuer(brokeredIssuedID)
	p.resume = func(string) (providers.ResumeMode, error) { return providers.ResumeWrite, nil }

	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	eb := journaledEntry(t, b, brokeredJournalID, "bravo")
	ec := journaledEntry(t, c, brokeredJournalID, "charlie then")
	ec.Size = int64(len("charlie now"))
	ed := journaledEntry(t, d, brokeredJournalID, "delta")
	p.backing.files[ea.BackupPath] = []byte("alpha")
	p.backing.files[eb.BackupPath] = []byte("bravo, other bytes")
	p.backing.files[ec.BackupPath] = []byte("charlie then")
	// A manifest another job published into the prefix is not adopted: the
	// continuing job rebuilds its control objects.
	stale := Snapshot{ID: brokeredJournalID, Timestamp: time.Now().UTC(), Files: []SnapshotFile{ea}}
	staleData, _ := json.Marshal(&stale)
	manifestKey := path.Join(snapshotRootDir, brokeredJournalID, snapshotManifestKey)
	p.backing.files[manifestKey] = staleData
	seedBrokeredJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, brokeredOtherJob, "", ea, eb, ec, ed)

	job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot.ID != brokeredJournalID {
		t.Fatalf("snapshot id = %s, want the continued %s", job.Snapshot.ID, brokeredJournalID)
	}
	uploaded := map[string]bool{}
	for _, k := range p.uploadedKeys() {
		uploaded[k] = true
	}
	if uploaded[ea.BackupPath] {
		t.Fatal("a verified entry was uploaded again")
	}
	for _, e := range []SnapshotFile{eb, ec, ed} {
		found := false
		for k := range uploaded {
			if strings.Contains(k, "/"+pathpkg.Base(e.SourcePath)) {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s was reused without matching storage and source (uploaded %v)", e.SourcePath, p.uploadedKeys())
		}
	}
	if !uploaded[manifestKey] {
		t.Fatal("the manifest of the other job was adopted instead of rebuilt")
	}
	for _, f := range job.Snapshot.Files {
		stored := p.backing.files[f.BackupPath]
		if digestBytes(stored).SHA256 != f.Checksum {
			t.Fatalf("manifest entry %s does not describe the stored bytes", f.SourcePath)
		}
	}
}

func TestBrokeredRun_SameJobResumeKeepsTheSourceCheckOnly(t *testing.T) {
	src := t.TempDir()
	a := createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	p := newFakeIssuer(brokeredJournalID)
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	p.backing.files[ea.BackupPath] = []byte("alpha")
	seedBrokeredJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, testJobID, "", ea)

	job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot.ID != brokeredJournalID {
		t.Fatalf("snapshot id = %s", job.Snapshot.ID)
	}
	for _, k := range p.uploadedKeys() {
		if k == ea.BackupPath {
			t.Fatal("the same job's journaled entry was uploaded again")
		}
	}
	if p.storedDigests != 0 {
		t.Fatalf("the same job's resume read stored objects back (%d)", p.storedDigests)
	}
}

func TestJournal_ContinuedRunKeepsEntriesAndRequiresStoredChecks(t *testing.T) {
	dir := t.TempDir()
	j, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	_ = j.BindRun(brokeredOtherJob, "")
	_ = j.Record(SnapshotFile{SourcePath: "/a", BackupPath: "snapshots/x/files/a", Size: 1, Checksum: strings.Repeat("a", 64)})
	j.Abandon()

	j2, resumed, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if !resumed {
		t.Fatal("setup: not resumed")
	}
	if j2.VerifyStoredEntries() {
		t.Fatal("a journal continued by its own job requires stored checks")
	}
	if err := j2.ContinueRun(testJobID, "", false); err != nil {
		t.Fatal(err)
	}
	if !j2.VerifyStoredEntries() || len(j2.entries) != 1 || j2.Header().JobID != testJobID {
		t.Fatalf("continued journal: verify=%v entries=%d job=%s", j2.VerifyStoredEntries(), len(j2.entries), j2.Header().JobID)
	}
	j2.Abandon()

	// Durable: a later attempt of the continuing job still checks storage.
	j3, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	defer j3.Abandon()
	_ = j3.BindRun(testJobID, "")
	if !j3.resumed || !j3.VerifyStoredEntries() {
		t.Fatalf("stored checks not persisted: resumed=%v verify=%v", j3.resumed, j3.VerifyStoredEntries())
	}
}

func TestUploadWithDigest_BrokeredProviderNeverStagesACopy(t *testing.T) {
	p := newFakeIssuer(brokeredIssuedID)
	p.digestErr = fmt.Errorf("%w: test", providers.ErrDigestUnavailable)
	src := writeTempFile(t, "payload")
	_, err := uploadWithDigest(context.Background(), p, t.TempDir(), src, "snapshots/"+brokeredIssuedID+"/files/a")
	if err == nil {
		t.Fatal("a brokered upload without a digest succeeded")
	}
	if n := len(p.uploadedKeys()); n != 1 {
		t.Fatalf("uploads = %d, want only the refused attempt (no staged copy)", n)
	}
	// Wrapped in the publish gate, the issuer is still found.
	gate := &leaseGate{BackupProvider: p, publishLeaseExpiresAt: time.Now().Add(time.Hour)}
	if _, ok := snapshotIDIssuerOf(gate); !ok {
		t.Fatal("leaseGate hides the snapshot id issuer")
	}
	if _, ok := storedObjectDigesterOf(gate); !ok {
		t.Fatal("leaseGate hides the stored-object digester")
	}
}

func TestBrokeredRun_TakeoverAlwaysChecksStoredObjects(t *testing.T) {
	// The control plane reports a takeover: even a journal whose header
	// names this job is continued only after the stored objects are checked,
	// and its control objects are rebuilt.
	src := t.TempDir()
	a := createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	p := newFakeIssuer(brokeredIssuedID)
	p.resume = func(string) (providers.ResumeMode, error) { return providers.ResumeTakeover, nil }
	ea := journaledEntry(t, a, brokeredJournalID, "alpha")
	p.backing.files[ea.BackupPath] = []byte("other bytes")
	manifestKey := path.Join(snapshotRootDir, brokeredJournalID, snapshotManifestKey)
	stale, _ := json.Marshal(&Snapshot{ID: brokeredJournalID, Timestamp: time.Now().UTC(), Files: []SnapshotFile{ea}})
	p.backing.files[manifestKey] = stale
	seedBrokeredJournal(t, staging, backupIdentity(p, []string{src}), brokeredJournalID, testJobID, "", ea)

	job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot.ID != brokeredJournalID {
		t.Fatalf("snapshot id = %s", job.Snapshot.ID)
	}
	if p.storedDigests == 0 {
		t.Fatal("a takeover reused journal entries without checking storage")
	}
	uploadedA, uploadedManifest := false, false
	for _, k := range p.uploadedKeys() {
		uploadedA = uploadedA || strings.Contains(k, "/a.txt")
		uploadedManifest = uploadedManifest || k == manifestKey
	}
	if !uploadedA || !uploadedManifest {
		t.Fatalf("mismatching object not re-uploaded or manifest adopted: %v", p.uploadedKeys())
	}
}

func TestBrokeredRun_WaitsForAnEarlierWriterBeforeUploading(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	p := newFakeIssuer(brokeredIssuedID)
	job, err := brokeredManager(p, src, t.TempDir(), testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	events := p.eventList()
	fenced := false
	for _, e := range events {
		if e == "fence" {
			fenced = true
		}
		if strings.HasPrefix(e, "upload:") && !fenced {
			t.Fatalf("uploaded before waiting for earlier writers: %v", events)
		}
	}
	if !fenced || job.Snapshot == nil {
		t.Fatalf("no wait for earlier writers: %v", events)
	}

	// Still fenced after the wait: the run fails before writing anything.
	p2 := newFakeIssuer(brokeredIssuedID)
	p2.fenceErr = fmt.Errorf("%w: test", providers.ErrPreviousWriterActive)
	if _, err := brokeredManager(p2, src, t.TempDir(), testJobID).RunBackupContext(context.Background(), nil); err == nil {
		t.Fatal("a run with an earlier writer still active succeeded")
	}
	if len(p2.uploadedKeys()) != 0 {
		t.Fatalf("uploaded while an earlier writer was active: %v", p2.uploadedKeys())
	}
}

func TestBrokeredRun_EarlierWriterMidRunIsAWaitNotAFileFailure(t *testing.T) {
	restore := setUploadTimeoutFloorForTest(50 * time.Millisecond)
	defer restore()
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	createTempFile(t, src, "b.txt", "bravo")
	p := newFakeIssuer(brokeredIssuedID)
	p.busyOnce = map[string]bool{"/a.txt": true}
	// Longer than the file's own deadline: the wait must not run inside it.
	p.fenceDelay = 200 * time.Millisecond
	job, err := brokeredManager(p, src, t.TempDir(), testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if len(job.Snapshot.UploadFailures) != 0 || len(job.Snapshot.Files) != 2 {
		t.Fatalf("a wait for an earlier writer cost a file: failures=%v files=%d", job.Snapshot.UploadFailures, len(job.Snapshot.Files))
	}
	fences := 0
	for _, e := range p.eventList() {
		if e == "fence" {
			fences++
		}
	}
	if fences != 2 {
		t.Fatalf("fence waits = %d, want one before the run and one mid-run", fences)
	}
}

// plannedIssuer is a fakeIssuer that records the upload plan it is given.
type plannedIssuer struct {
	*fakeIssuer
	plan []providers.PlannedUpload
}

func (p *plannedIssuer) PrepareUploads(entries []providers.PlannedUpload) {
	p.plan = append([]providers.PlannedUpload(nil), entries...)
}

func TestBrokeredRun_PlansItsUploadsInOrder(t *testing.T) {
	src := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt"} {
		createTempFile(t, src, name, "content of "+name)
	}
	p := &plannedIssuer{fakeIssuer: newFakeIssuer(brokeredIssuedID)}
	if _, err := brokeredManager(p, src, t.TempDir(), testJobID).RunBackupContext(context.Background(), nil); err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	var fileUploads []string
	for _, k := range p.uploadedKeys() {
		if strings.Contains(k, "/files/") {
			fileUploads = append(fileUploads, k)
		}
	}
	if len(p.plan) != len(fileUploads) || len(fileUploads) != 4 {
		t.Fatalf("plan %v, uploads %v", p.plan, fileUploads)
	}
	for i, e := range p.plan {
		if e.Key != fileUploads[i] || !strings.HasPrefix(pathpkg.Base(e.LocalPath), strings.TrimSuffix(pathpkg.Base(e.Key), ".gz")) {
			t.Fatalf("planned upload %d = %+v, uploaded %s", i, e, fileUploads[i])
		}
	}
}
