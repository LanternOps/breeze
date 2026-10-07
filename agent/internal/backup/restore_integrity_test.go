package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// integritySnapshot is a local-provider snapshot whose manifest entries carry
// checksums, as every snapshot written by an attestation-producing helper does.
type integritySnapshot struct {
	provider   *providers.LocalProvider
	snapshotID string
	manifest   Snapshot
}

type integrityFile struct {
	name     string
	content  string
	volatile bool
	// noChecksum leaves the manifest entry without a checksum.
	noChecksum bool
}

func setupIntegritySnapshot(t *testing.T, files []integrityFile) *integritySnapshot {
	t.Helper()
	provider := providers.NewLocalProvider(t.TempDir())
	s := &integritySnapshot{provider: provider, snapshotID: "snap-integrity-1"}
	for _, f := range files {
		key := path.Join("snapshots", s.snapshotID, "files", f.name)
		s.putObject(t, key, f.content)
		entry := SnapshotFile{
			SourcePath: "/original/" + f.name,
			BackupPath: key,
			Size:       int64(len(f.content)),
			ModTime:    time.Unix(1_700_000_000, 0).UTC(),
			Volatile:   f.volatile,
		}
		if !f.noChecksum {
			entry.Checksum = integrity.DigestBytes([]byte(f.content))
		}
		s.manifest.Files = append(s.manifest.Files, entry)
	}
	s.manifest.ID = s.snapshotID
	s.manifest.Timestamp = time.Unix(1_700_000_000, 0).UTC()
	s.putManifest(t, s.manifest)
	return s
}

func (s *integritySnapshot) putObject(t *testing.T, key, content string) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "object")
	if err := os.WriteFile(src, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.provider.Upload(src, key); err != nil {
		t.Fatal(err)
	}
}

func (s *integritySnapshot) manifestKey() string {
	return path.Join("snapshots", s.snapshotID, "manifest.json")
}

func (s *integritySnapshot) putManifest(t *testing.T, m Snapshot) []byte {
	t.Helper()
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	s.putObject(t, s.manifestKey(), string(data))
	return data
}

func (s *integritySnapshot) storedManifest(t *testing.T) []byte {
	t.Helper()
	dest := filepath.Join(t.TempDir(), "manifest")
	if err := s.provider.Download(s.manifestKey(), dest); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// attested returns the expectation the server would deliver for the
// manifest as currently stored.
func (s *integritySnapshot) attested(t *testing.T) *integrity.Expectation {
	t.Helper()
	data := s.storedManifest(t)
	raw, _ := json.Marshal(map[string]any{
		"v": 1, "mode": "attested", "trust": "server_verified", "snapshotId": s.snapshotID,
		"objects": []map[string]any{{
			"role": "manifest", "key": s.manifestKey(),
			"sha256": integrity.DigestBytes(data), "size": len(data),
		}},
	})
	e, err := integrity.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func overrideExpectation(t *testing.T, snapshotID string) *integrity.Expectation {
	t.Helper()
	e, err := integrity.Parse(json.RawMessage(`{"v":1,"mode":"unattested_override","snapshotId":"` + snapshotID + `","authorizationId":"auth-1"}`))
	if err != nil {
		t.Fatal(err)
	}
	return e
}

// sameSizeDifferent returns content of the same length with different bytes.
func sameSizeDifferent(content string) string {
	b := []byte(content)
	b[0] ^= 0x20
	return string(b)
}

func restoreWith(t *testing.T, p providers.BackupProvider, snapshotID string, e *integrity.Expectation, target, workRoot string) (*RestoreResult, error) {
	t.Helper()
	return RestoreFromSnapshotContext(context.Background(), p, RestoreConfig{
		SnapshotID: snapshotID,
		TargetPath: target,
		WorkRoot:   workRoot,
		Integrity:  e,
	}, nil)
}

func restoredNames(t *testing.T, target string) []string {
	t.Helper()
	var names []string
	root := filepath.Join(target, "original")
	entries, err := os.ReadDir(root)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

func hasWarning(warnings []string, sub string) bool {
	for _, w := range warnings {
		if strings.Contains(w, sub) {
			return true
		}
	}
	return false
}

func TestRestoreAttested_MatchingSnapshotRestoresEverything(t *testing.T) {
	s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}, {name: "b.txt", content: "bravo"}})
	target := t.TempDir()
	res, err := restoreWith(t, s.provider, s.snapshotID, s.attested(t), target, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res.Status != "completed" || res.FilesRestored != 2 || len(res.Warnings) != 0 {
		t.Fatalf("result = %+v", res)
	}
}

func TestRestoreAttested_ManifestBytesDifferFromAttestation_NothingWritten(t *testing.T) {
	s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}})
	e := s.attested(t)
	// The stored manifest now differs from what the attestation describes,
	// at the same length.
	original := s.storedManifest(t)
	s.putObject(t, s.manifestKey(), sameSizeDifferent(string(original)))

	target := t.TempDir()
	res, err := restoreWith(t, s.provider, s.snapshotID, e, target, t.TempDir())
	if !errors.Is(err, integrity.ErrIntegrityMismatch) {
		t.Fatalf("err = %v, want integrity mismatch", err)
	}
	if res == nil || res.Status != "failed" {
		t.Fatalf("result = %+v", res)
	}
	if names := restoredNames(t, target); len(names) != 0 {
		t.Fatalf("restore wrote %v", names)
	}
}

