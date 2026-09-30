package bmr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// recoveryFixture is a snapshot in a LocalProvider whose manifest entries
// carry checksums, plus the per-file target overrides that redirect the
// recovery into a temp directory.
type recoveryFixture struct {
	provider      *providers.LocalProvider
	baseDir       string
	snapshotID    string
	manifestBytes []byte
	targetRoot    string
	targets       map[string]string // source path -> target path
	backupPaths   map[string]string // source path -> backup key
}

type fixtureFile struct {
	source   string
	content  []byte
	noSum    bool
	volatile bool
}

func newRecoveryFixture(t *testing.T, snapshotID string, files []fixtureFile) *recoveryFixture {
	t.Helper()
	fx := &recoveryFixture{
		baseDir:     t.TempDir(),
		snapshotID:  snapshotID,
		targetRoot:  t.TempDir(),
		targets:     map[string]string{},
		backupPaths: map[string]string{},
	}
	fx.provider = providers.NewLocalProvider(fx.baseDir)
	var entries []backup.SnapshotFile
	for i, f := range files {
		key := path.Join("snapshots", snapshotID, "files", fmt.Sprintf("f%d", i))
		fx.putObject(t, key, f.content)
		sum := ""
		if !f.noSum {
			sum = integrity.DigestBytes(f.content)
		}
		entries = append(entries, backup.SnapshotFile{
			SourcePath: f.source, BackupPath: key, Size: int64(len(f.content)),
			Checksum: sum, Volatile: f.volatile,
		})
		fx.targets[f.source] = filepath.Join(fx.targetRoot, filepath.FromSlash(strings.TrimPrefix(f.source, "/")))
		fx.backupPaths[f.source] = key
	}
	data, err := json.Marshal(backup.Snapshot{ID: snapshotID, Files: entries})
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	fx.manifestBytes = data
	fx.putObject(t, path.Join("snapshots", snapshotID, "manifest.json"), data)
	return fx
}

func (fx *recoveryFixture) putObject(t *testing.T, key string, data []byte) {
	t.Helper()
	local := filepath.Join(fx.baseDir, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(local, data, 0o644); err != nil {
		t.Fatalf("write object: %v", err)
	}
}

func (fx *recoveryFixture) config(e *integrity.Expectation) RecoveryConfig {
	return RecoveryConfig{SnapshotID: fx.snapshotID, TargetPaths: fx.targets, Integrity: e}
}

// attestedExpectation builds an attested expectation whose manifest object
// digests manifestBytes, plus any extra objects.
func attestedExpectation(t *testing.T, snapshotID string, manifestBytes []byte, extra ...integrity.Object) *integrity.Expectation {
	t.Helper()
	objects := append([]integrity.Object{{
		Role: integrity.RoleManifest, Key: path.Join("snapshots", snapshotID, "manifest.json"),
		SHA256: integrity.DigestBytes(manifestBytes), Size: int64(len(manifestBytes)),
	}}, extra...)
	raw, err := json.Marshal(map[string]any{
		"v": 1, "mode": "attested", "trust": "server_verified", "snapshotId": snapshotID, "objects": objects,
	})
	if err != nil {
		t.Fatalf("marshal expectation: %v", err)
	}
	e, err := integrity.Parse(raw)
	if err != nil {
		t.Fatalf("parse expectation: %v", err)
	}
	return e
}

func overrideExpectation(t *testing.T, snapshotID string) *integrity.Expectation {
	t.Helper()
	e, err := integrity.Parse(json.RawMessage(fmt.Sprintf(`{"v":1,"mode":"unattested_override","snapshotId":%q,"authorizationId":"6f1c2c1e-0000-4000-8000-000000000001"}`, snapshotID)))
	if err != nil {
		t.Fatalf("parse expectation: %v", err)
	}
	return e
}

func assertNoStagingLeftovers(t *testing.T, root string) {
	t.Helper()
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err == nil && strings.HasPrefix(info.Name(), integrity.StagingPrefix) {
			t.Errorf("staging file left behind: %s", p)
		}
		return nil
	})
}

func countFiles(t *testing.T, root string) int {
	t.Helper()
	n := 0
	_ = filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			n++
		}
		return nil
	})
	return n
}

