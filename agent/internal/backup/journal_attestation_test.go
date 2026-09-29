package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path"
	pathpkg "path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

func TestJournal_HeaderRecordsBindingsAndPublishedObjectsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	j, resumed, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil || resumed {
		t.Fatalf("open: resumed=%v err=%v", resumed, err)
	}
	if j.Header().FormatVersion != journalFormatVersion {
		t.Fatalf("new journal format = %d, want %d", j.Header().FormatVersion, journalFormatVersion)
	}
	if err := j.BindRun("job-1", "base-1"); err != nil {
		t.Fatal(err)
	}
	if err := j.Record(SnapshotFile{SourcePath: "/a", BackupPath: "snapshots/x/files/a.gz", Size: 1, Checksum: strings.Repeat("a", 64)}); err != nil {
		t.Fatal(err)
	}
	if err := j.RecordBaseDecision("base-1"); err != nil {
		t.Fatal(err)
	}
	m1 := PublishedObject{Role: AttestationRoleManifest, Key: "snapshots/x/manifest.json", SHA256: strings.Repeat("b", 64), Size: 10}
	m2 := PublishedObject{Role: AttestationRoleManifest, Key: "snapshots/x/manifest.json", SHA256: strings.Repeat("c", 64), Size: 11}
	lay := PublishedObject{Role: AttestationRoleLayout, Key: "snapshots/x/layout.json", SHA256: strings.Repeat("d", 64), Size: 12}
	for _, o := range []PublishedObject{m1, lay, m2} {
		if err := j.RecordPublishedObject(o); err != nil {
			t.Fatal(err)
		}
	}
	if err := j.Record(SnapshotFile{SourcePath: "/b", BackupPath: "snapshots/x/files/b.gz", Size: 2, Checksum: strings.Repeat("e", 64)}); err != nil {
		t.Fatal(err)
	}
	j.Abandon()

	j2, resumed, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil || !resumed {
		t.Fatalf("reopen: resumed=%v err=%v", resumed, err)
	}
	defer j2.Abandon()
	h := j2.Header()
	if h.JobID != "job-1" || h.DispatchedBaseSnapshotID != "base-1" || !h.BaseDecided || h.ParentSnapshotID != "base-1" {
		t.Fatalf("bindings not persisted: %+v", h)
	}
	got := map[string]PublishedObject{}
	for _, o := range h.PublishedObjects {
		got[o.Role] = o
	}
	if len(got) != 2 || got[AttestationRoleManifest] != m2 || got[AttestationRoleLayout] != lay {
		t.Fatalf("published objects = %+v, want the latest manifest and the layout", h.PublishedObjects)
	}
	if len(j2.entries) != 2 {
		t.Fatalf("entries around the header rewrites were lost: %d", len(j2.entries))
	}
}