func TestRestoreAttested_ExpectationForAnotherSnapshotIsRefused(t *testing.T) {
	s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}})
	e := overrideExpectation(t, "snap-other")
	if _, err := restoreWith(t, s.provider, s.snapshotID, e, t.TempDir(), t.TempDir()); err == nil {
		t.Fatal("expected refusal")
	}
}

func TestRestoreStoredBytesChecks(t *testing.T) {
	cases := []struct {
		name         string
		file         integrityFile
		stored       func(content string) string
		mode         string // attested, override, none
		wantRestored bool
		wantWarning  string
	}{
		{name: "attested same-size different bytes fails", file: integrityFile{name: "b.txt", content: "bravo"}, stored: sameSizeDifferent, mode: "attested"},
		{name: "attested volatile size mismatch fails", file: integrityFile{name: "b.txt", content: "bravo", volatile: true}, stored: func(c string) string { return c + "more" }, mode: "attested"},
		{name: "attested volatile checksum mismatch fails", file: integrityFile{name: "b.txt", content: "bravo", volatile: true}, stored: sameSizeDifferent, mode: "attested"},
		{name: "attested entry without checksum fails", file: integrityFile{name: "b.txt", content: "bravo", noChecksum: true}, mode: "attested", wantWarning: "missing_checksum"},
		{name: "override volatile checksum mismatch warns", file: integrityFile{name: "b.txt", content: "bravo", volatile: true}, stored: sameSizeDifferent, mode: "override", wantRestored: true, wantWarning: "volatile"},
		{name: "override entry without checksum restores", file: integrityFile{name: "b.txt", content: "bravo", noChecksum: true}, mode: "override", wantRestored: true, wantWarning: integrity.UnattestedRestoreWarning},
		{name: "override same-size different bytes fails", file: integrityFile{name: "b.txt", content: "bravo"}, stored: sameSizeDifferent, mode: "override"},
		{name: "no expectation volatile mismatch warns", file: integrityFile{name: "b.txt", content: "bravo", volatile: true}, stored: sameSizeDifferent, mode: "none", wantRestored: true, wantWarning: "volatile"},
		{name: "no expectation entry without checksum restores", file: integrityFile{name: "b.txt", content: "bravo", noChecksum: true}, mode: "none", wantRestored: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}, tc.file})
			var e *integrity.Expectation
			switch tc.mode {
			case "attested":
				e = s.attested(t)
			case "override":
				e = overrideExpectation(t, s.snapshotID)
			}
			if tc.stored != nil {
				s.putObject(t, s.manifest.Files[1].BackupPath, tc.stored(tc.file.content))
			}
			target := t.TempDir()
			res, err := restoreWith(t, s.provider, s.snapshotID, e, target, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			names := restoredNames(t, target)
			restored := len(names) == 2
			if restored != tc.wantRestored {
				t.Fatalf("restored %v (result %+v)", names, res)
			}
			if !tc.wantRestored {
				if res.Status != "partial" || res.FilesFailed != 1 || len(res.FailedFiles) != 1 || res.FailedFiles[0] != "/original/b.txt" {
					t.Fatalf("result = %+v", res)
				}
				if len(names) != 1 || names[0] != "a.txt" {
					t.Fatalf("on disk: %v", names)
				}
			}
			if tc.wantWarning != "" && !hasWarning(res.Warnings, tc.wantWarning) {
				t.Fatalf("warnings %v lack %q", res.Warnings, tc.wantWarning)
			}
			if tc.mode == "override" && !hasWarning(res.Warnings, integrity.UnattestedRestoreWarning) {
				t.Fatalf("override result must say it was not checked against an attestation: %v", res.Warnings)
			}
			if tc.mode != "override" && hasWarning(res.Warnings, integrity.UnattestedRestoreWarning) {
				t.Fatalf("unexpected unattested warning: %v", res.Warnings)
			}
		})
	}
}