func TestRunRecoveryContext_AttestedManifestMatches_RestoresFiles(t *testing.T) {
	fx := newRecoveryFixture(t, "snap-att-ok", []fixtureFile{
		{source: "/data/a.txt", content: []byte("alpha")},
		{source: "/data/b.txt", content: []byte("bravo bravo")},
	})
	e := attestedExpectation(t, fx.snapshotID, fx.manifestBytes)

	res, err := RunRecoveryContext(context.Background(), fx.config(e), fx.provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext: %v", err)
	}
	if res.FilesRestored != 2 || res.FailedFiles != 0 {
		t.Fatalf("filesRestored=%d failedFiles=%d warnings=%v, want 2/0", res.FilesRestored, res.FailedFiles, res.Warnings)
	}
	got, _ := os.ReadFile(fx.targets["/data/b.txt"])
	if string(got) != "bravo bravo" {
		t.Fatalf("restored b = %q", got)
	}
	for _, w := range res.Warnings {
		if strings.Contains(w, "unattested") {
			t.Fatalf("attested recovery carries an unattested warning: %v", res.Warnings)
		}
	}
	assertNoStagingLeftovers(t, fx.targetRoot)
}

func TestRunRecoveryContext_ManifestBytesDifferFromAttestation_FailsBeforeAnyWrite(t *testing.T) {
	fx := newRecoveryFixture(t, "snap-att-manifest", []fixtureFile{
		{source: "/data/a.txt", content: []byte("alpha")},
	})
	// Attest a manifest of the same size with different bytes.
	other := bytes.Repeat([]byte("x"), len(fx.manifestBytes))
	e := attestedExpectation(t, fx.snapshotID, other)

	res, err := RunRecoveryContext(context.Background(), fx.config(e), fx.provider)
	if err == nil {
		t.Fatalf("RunRecoveryContext succeeded; want an integrity failure (result %+v)", res)
	}
	if !errors.Is(err, integrity.ErrIntegrityMismatch) {
		t.Fatalf("err = %v, want ErrIntegrityMismatch", err)
	}
	if res == nil || res.Status != "failed" || res.FilesRestored != 0 {
		t.Fatalf("result = %+v, want failed with nothing restored", res)
	}
	if res.Code != "integrity_mismatch" {
		t.Fatalf("result code = %q, want integrity_mismatch", res.Code)
	}
	if n := countFiles(t, fx.targetRoot); n != 0 {
		t.Fatalf("%d file(s) written to the target after a manifest integrity failure", n)
	}
}

func TestRunRecoveryContext_AttestedManifest_FileIndexDigestStillChecked(t *testing.T) {
	snapshotID := "gen-2"
	manifest := backup.Snapshot{ID: snapshotID, Files: []backup.SnapshotFile{
		{SourcePath: "/a", BackupPath: "snapshots/gen-1/files/a.gz", Size: 1, Checksum: integrity.DigestBytes([]byte("a"))},
	}}
	manifestData, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	manifestKey := path.Join("snapshots", snapshotID, "manifest.json")
	provider := &scopeGuardProvider{scopedTestProvider: scopedTestProvider{
		membership:        true,
		admitted:          map[string]struct{}{},
		nonScopedProvider: nonScopedProvider{files: map[string][]byte{manifestKey: manifestData}},
	}}
	e := attestedExpectation(t, snapshotID, manifestData)
	fi := &FileIndexInfo{Status: "complete", ManifestSHA256: strings.Repeat("0", 64), ExternalCount: 1, OriginSnapshotIDs: []string{"gen-1"}}

	res, err := RunRecoveryContext(context.Background(), RecoveryConfig{SnapshotID: snapshotID, FileIndex: fi, Integrity: e}, provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext: %v", err)
	}
	if res.Status != "refused" || !strings.Contains(res.Error, "file index does not match") {
		t.Fatalf("result = %+v, want the file-index digest refusal", res)
	}
	for _, k := range provider.downloaded {
		if k != manifestKey {
			t.Fatalf("downloaded %q before the file-index refusal", k)
		}
	}
}