func TestJournal_OlderFormatIsDiscardedNotResumed(t *testing.T) {
	dir := t.TempDir()
	const identity = "identity-a"
	old := `{"snapshotId":"snapshot-old","createdAt":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","identity":"` + identity + `"}` + "\n" +
		`{"sourcePath":"/a","backupPath":"snapshots/snapshot-old/files/a.gz","size":1,"modTime":"2026-01-01T00:00:00Z"}` + "\n"
	if err := os.WriteFile(pathpkg.Join(dir, journalFileName(identity)), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	j, resumed, err := openSnapshotJournal(dir, identity, journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	defer j.Abandon()
	if resumed || !j.DiscardedOldFormat() || j.snapshotID == "snapshot-old" || len(j.entries) != 0 {
		t.Fatalf("older journal was resumed: resumed=%v discarded=%v id=%s entries=%d", resumed, j.DiscardedOldFormat(), j.snapshotID, len(j.entries))
	}
}

func TestJournal_BindRunDiscardsAJournalFromAnotherJobOrBase(t *testing.T) {
	cases := []struct {
		name, job, base string
		wantResumed     bool
	}{
		{"same job and base", "job-1", "base-1", true},
		{"different job", "job-2", "base-1", false},
		{"different dispatched base", "job-1", "base-2", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			j, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
			_ = j.BindRun("job-1", "base-1")
			_ = j.Record(SnapshotFile{SourcePath: "/a", BackupPath: "snapshots/x/files/a.gz", Size: 1, Checksum: strings.Repeat("a", 64)})
			oldID := j.snapshotID
			j.Abandon()

			j2, resumed, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
			if !resumed {
				t.Fatal("setup: journal not resumed")
			}
			if err := j2.BindRun(tc.job, tc.base); err != nil {
				t.Fatal(err)
			}
			defer j2.Abandon()
			if tc.wantResumed {
				if !j2.resumed || j2.snapshotID != oldID || len(j2.entries) != 1 || j2.DiscardedOtherRun() != "" {
					t.Fatalf("same run must resume: resumed=%v id=%s entries=%d", j2.resumed, j2.snapshotID, len(j2.entries))
				}
				return
			}
			if j2.resumed || j2.snapshotID == oldID || len(j2.entries) != 0 || j2.DiscardedOtherRun() == "" {
				t.Fatalf("journal of another run must be discarded: resumed=%v id=%s entries=%d reason=%q", j2.resumed, j2.snapshotID, len(j2.entries), j2.DiscardedOtherRun())
			}
			h := j2.Header()
			if h.JobID != tc.job || h.DispatchedBaseSnapshotID != tc.base || h.FormatVersion != journalFormatVersion {
				t.Fatalf("fresh journal not bound to this run: %+v", h)
			}
			// The discard is durable: reopening sees the fresh journal.
			j2.Abandon()
			j3, _, _ := openSnapshotJournal(dir, "identity-a", journalMaxAge)
			defer j3.Abandon()
			if j3.snapshotID != j2.snapshotID || len(j3.entries) != 0 {
				t.Fatal("discarded journal came back on reopen")
			}
		})
	}
}

// seedBoundJournal leaves a journal with one uploaded entry, bound to
// job/base under the destination identity, and returns its snapshot id.
func seedBoundJournal(t *testing.T, staging, identity, job, base string) string {
	t.Helper()
	journalDir, ok := resolveJournalDir(staging)
	if !ok {
		t.Fatal("no journal dir")
	}
	j, _, err := openSnapshotJournal(journalDir, identity, journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	_ = j.BindRun(job, base)
	id := j.snapshotID
	j.Abandon()
	return id
}

func TestRunBackupContext_JournalFromAnotherRunIsDiscarded(t *testing.T) {
	const otherBase = "snapshot-20260101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa"
	cases := []struct {
		name              string
		job, base         string
		wantDiscardReason string
	}{
		{"same job resumes", testJobID, "", ""},
		{"different job", "11111111-2222-3333-4444-555555555555", "", "job"},
		{"different dispatched base", testJobID, otherBase, "base"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := t.TempDir()
			createTempFile(t, src, "a.txt", "alpha")
			staging := t.TempDir()
			provider := newMockProvider()
			mgr := serverOwnedManager(t, provider, []string{src}, "")
			mgr.config.StagingDir = staging
			oldID := seedBoundJournal(t, staging, backupIdentity(provider, []string{src}), tc.job, tc.base)

			job, err := mgr.RunBackupContext(context.Background(), nil)
			if err != nil {
				t.Fatalf("RunBackupContext: %v", err)
			}
			if tc.wantDiscardReason == "" {
				if job.Snapshot.ID != oldID || strings.Contains(job.Warning, warnJournalDiscardedOtherRun) {
					t.Fatalf("same job must resume %s, got %s (warning %q)", oldID, job.Snapshot.ID, job.Warning)
				}
			} else {
				if job.Snapshot.ID == oldID {
					t.Fatal("a journal from another run was resumed")
				}
				if !strings.Contains(job.Warning, warnJournalDiscardedOtherRun) || !strings.Contains(job.Warning, tc.wantDiscardReason) {
					t.Fatalf("warning %q does not carry %s (%s)", job.Warning, warnJournalDiscardedOtherRun, tc.wantDiscardReason)
				}
			}
			decodeAttestation(t, job)
		})
	}
}

func TestRunBackupContext_JournalForAnotherDestinationIsDiscarded(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	provider := newMockProvider()
	mgr := serverOwnedManager(t, provider, []string{src}, "")
	mgr.config.StagingDir = staging
	journalDir, _ := resolveJournalDir(staging)
	if err := os.MkdirAll(journalDir, 0o700); err != nil {
		t.Fatal(err)
	}
	// A current-format journal at this destination's path that names a
	// different storage identity.
	header := journalHeader{SnapshotID: "snapshot-20260101T000000Z-bbbbbbbb", CreatedAt: time.Now().UTC(), Identity: "local|/elsewhere",
		FormatVersion: journalFormatVersion, JobID: testJobID}
	line, _ := json.Marshal(header)
	identity := backupIdentity(provider, []string{src})
	if err := os.WriteFile(pathpkg.Join(journalDir, journalFileName(identity)), append(line, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot.ID == header.SnapshotID {
		t.Fatal("a journal for another destination was resumed")
	}
	if !strings.Contains(job.Warning, warnJournalDiscardedOtherRun) || !strings.Contains(job.Warning, "destination") {
		t.Fatalf("warning %q does not carry %s (destination)", job.Warning, warnJournalDiscardedOtherRun)
	}
}

// manifestFailsAfterStoreProvider stores the snapshot manifest and then
// reports a failure, as a connection that drops after the store accepted
// the object does. The run fails; the journal keeps what it published.
type manifestFailsAfterStoreProvider struct {
	*digestReportingProvider
	failManifest bool
}

func (p *manifestFailsAfterStoreProvider) UploadWithDigest(ctx context.Context, localPath, remotePath string) (providers.UploadDigest, error) {
	d, err := p.digestReportingProvider.UploadWithDigest(ctx, localPath, remotePath)
	if err == nil && p.failManifest && strings.HasSuffix(remotePath, "/manifest.json") && !strings.Contains(remotePath, "/system-state/") {
		return providers.UploadDigest{}, errors.New("connection reset after the object was stored")
	}
	return d, err
}

type adoptionFixture struct {
	src      string
	staging  string
	backing  *mockProvider
	provider *manifestFailsAfterStoreProvider
	snapID   string
}

// newAdoptionFixture runs one server-owned full run whose manifest lands in
// storage but whose result is lost, leaving the checkpoint journal behind.
func newAdoptionFixture(t *testing.T) *adoptionFixture {
	t.Helper()
	f := &adoptionFixture{src: t.TempDir(), staging: t.TempDir(), backing: newMockProvider()}
	createTempFile(t, f.src, "a.txt", "alpha")
	f.provider = &manifestFailsAfterStoreProvider{digestReportingProvider: &digestReportingProvider{mockProvider: f.backing}, failManifest: true}
	mgr := f.manager(testJobID)
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err == nil {
		t.Fatalf("first run should fail on the manifest upload, got %+v", job)
	}
	if job.Attestation != nil {
		t.Fatal("a run whose manifest upload failed must not attest")
	}
	for key := range f.backing.files {
		if strings.HasSuffix(key, "/manifest.json") {
			f.snapID = strings.Split(key, "/")[1]
		}
	}
	if f.snapID == "" {
		t.Fatal("fixture: manifest was not stored")
	}
	f.provider.failManifest = false
	return f
}

func (f *adoptionFixture) manager(jobID string) *BackupManager {
	base := ""
	return NewBackupManager(BackupConfig{
		Provider:              f.provider,
		Paths:                 []string{f.src},
		StagingDir:            f.staging,
		AgentID:               testAgentID,
		JobID:                 jobID,
		BaseSnapshotID:        &base,
		PublishLeaseExpiresAt: time.Now().Add(4 * time.Hour),
	})
}

func TestResume_AdoptedManifestIsAttestedWhenItMatchesTheJournal(t *testing.T) {
	f := newAdoptionFixture(t)
	job, err := f.manager(testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("resumed run: %v", err)
	}
	if job.Snapshot == nil || job.Snapshot.ID != f.snapID {
		t.Fatalf("resumed run did not adopt the published snapshot %s", f.snapID)
	}
	s := decodeAttestation(t, job)
	if s.SnapshotID != f.snapID || s.JobID != testJobID || s.DispatchedBaseSnapshotID != nil || s.ParentSnapshotID != nil {
		t.Fatalf("adopted statement bindings wrong: %+v", s)
	}
	assertObjectsMatchStorage(t, f.backing, s)
}

func TestResume_AdoptedManifestIsNotAttestedWhenItDiffersFromTheJournal(t *testing.T) {
	f := newAdoptionFixture(t)
	key := path.Join(snapshotRootDir, f.snapID, snapshotManifestKey)
	var m Snapshot
	if err := json.Unmarshal(f.backing.files[key], &m); err != nil {
		t.Fatal(err)
	}
	m.Size++ // another writer's manifest under the same id
	data, _ := json.Marshal(&m)
	f.backing.files[key] = data

	job, err := f.manager(testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("resumed run: %v", err)
	}
	if job.Attestation != nil {
		t.Fatalf("attested bytes this run did not publish: %s", job.Attestation.Statement)
	}
	if !strings.Contains(job.Warning, warnAttestationUnavailableResumedPublish) {
		t.Fatalf("warning %q does not carry %s", job.Warning, warnAttestationUnavailableResumedPublish)
	}
}

func TestResume_AdoptedManifestIsNotAttestedWithAnUnrecordedControlObject(t *testing.T) {
	f := newAdoptionFixture(t)
	f.backing.files[path.Join(snapshotRootDir, f.snapID, layoutManifestKey)] = []byte(`{"disks":[]}`)

	job, err := f.manager(testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("resumed run: %v", err)
	}
	if job.Attestation != nil || !strings.Contains(job.Warning, warnAttestationUnavailableResumedPublish) {
		t.Fatalf("a control object the journal never recorded must block the attestation (warning %q)", job.Warning)
	}
}

func TestResume_ManifestPublishedByAnotherJobIsNotAdopted(t *testing.T) {
	f := newAdoptionFixture(t)
	job, err := f.manager("11111111-2222-3333-4444-555555555555").RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if job.Snapshot.ID == f.snapID {
		t.Fatal("another job's published snapshot was adopted")
	}
	if !strings.Contains(job.Warning, warnJournalDiscardedOtherRun) {
		t.Fatalf("warning %q does not carry %s", job.Warning, warnJournalDiscardedOtherRun)
	}
	s := decodeAttestation(t, job)
	if s.SnapshotID != job.Snapshot.ID {
		t.Fatal("fresh snapshot not attested")
	}
}

func TestRunBackupContext_OlderFormatJournalWarnsAndRunsFresh(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	provider := newMockProvider()
	mgr := serverOwnedManager(t, provider, []string{src}, "")
	mgr.config.StagingDir = staging
	journalDir, ok := resolveJournalDir(staging)
	if !ok {
		t.Fatal("no journal dir")
	}
	if err := os.MkdirAll(journalDir, 0o700); err != nil {
		t.Fatal(err)
	}
	identity := backupIdentity(provider, []string{src})
	old := `{"snapshotId":"snapshot-old","createdAt":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","identity":` + jsonString(identity) + `}` + "\n"
	if err := os.WriteFile(pathpkg.Join(journalDir, journalFileName(identity)), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot.ID == "snapshot-old" {
		t.Fatal("an older-format journal was resumed")
	}
	if !strings.Contains(job.Warning, warnJournalDiscardedOldFormat) {
		t.Fatalf("warning %q does not carry %s", job.Warning, warnJournalDiscardedOldFormat)
	}
	decodeAttestation(t, job)
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// deleteFailingProvider refuses deletes, so a stale control object cannot be
// cleared.
type deleteFailingProvider struct{ *digestReportingProvider }

func (p *deleteFailingProvider) Delete(string) error { return errors.New("delete refused") }

// A resumed run must not leave a control object an earlier attempt published
// under the same snapshot id beside a manifest it attests: it clears the
// control keys it is not publishing itself, and attests nothing when it
// cannot.
func TestResume_StaleControlObjectsFromAnEarlierAttemptAreCleared(t *testing.T) {
	for _, deleteFails := range []bool{false, true} {
		t.Run(map[bool]string{false: "cleared", true: "cannot clear"}[deleteFails], func(t *testing.T) {
			src := t.TempDir()
			createTempFile(t, src, "a.txt", "alpha")
			staging := t.TempDir()
			backing := newMockProvider()
			var provider providersBackupProvider = &digestReportingProvider{mockProvider: backing}
			if deleteFails {
				provider = &deleteFailingProvider{&digestReportingProvider{mockProvider: backing}}
			}
			base := ""
			mgr := NewBackupManager(BackupConfig{
				Provider: provider, Paths: []string{src}, StagingDir: staging, AgentID: testAgentID, JobID: testJobID,
				BaseSnapshotID: &base, PublishLeaseExpiresAt: time.Now().Add(4 * time.Hour),
			})
			// An earlier attempt of this snapshot id: a journal and a layout
			// manifest in storage, no snapshot manifest.
			journalDir, _ := resolveJournalDir(staging)
			j, _, err := openSnapshotJournal(journalDir, backupIdentity(provider, []string{src}), journalMaxAge)
			if err != nil {
				t.Fatal(err)
			}
			_ = j.BindRun(testJobID, "") // the earlier attempt was this same job
			stale := path.Join(snapshotRootDir, j.snapshotID, layoutManifestKey)
			backing.files[stale] = []byte(`{"disks":[]}`)
			j.Abandon()

			job, err := mgr.RunBackupContext(context.Background(), nil)
			if err != nil {
				t.Fatalf("RunBackupContext: %v", err)
			}
			if job.Snapshot.ID != j.snapshotID {
				t.Fatal("test did not resume the earlier attempt's snapshot id")
			}
			_, stillThere := backing.files[stale]
			if !deleteFails {
				if stillThere {
					t.Fatal("stale layout manifest left beside the new manifest")
				}
				decodeAttestation(t, job)
				return
			}
			if !stillThere || job.Attestation != nil || !strings.Contains(job.Warning, warnAttestationUnavailable) {
				t.Fatalf("an uncleared stale control object must withhold the attestation (warning %q)", job.Warning)
			}
		})
	}
}

type providersBackupProvider = providers.BackupProvider
