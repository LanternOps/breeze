package backup

import (
	"context"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// verifyRun is one verification flavour: a verify or a test restore, reduced
// to the fields both report.
type verifyRun struct {
	name string
	run  func(t *testing.T, p providers.BackupProvider, snapshotID string, e *integrity.Expectation) (status string, failed []string, warnings []string, errText string)
}

var verifyRuns = []verifyRun{
	{name: "verify", run: func(t *testing.T, p providers.BackupProvider, snapshotID string, e *integrity.Expectation) (string, []string, []string, string) {
		res, err := VerifyIntegrityWithOptions(context.Background(), p, snapshotID, VerifyOptions{Integrity: e})
		if err != nil {
			t.Fatal(err)
		}
		return res.Status, res.FailedFiles, res.Warnings, res.Error
	}},
	{name: "test restore", run: func(t *testing.T, p providers.BackupProvider, snapshotID string, e *integrity.Expectation) (string, []string, []string, string) {
		res, err := TestRestoreWithOptions(context.Background(), p, snapshotID, t.TempDir(), VerifyOptions{Integrity: e})
		if err != nil {
			t.Fatal(err)
		}
		return res.Status, res.FailedFiles, res.Warnings, res.Error
	}},
}

func TestVerifyHonorsSnapshotAttestation(t *testing.T) {
	cases := []struct {
		name        string
		file        integrityFile
		stored      func(string) string
		mode        string
		wantStatus  string
		wantFailed  bool
		wantWarning string
	}{
		{name: "attested matching", file: integrityFile{name: "b.txt", content: "bravo"}, mode: "attested", wantStatus: "passed"},
		{name: "attested same-size different bytes", file: integrityFile{name: "b.txt", content: "bravo"}, stored: sameSizeDifferent, mode: "attested", wantStatus: "partial", wantFailed: true},
		{name: "attested volatile checksum mismatch", file: integrityFile{name: "b.txt", content: "bravo", volatile: true}, stored: sameSizeDifferent, mode: "attested", wantStatus: "partial", wantFailed: true},
		{name: "attested entry without checksum", file: integrityFile{name: "b.txt", content: "bravo", noChecksum: true}, mode: "attested", wantStatus: "partial", wantFailed: true},
		{name: "override volatile mismatch warns", file: integrityFile{name: "b.txt", content: "bravo", volatile: true}, stored: sameSizeDifferent, mode: "override", wantStatus: "passed", wantWarning: "volatile"},
		{name: "override entry without checksum passes", file: integrityFile{name: "b.txt", content: "bravo", noChecksum: true}, mode: "override", wantStatus: "passed"},
		{name: "none volatile mismatch warns", file: integrityFile{name: "b.txt", content: "bravo", volatile: true}, stored: sameSizeDifferent, mode: "none", wantStatus: "passed", wantWarning: "volatile"},
	}
	for _, vr := range verifyRuns {
		for _, tc := range cases {
			t.Run(vr.name+"/"+tc.name, func(t *testing.T) {
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
				status, failed, warnings, _ := vr.run(t, s.provider, s.snapshotID, e)
				if status != tc.wantStatus {
					t.Fatalf("status = %q, want %q (failed %v, warnings %v)", status, tc.wantStatus, failed, warnings)
				}
				if tc.wantFailed != (len(failed) == 1 && failed[0] == s.manifest.Files[1].BackupPath) {
					t.Fatalf("failed = %v", failed)
				}
				if tc.wantWarning != "" && !hasWarning(warnings, tc.wantWarning) {
					t.Fatalf("warnings %v lack %q", warnings, tc.wantWarning)
				}
				unattested := hasWarning(warnings, "not checked against a snapshot attestation")
				if unattested != (tc.mode == "override") {
					t.Fatalf("unattested label = %v in mode %s: %v", unattested, tc.mode, warnings)
				}
			})
		}
	}
}

func TestVerifyAttested_ManifestBytesDifferFromAttestation_NoObjectRead(t *testing.T) {
	for _, vr := range verifyRuns {
		t.Run(vr.name, func(t *testing.T) {
			s := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}})
			e := s.attested(t)
			s.putObject(t, s.manifestKey(), sameSizeDifferent(string(s.storedManifest(t))))
			p := &countingProvider{BackupProvider: s.provider, counts: map[string]int{}}
			status, _, _, errText := vr.run(t, p, s.snapshotID, e)
			if status != "failed" || !strings.Contains(errText, "attestation") {
				t.Fatalf("status %q error %q", status, errText)
			}
			if n := p.counts[s.manifest.Files[0].BackupPath]; n != 0 {
				t.Fatalf("object downloaded %d times after the manifest failed its check", n)
			}
		})
	}
}

func TestVerifyAttested_VaultCopyDiffersChecksPrimary(t *testing.T) {
	for _, vr := range verifyRuns {
		t.Run(vr.name, func(t *testing.T) {
			primary := setupIntegritySnapshot(t, []integrityFile{{name: "a.txt", content: "alpha"}})
			e := primary.attested(t)
			vault := &integritySnapshot{provider: providers.NewLocalProvider(t.TempDir()), snapshotID: primary.snapshotID}
			vault.putObject(t, primary.manifestKey(), string(primary.storedManifest(t)))
			vault.putObject(t, primary.manifest.Files[0].BackupPath, sameSizeDifferent("alpha"))
			status, _, warnings, _ := vr.run(t, providers.NewFallbackProvider(vault.provider, primary.provider), primary.snapshotID, e)
			if status != "passed" || !hasWarning(warnings, "vault copy differs") {
				t.Fatalf("status %q warnings %v", status, warnings)
			}
		})
	}
}