func TestRunRecoveryContext_AttestedFileChecks(t *testing.T) {
	cases := []struct {
		name     string
		file     fixtureFile
		stored   []byte // bytes actually in storage; nil = same as content
		wantCode string
	}{
		{name: "same-size different bytes", file: fixtureFile{source: "/d/x.bin", content: []byte("original")}, stored: []byte("changed!"), wantCode: "integrity_mismatch"},
		{name: "entry without checksum", file: fixtureFile{source: "/d/x.bin", content: []byte("original"), noSum: true}, wantCode: "missing_checksum"},
		{name: "volatile entry with different size", file: fixtureFile{source: "/d/x.bin", content: []byte("original"), volatile: true}, stored: []byte("original plus more"), wantCode: "integrity_mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fx := newRecoveryFixture(t, "snap-att-files", []fixtureFile{
				tc.file,
				{source: "/d/ok.txt", content: []byte("fine")},
			})
			if tc.stored != nil {
				fx.putObject(t, fx.backupPaths[tc.file.source], tc.stored)
			}
			// A pre-existing target must be left exactly as it was.
			target := fx.targets[tc.file.source]
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, []byte("pre-existing"), 0o644); err != nil {
				t.Fatal(err)
			}
			e := attestedExpectation(t, fx.snapshotID, fx.manifestBytes)

			res, _ := RunRecoveryContext(context.Background(), fx.config(e), fx.provider)
			if res.FailedFiles != 1 || res.FilesRestored != 1 {
				t.Fatalf("failedFiles=%d filesRestored=%d warnings=%v, want 1/1", res.FailedFiles, res.FilesRestored, res.Warnings)
			}
			got, _ := os.ReadFile(target)
			if string(got) != "pre-existing" {
				t.Fatalf("failed file was installed: target now %q", got)
			}
			joined := strings.Join(res.Warnings, "\n")
			if !strings.Contains(joined, tc.wantCode) {
				t.Fatalf("warnings %v do not name %s", res.Warnings, tc.wantCode)
			}
			if ok, _ := os.ReadFile(fx.targets["/d/ok.txt"]); string(ok) != "fine" {
				t.Fatalf("unaffected file not restored: %q", ok)
			}
			assertNoStagingLeftovers(t, fx.targetRoot)
		})
	}
}