// countingProvider counts downloads per key. The restore downloads on
// several goroutines (#5623), so the counter is mutex-guarded.
type countingProvider struct {
	providers.BackupProvider
	mu     sync.Mutex
	counts map[string]int
	fail   map[string]int // key -> number of initial downloads that fail
}

func (c *countingProvider) Download(remote, local string) error {
	c.mu.Lock()
	c.counts[remote]++
	failNow := c.fail[remote] >= c.counts[remote]
	c.mu.Unlock()
	if failNow {
		return errors.New("download interrupted")
	}
	return c.BackupProvider.Download(remote, local)
}

func TestRestoreAttested_ResumeRedownloadsACompletedFileWhoseContentChanged(t *testing.T) {
	for _, tc := range []struct {
		name          string
		changeTarget  bool
		wantDownloads int
	}{
		{name: "changed same-size target is re-downloaded", changeTarget: true, wantDownloads: 2},
		{name: "unchanged target is skipped", changeTarget: false, wantDownloads: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}, {name: "b.txt", content: "bravo"}})
			e := s.attested(t)
			keyA, keyB := s.manifest.Files[0].BackupPath, s.manifest.Files[1].BackupPath
			p := &countingProvider{BackupProvider: s.provider, counts: map[string]int{}, fail: map[string]int{keyB: 1}}
			target, workRoot := t.TempDir(), t.TempDir()

			first, err := restoreWith(t, p, s.snapshotID, e, target, workRoot)
			if err != nil || first.Status != "partial" {
				t.Fatalf("first run: %+v %v", first, err)
			}
			restoredA := filepath.Join(target, "original", "a.txt")
			if tc.changeTarget {
				if err := os.WriteFile(restoredA, []byte("ALPHA"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			second, err := restoreWith(t, p, s.snapshotID, e, target, workRoot)
			if err != nil || second.Status != "completed" {
				t.Fatalf("second run: %+v %v", second, err)
			}
			if p.counts[keyA] != tc.wantDownloads {
				t.Fatalf("a.txt downloaded %d times, want %d", p.counts[keyA], tc.wantDownloads)
			}
			got, _ := os.ReadFile(restoredA)
			if string(got) != "alpha" {
				t.Fatalf("a.txt = %q", got)
			}
		})
	}
}