func TestRunRecoveryContext_OverrideMode_EarlierBehaviourPlusOneWarning(t *testing.T) {
	fx := newRecoveryFixture(t, "snap-override", []fixtureFile{
		{source: "/d/a.txt", content: []byte("alpha")},
		{source: "/d/b.txt", content: []byte("bravo")},
	})
	e := overrideExpectation(t, fx.snapshotID)

	res, err := RunRecoveryContext(context.Background(), fx.config(e), fx.provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext: %v", err)
	}
	if res.FilesRestored != 2 {
		t.Fatalf("filesRestored = %d, want 2", res.FilesRestored)
	}
	n := 0
	for _, w := range res.Warnings {
		if w == integrity.UnattestedRestoreWarning {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("unattested warning appears %d times in %v, want exactly once", n, res.Warnings)
	}
}

func TestRunRecoveryContext_ExpectationForAnotherSnapshot_FailsBeforeAnyDownload(t *testing.T) {
	fx := newRecoveryFixture(t, "snap-mine", []fixtureFile{{source: "/d/a.txt", content: []byte("alpha")}})
	e := attestedExpectation(t, "snap-other", fx.manifestBytes)
	counting := &countingDownloadProvider{LocalProvider: fx.provider}

	res, err := RunRecoveryContext(context.Background(), fx.config(e), counting)
	if err == nil || !errors.Is(err, integrity.ErrInvalidExpectation) {
		t.Fatalf("err = %v, want ErrInvalidExpectation", err)
	}
	if res == nil || res.Status != "failed" {
		t.Fatalf("result = %+v, want failed", res)
	}
	if counting.downloadCalls != 0 {
		t.Fatalf("%d download(s) before the snapshot check", counting.downloadCalls)
	}
}

func TestRunRecoveryWithToken_BootstrapIntegrity(t *testing.T) {
	snapshotID := "snap-bootstrap"
	manifest := []byte(`{"id":"snap-bootstrap","files":[]}`)
	attestedRaw := fmt.Sprintf(`{"v":1,"mode":"attested","trust":"server_verified","snapshotId":%q,"objects":[{"role":"manifest","key":"snapshots/%s/manifest.json","sha256":%q,"size":%d}]}`,
		snapshotID, snapshotID, integrity.DigestBytes(manifest), len(manifest))

	cases := []struct {
		name          string
		snapIntegrity string
		topIntegrity  string
		wantErr       bool
		wantAttested  bool
		wantPresent   bool
	}{
		{name: "absent", wantPresent: false},
		{name: "on the snapshot", snapIntegrity: attestedRaw, wantPresent: true, wantAttested: true},
		{name: "at the top level", topIntegrity: attestedRaw, wantPresent: true, wantAttested: true},
		{name: "unknown version", snapIntegrity: `{"v":2,"mode":"attested","snapshotId":"snap-bootstrap"}`, wantErr: true},
		{name: "for another snapshot", snapIntegrity: strings.ReplaceAll(attestedRaw, "snap-bootstrap", "snap-else"), wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotCfg *RecoveryConfig
			orig := runRecovery
			runRecovery = func(_ context.Context, cfg RecoveryConfig, _ providers.BackupProvider) (*RecoveryResult, error) {
				gotCfg = &cfg
				return &RecoveryResult{Status: "completed"}, nil
			}
			t.Cleanup(func() { runRecovery = orig })

			var completed *RecoveryResult
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/v1/backup/bmr/recover/authenticate":
					snap := map[string]any{"id": "row-1", "snapshotId": snapshotID}
					if tc.snapIntegrity != "" {
						snap["integrity"] = json.RawMessage(tc.snapIntegrity)
					}
					bs := map[string]any{
						"version": 1, "snapshot": snap,
						"backupConfig": map[string]any{"id": "cfg", "provider": "local", "providerConfig": map[string]any{"path": t.TempDir()}},
					}
					if tc.topIntegrity != "" {
						bs["integrity"] = json.RawMessage(tc.topIntegrity)
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"bootstrap": bs})
				case "/api/v1/backup/bmr/recover/complete":
					var p struct {
						Result RecoveryResult `json:"result"`
					}
					_ = json.NewDecoder(r.Body).Decode(&p)
					completed = &p.Result
					_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
				default:
					http.NotFound(w, r)
				}
			}))
			defer server.Close()

			_, err := RunRecoveryWithTokenContext(context.Background(), RecoveryConfig{RecoveryToken: "brz_rec_t", ServerURL: server.URL})
			if tc.wantErr {
				if err == nil || !errors.Is(err, integrity.ErrInvalidExpectation) {
					t.Fatalf("err = %v, want ErrInvalidExpectation", err)
				}
				if gotCfg != nil {
					t.Fatal("recovery ran despite an invalid integrity block")
				}
				if completed == nil || completed.Status != "failed" || completed.Error == "" {
					t.Fatalf("completion = %+v, want a failed completion with a reason", completed)
				}
				return
			}
			if err != nil {
				t.Fatalf("RunRecoveryWithTokenContext: %v", err)
			}
			if gotCfg == nil {
				t.Fatal("recovery did not run")
			}
			if gotCfg.Integrity.Present() != tc.wantPresent || gotCfg.Integrity.Attested() != tc.wantAttested {
				t.Fatalf("cfg.Integrity present=%v attested=%v, want %v/%v", gotCfg.Integrity.Present(), gotCfg.Integrity.Attested(), tc.wantPresent, tc.wantAttested)
			}
		})
	}
}

func TestResolveIntegrity(t *testing.T) {
	manifest := []byte(`{"files":[]}`)
	att := attestedExpectation(t, "s1", manifest)
	att2 := attestedExpectation(t, "s1", []byte(`{"files":[1]}`))
	ovr := overrideExpectation(t, "s1")
	cases := []struct {
		name      string
		cmd, boot *integrity.Expectation
		want      *integrity.Expectation
		wantErr   bool
	}{
		{name: "both absent", want: nil},
		{name: "command only", cmd: ovr, want: ovr},
		{name: "bootstrap only", boot: att, want: att},
		{name: "attested wins over override", cmd: ovr, boot: att, want: att},
		{name: "attested command wins over override bootstrap", cmd: att, boot: ovr, want: att},
		{name: "two different attestations", cmd: att, boot: att2, wantErr: true},
		{name: "two equal attestations", cmd: att, boot: attestedExpectation(t, "s1", manifest), want: att},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ResolveIntegrity(tc.cmd, tc.boot)
			if tc.wantErr {
				if err == nil || !errors.Is(err, integrity.ErrInvalidExpectation) {
					t.Fatalf("err = %v, want ErrInvalidExpectation", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ResolveIntegrity: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestRecoveryRequests_CarryIntegrityProtocolVersion(t *testing.T) {
	for _, endpoint := range []string{"authenticate", "exchange"} {
		t.Run(endpoint, func(t *testing.T) {
			var body map[string]json.RawMessage
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&body)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(realExchangeEnvelope))
			}))
			defer server.Close()
			if endpoint == "authenticate" {
				_, _ = AuthenticateRecoverySession(context.Background(), server.URL, "brz_rec_t")
			} else {
				_, _, _ = ExchangeRecoveryCode(context.Background(), server.URL, "ABCD-1234", "0.119.0")
			}
			raw, ok := body["integrityProtocolVersion"]
			if !ok {
				t.Fatalf("%s request body %v has no integrityProtocolVersion", endpoint, body)
			}
			if string(raw) != fmt.Sprint(integrity.ProtocolVersion) {
				t.Fatalf("integrityProtocolVersion = %s, want %d", raw, integrity.ProtocolVersion)
			}
		})
	}
}

func TestWidenScopeFromManifestVerified(t *testing.T) {
	snapshotID := "gen-2"
	manifestData, _ := json.Marshal(backup.Snapshot{ID: snapshotID, Files: []backup.SnapshotFile{
		{SourcePath: "/a", BackupPath: "snapshots/gen-1/files/a.gz", Size: 1},
	}})
	manifestKey := path.Join("snapshots", snapshotID, "manifest.json")
	fi := &FileIndexInfo{Status: "complete", ManifestSHA256: integrity.DigestBytes(manifestData), ExternalCount: 1, OriginSnapshotIDs: []string{"gen-1"}}
	bs := &BootstrapResponse{Snapshot: &AuthenticatedSnapshot{SnapshotID: snapshotID, FileIndex: fi}}
	cases := []struct {
		name     string
		e        *integrity.Expectation
		wantErr  error
		wantWide bool
	}{
		{name: "attested and matching", e: attestedExpectation(t, snapshotID, manifestData), wantWide: true},
		{name: "manifest bytes differ from attestation", e: attestedExpectation(t, snapshotID, bytes.Repeat([]byte("m"), len(manifestData))), wantErr: integrity.ErrIntegrityMismatch},
		{name: "absent", wantWide: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			provider := &scopedTestProvider{membership: true, nonScopedProvider: nonScopedProvider{files: map[string][]byte{manifestKey: manifestData}}}
			err := WidenScopeFromManifestVerified(context.Background(), provider, bs, tc.e)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
			} else if err != nil {
				t.Fatalf("WidenScopeFromManifestVerified: %v", err)
			}
			if got := provider.Admits("snapshots/gen-1/files/a.gz"); got != tc.wantWide {
				t.Fatalf("scope widened = %v, want %v", got, tc.wantWide)
			}
		})
	}
}

func TestWidenScopeFromManifest_UsesBootstrapIntegrity(t *testing.T) {
	snapshotID := "snap-w"
	manifestData := []byte(`{"id":"snap-w","files":[]}`)
	manifestKey := path.Join("snapshots", snapshotID, "manifest.json")
	other := bytes.Repeat([]byte("m"), len(manifestData))
	raw := fmt.Sprintf(`{"v":1,"mode":"attested","trust":"server_verified","snapshotId":%q,"objects":[{"role":"manifest","key":%q,"sha256":%q,"size":%d}]}`,
		snapshotID, manifestKey, integrity.DigestBytes(other), len(other))
	bs := &BootstrapResponse{Snapshot: &AuthenticatedSnapshot{SnapshotID: snapshotID, Integrity: json.RawMessage(raw)}}
	provider := &nonScopedProvider{files: map[string][]byte{manifestKey: manifestData}}
	if err := WidenScopeFromManifest(context.Background(), provider, bs); !errors.Is(err, integrity.ErrIntegrityMismatch) {
		t.Fatalf("err = %v, want ErrIntegrityMismatch", err)
	}
}