func TestRestoreAttested_VaultCopyDiffersRestoresFromPrimary(t *testing.T) {
	primary := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}, {name: "b.txt", content: "bravo"}})
	e := primary.attested(t)
	// The vault holds the same snapshot, but its copy of b.txt differs.
	vault := &integritySnapshot{provider: providers.NewLocalProvider(t.TempDir()), snapshotID: primary.snapshotID}
	vault.putObject(t, primary.manifestKey(), string(primary.storedManifest(t)))
	vault.putObject(t, primary.manifest.Files[0].BackupPath, "alpha")
	vault.putObject(t, primary.manifest.Files[1].BackupPath, sameSizeDifferent("bravo"))

	t.Run("primary correct", func(t *testing.T) {
		target := t.TempDir()
		res, err := restoreWith(t, providers.NewFallbackProvider(vault.provider, primary.provider), primary.snapshotID, e, target, t.TempDir())
		if err != nil || res.Status != "completed" {
			t.Fatalf("%+v %v", res, err)
		}
		got, _ := os.ReadFile(filepath.Join(target, "original", "b.txt"))
		if string(got) != "bravo" {
			t.Fatalf("b.txt = %q", got)
		}
		if !hasWarning(res.Warnings, "vault copy differs from backup; restored from primary storage") {
			t.Fatalf("warnings = %v", res.Warnings)
		}
	})
	t.Run("both differ", func(t *testing.T) {
		primary.putObject(t, primary.manifest.Files[1].BackupPath, sameSizeDifferent("bravo"))
		target := t.TempDir()
		res, err := restoreWith(t, providers.NewFallbackProvider(vault.provider, primary.provider), primary.snapshotID, e, target, t.TempDir())
		if err != nil || res.Status != "partial" || res.FilesFailed != 1 {
			t.Fatalf("%+v %v", res, err)
		}
		if _, err := os.Stat(filepath.Join(target, "original", "b.txt")); !os.IsNotExist(err) {
			t.Fatalf("b.txt installed: %v", err)
		}
	})
}

// Integrity failures carry a stable result code the server can show.
func TestRestoreAndVerifyReportIntegrityFailureCodes(t *testing.T) {
	t.Run("restore manifest", func(t *testing.T) {
		s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}})
		e := s.attested(t)
		s.putObject(t, s.manifestKey(), sameSizeDifferent(string(s.storedManifest(t))))
		res, _ := restoreWith(t, s.provider, s.snapshotID, e, t.TempDir(), t.TempDir())
		if res == nil || res.Code != "integrity_mismatch" {
			t.Fatalf("result = %+v, want code integrity_mismatch", res)
		}
	})
	for _, tc := range []struct {
		name string
		file integrityFile
		code string
	}{
		{name: "restore object", file: integrityFile{name: "b.txt", content: "bravo"}, code: "integrity_mismatch"},
		{name: "restore missing checksum", file: integrityFile{name: "b.txt", content: "bravo", noChecksum: true}, code: "missing_checksum"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}, tc.file})
			e := s.attested(t)
			if !tc.file.noChecksum {
				s.putObject(t, s.manifest.Files[1].BackupPath, sameSizeDifferent(tc.file.content))
			}
			res, err := restoreWith(t, s.provider, s.snapshotID, e, t.TempDir(), t.TempDir())
			if err != nil || res.Code != tc.code {
				t.Fatalf("result = %+v err %v, want code %s", res, err, tc.code)
			}
		})
	}
	t.Run("no expectation has no code", func(t *testing.T) {
		s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}, {name: "b.txt", content: "bravo"}})
		s.putObject(t, s.manifest.Files[1].BackupPath, sameSizeDifferent("bravo"))
		res, _ := restoreWith(t, s.provider, s.snapshotID, nil, t.TempDir(), t.TempDir())
		if res.Code != "" {
			t.Fatalf("code = %q, want none without an expectation", res.Code)
		}
	})
	t.Run("verify and test restore", func(t *testing.T) {
		s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}, {name: "b.txt", content: "bravo"}})
		e := s.attested(t)
		s.putObject(t, s.manifest.Files[1].BackupPath, sameSizeDifferent("bravo"))
		v, _ := VerifyIntegrityWithOptions(context.Background(), s.provider, s.snapshotID, VerifyOptions{Integrity: e})
		tr, _ := TestRestoreWithOptions(context.Background(), s.provider, s.snapshotID, t.TempDir(), VerifyOptions{Integrity: e})
		if v.Code != "integrity_mismatch" || tr.Code != "integrity_mismatch" {
			t.Fatalf("verify code %q, test restore code %q", v.Code, tr.Code)
		}
		s.putObject(t, s.manifestKey(), sameSizeDifferent(string(s.storedManifest(t))))
		v, _ = VerifyIntegrityWithOptions(context.Background(), s.provider, s.snapshotID, VerifyOptions{Integrity: e})
		if v.Code != "integrity_mismatch" {
			t.Fatalf("verify manifest code %q", v.Code)
		}
	})
}
