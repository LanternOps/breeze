package bmr

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// fakeStateRestorer is a Restorer double for exercising applySystemState /
// RunRecoveryContext without shelling out to reg/systemctl/cp on a real OS.
// It records the stagingDir it was called with (a live, not-yet-removed
// directory — RestoreSystemState runs before applySystemState's staging-dir
// defer fires) so tests can assert on which artifacts actually landed there.
type fakeStateRestorer struct {
	restoreErr       error
	restoreStagingAt string
	restoreCalls     int
	injectCount      int
	injectErr        error
	// onRestore, if set, runs synchronously inside RestoreSystemState —
	// i.e. BEFORE applySystemState's `defer os.RemoveAll(stagingDir)`
	// fires — so tests can inspect which artifacts actually landed in
	// staging. Checking stagingDir after applySystemState returns is too
	// late: the directory is already gone by then.
	onRestore func(stagingDir string)
}

func (f *fakeStateRestorer) RestoreSystemState(stagingDir string) error {
	f.restoreCalls++
	f.restoreStagingAt = stagingDir
	if f.onRestore != nil {
		f.onRestore(stagingDir)
	}
	return f.restoreErr
}

func (f *fakeStateRestorer) InjectDrivers(_ string) (int, error) {
	return f.injectCount, f.injectErr
}

// useFakeRestorer swaps newRestorerFunc for the duration of the test.
func useFakeRestorer(t *testing.T, r Restorer) *fakeStateRestorer {
	t.Helper()
	orig := newRestorerFunc
	t.Cleanup(func() { newRestorerFunc = orig })
	newRestorerFunc = func() Restorer { return r }
	fr, _ := r.(*fakeStateRestorer)
	return fr
}

func sha256Hex(t *testing.T, data []byte) string {
	t.Helper()
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// uploadSystemStateManifest uploads a system-state manifest.json for
// snapshotID to provider (rooted at a LocalProvider), matching the
// snapshots/<id>/system-state/manifest.json layout applySystemState expects.
func uploadSystemStateManifest(t *testing.T, provider *providers.LocalProvider, snapshotID string, manifest systemstate.SystemStateManifest) {
	t.Helper()
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal state manifest: %v", err)
	}
	tmp := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		t.Fatalf("write state manifest fixture: %v", err)
	}
	key := filepath.ToSlash(path.Join("snapshots", snapshotID, "system-state", "manifest.json"))
	if err := provider.Upload(tmp, key); err != nil {
		t.Fatalf("upload state manifest: %v", err)
	}
}

// uploadSystemStateArtifact uploads artifact content under
// snapshots/<id>/system-state/<artifact.Path>, matching applySystemState's
// remote key construction.
func uploadSystemStateArtifact(t *testing.T, provider *providers.LocalProvider, snapshotID string, artifactPath string, content []byte) {
	t.Helper()
	tmp := filepath.Join(t.TempDir(), filepath.Base(artifactPath))
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		t.Fatalf("write artifact fixture: %v", err)
	}
	key := filepath.ToSlash(path.Join("snapshots", snapshotID, "system-state", artifactPath))
	if err := provider.Upload(tmp, key); err != nil {
		t.Fatalf("upload artifact: %v", err)
	}
}

// TestApplySystemState_WrongChecksum_NotAppliedAndArtifactDiscarded proves
// the checksum-verification fix (plan §2 / campaign finding B1c): an
// artifact whose downloaded bytes don't match manifest.Artifacts[].Checksum
// must not be applied — it's discarded from staging before the restorer
// runs, and the run must not be reported as StateApplied.
func TestApplySystemState_WrongChecksum_NotAppliedAndArtifactDiscarded(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-checksum-mismatch"

	goodContent := []byte("good artifact bytes")
	badContent := []byte("bad artifact bytes")
	uploadSystemStateArtifact(t, provider, snapshotID, "config/good.txt", goodContent)
	uploadSystemStateArtifact(t, provider, snapshotID, "config/bad.txt", badContent)

	uploadSystemStateManifest(t, provider, snapshotID, systemstate.SystemStateManifest{
		SchemaVersion: 1,
		Artifacts: []systemstate.Artifact{
			{Name: "good", Category: "config", Path: "config/good.txt", SizeBytes: int64(len(goodContent)), Checksum: sha256Hex(t, goodContent)},
			{Name: "bad", Category: "config", Path: "config/bad.txt", SizeBytes: int64(len(badContent)), Checksum: sha256Hex(t, []byte("not the real content"))},
		},
	})

	var goodExisted, badExisted bool
	restorer := useFakeRestorer(t, &fakeStateRestorer{
		onRestore: func(stagingDir string) {
			_, goodErr := os.Stat(filepath.Join(stagingDir, "config", "good.txt"))
			goodExisted = goodErr == nil
			_, badErr := os.Stat(filepath.Join(stagingDir, "config", "bad.txt"))
			badExisted = badErr == nil
		},
	})

	result := applySystemState(context.Background(), RecoveryConfig{SnapshotID: snapshotID}, provider)

	if result.err != nil {
		t.Fatalf("expected no fatal error (best-effort restore), got: %v", result.err)
	}
	if result.applied {
		t.Fatal("expected StateApplied-equivalent (applied) to be false when an artifact fails checksum verification")
	}
	if !result.manifestFound {
		t.Fatal("expected manifestFound to be true")
	}
	if restorer.restoreCalls != 1 {
		t.Fatalf("expected the restorer to still run once (best-effort), got %d calls", restorer.restoreCalls)
	}

	if !goodExisted {
		t.Fatal("expected the good artifact to remain staged")
	}
	if badExisted {
		t.Fatal("expected the bad-checksum artifact to be REMOVED from staging before the restorer ran")
	}

	foundWarning := false
	for _, w := range result.warnings {
		if strings.Contains(w, "bad") && strings.Contains(w, "verification") {
			foundWarning = true
		}
	}
	if !foundWarning {
		t.Fatalf("expected a warning naming the failed artifact, got: %v", result.warnings)
	}
}

// TestApplySystemState_EmptyChecksum_UnverifiedWarningButApplied proves the
// older-manifest (schemaVersion 0) compatibility path: an artifact with no
// Checksum must not be treated as a failure — just flagged "unverified" —
// so pre-D15 manifests still apply.
func TestApplySystemState_EmptyChecksum_UnverifiedWarningButApplied(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-no-checksum"

	content := []byte("legacy artifact, no checksum recorded")
	uploadSystemStateArtifact(t, provider, snapshotID, "legacy.txt", content)
	uploadSystemStateManifest(t, provider, snapshotID, systemstate.SystemStateManifest{
		SchemaVersion: 0,
		Artifacts: []systemstate.Artifact{
			{Name: "legacy", Category: "config", Path: "legacy.txt", SizeBytes: int64(len(content))},
		},
	})

	useFakeRestorer(t, &fakeStateRestorer{})
	result := applySystemState(context.Background(), RecoveryConfig{SnapshotID: snapshotID}, provider)

	if result.err != nil {
		t.Fatalf("unexpected fatal error: %v", result.err)
	}
	if !result.applied {
		t.Fatalf("expected applied=true (an unverified but present artifact is not a failure), warnings: %v", result.warnings)
	}
	found := false
	for _, w := range result.warnings {
		if strings.Contains(w, "unverified") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected an 'unverified' warning for the checksum-less artifact, got: %v", result.warnings)
	}
}

// TestApplySystemState_SizeMismatch_FailsEvenWithoutChecksum proves
// SizeBytes is checked independently of Checksum's presence — a truncated
// or corrupted download must fail verification even against an older
// manifest that never recorded a checksum.
func TestApplySystemState_SizeMismatch_FailsEvenWithoutChecksum(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-size-mismatch"

	content := []byte("short")
	uploadSystemStateArtifact(t, provider, snapshotID, "truncated.txt", content)
	uploadSystemStateManifest(t, provider, snapshotID, systemstate.SystemStateManifest{
		Artifacts: []systemstate.Artifact{
			{Name: "truncated", Category: "config", Path: "truncated.txt", SizeBytes: int64(len(content)) + 100},
		},
	})

	useFakeRestorer(t, &fakeStateRestorer{})
	result := applySystemState(context.Background(), RecoveryConfig{SnapshotID: snapshotID}, provider)

	if result.applied {
		t.Fatal("expected applied=false on a size mismatch")
	}
	found := false
	for _, w := range result.warnings {
		if strings.Contains(w, "truncated") && strings.Contains(w, "verification") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a verification-failure warning naming the artifact, got: %v", result.warnings)
	}
}

// TestApplySystemState_ManifestWithZeroArtifacts_Applies proves the
// vacuous-truth case: a manifest with no artifacts at all (nothing to
// verify) still counts as applied once the restorer succeeds against an
// empty staging dir.
func TestApplySystemState_ManifestWithZeroArtifacts_Applies(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-zero-artifacts"

	uploadSystemStateManifest(t, provider, snapshotID, systemstate.SystemStateManifest{
		SchemaVersion: 1,
	})

	restorer := useFakeRestorer(t, &fakeStateRestorer{})
	result := applySystemState(context.Background(), RecoveryConfig{SnapshotID: snapshotID}, provider)

	if result.err != nil {
		t.Fatalf("unexpected fatal error: %v", result.err)
	}
	if !result.applied {
		t.Fatalf("expected applied=true with zero artifacts and a successful restorer, warnings: %v", result.warnings)
	}
	if restorer.restoreCalls != 1 {
		t.Fatalf("expected the restorer to run once, got %d", restorer.restoreCalls)
	}
}

// TestApplySystemState_RequiredStepIncomplete_Fatal proves the
// required-step gate (plan §2 step 4.2): a required step that never
// completed must be a fatal error naming it, and must short-circuit BEFORE
// any artifact is downloaded or the restorer is invoked — an incomplete
// required capture cannot be partially applied.
func TestApplySystemState_RequiredStepIncomplete_Fatal(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-required-incomplete"

	uploadSystemStateArtifact(t, provider, snapshotID, "registry_SYSTEM", []byte("hive bytes"))
	uploadSystemStateManifest(t, provider, snapshotID, systemstate.SystemStateManifest{
		RequiredSteps:   []string{"registry", "boot"},
		IncompleteSteps: []string{"registry"},
		Artifacts: []systemstate.Artifact{
			{Name: "registry_SYSTEM", Category: "registry", Path: "registry_SYSTEM", SizeBytes: 10, Checksum: sha256Hex(t, []byte("hive bytes"))},
		},
	})

	restorer := useFakeRestorer(t, &fakeStateRestorer{})
	result := applySystemState(context.Background(), RecoveryConfig{SnapshotID: snapshotID}, provider)

	if result.err == nil {
		t.Fatal("expected a fatal error when a required step is incomplete")
	}
	if !strings.Contains(result.err.Error(), "registry") {
		t.Fatalf("expected the error to name the incomplete required step, got: %v", result.err)
	}
	if result.applied {
		t.Fatal("expected applied=false")
	}
	if !result.manifestFound {
		t.Fatal("expected manifestFound=true (the manifest itself was found and decoded)")
	}
	if restorer.restoreCalls != 0 {
		t.Fatalf("expected the restorer to NEVER run when a required step is incomplete, got %d calls", restorer.restoreCalls)
	}
}

// TestApplySystemState_NonRequiredIncomplete_WarnsOnly proves incomplete
// steps that are NOT in RequiredSteps degrade to a warning, not a fatal
// error — only the required∩incomplete intersection blocks the run.
func TestApplySystemState_NonRequiredIncomplete_WarnsOnly(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-nonrequired-incomplete"

	uploadSystemStateManifest(t, provider, snapshotID, systemstate.SystemStateManifest{
		RequiredSteps:   []string{"registry"},
		IncompleteSteps: []string{"firewall"},
	})

	useFakeRestorer(t, &fakeStateRestorer{})
	result := applySystemState(context.Background(), RecoveryConfig{SnapshotID: snapshotID}, provider)

	if result.err != nil {
		t.Fatalf("unexpected fatal error for a non-required incomplete step: %v", result.err)
	}
	if !result.applied {
		t.Fatalf("expected applied=true, warnings: %v", result.warnings)
	}
	found := false
	for _, w := range result.warnings {
		if strings.Contains(w, "firewall") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a warning naming the non-required incomplete step, got: %v", result.warnings)
	}
}

// TestApplySystemState_ExpectSystemStateTrue_ManifestMissing_Fatal proves
// the ExpectSystemState fatal path: when the bootstrap advertised system
// state for this snapshot but the manifest object itself can't be found,
// that must be treated as a broken snapshot, not "no state to restore".
func TestApplySystemState_ExpectSystemStateTrue_ManifestMissing_Fatal(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-missing-manifest"
	// Deliberately do not upload any system-state/manifest.json.

	useFakeRestorer(t, &fakeStateRestorer{})
	result := applySystemState(context.Background(), RecoveryConfig{SnapshotID: snapshotID, ExpectSystemState: true}, provider)

	if result.err == nil {
		t.Fatal("expected a fatal error when ExpectSystemState is true and the manifest is missing")
	}
	if !strings.Contains(result.err.Error(), "missing") {
		t.Fatalf("expected the error to describe the missing manifest, got: %v", result.err)
	}
	if result.manifestFound {
		t.Fatal("expected manifestFound=false (the manifest download itself failed)")
	}
	if result.applied {
		t.Fatal("expected applied=false")
	}
}

// TestApplySystemState_ExpectSystemStateFalse_ManifestMissing_Soft proves
// the existing soft-skip path is preserved when the bootstrap never
// advertised system state in the first place (an ordinary, non-system-image
// snapshot) — this must remain a warning, not an error.
func TestApplySystemState_ExpectSystemStateFalse_ManifestMissing_Soft(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-no-state-expected"

	useFakeRestorer(t, &fakeStateRestorer{})
	result := applySystemState(context.Background(), RecoveryConfig{SnapshotID: snapshotID, ExpectSystemState: false}, provider)

	if result.err != nil {
		t.Fatalf("expected no error, got: %v", result.err)
	}
	if result.applied {
		t.Fatal("expected applied=false (nothing to apply)")
	}
	if result.manifestFound {
		t.Fatal("expected manifestFound=false")
	}
	found := false
	for _, w := range result.warnings {
		if strings.Contains(w, "no system state found") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the soft-skip warning, got: %v", result.warnings)
	}
}

// --- Full-pipeline (RunRecoveryContext) status-derivation tests ---

// buildOrdinaryManifestFixture uploads a minimal one-file ordinary snapshot
// (manifest.json + its single file object) so RunRecoveryContext's file
// restore step (independent of system state) always succeeds, isolating
// these tests to the state-related status derivation.
func buildOrdinaryManifestFixture(t *testing.T, provider *providers.LocalProvider, snapshotID string) {
	t.Helper()
	srcDir := t.TempDir()
	srcPath := filepath.Join(srcDir, "data.txt")
	content := []byte("ordinary file content")
	if err := os.WriteFile(srcPath, content, 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	backupPath := filepath.ToSlash(path.Join("snapshots", snapshotID, "files", "data.txt.gz"))
	if err := provider.Upload(srcPath, backupPath); err != nil {
		t.Fatalf("upload snapshot file: %v", err)
	}

	manifest := backup.Snapshot{
		ID: snapshotID,
		Files: []backup.SnapshotFile{
			{SourcePath: filepath.Join(t.TempDir(), "data.txt"), BackupPath: backupPath, Size: int64(len(content))},
		},
		Size: int64(len(content)),
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	manifestFile := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestFile, data, 0o644); err != nil {
		t.Fatalf("write manifest fixture: %v", err)
	}
	if err := provider.Upload(manifestFile, filepath.ToSlash(path.Join("snapshots", snapshotID, "manifest.json"))); err != nil {
		t.Fatalf("upload manifest: %v", err)
	}
}

// TestRunRecoveryContext_ExpectSystemStateFalse_SoftSkip_StatusUnchanged
// proves point 3/4 together end to end: when the bootstrap never advertised
// system state, a missing system-state manifest must not affect the
// overall status at all — it stays exactly what a files-only recovery would
// have produced ("completed").
func TestRunRecoveryContext_ExpectSystemStateFalse_SoftSkip_StatusUnchanged(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-pipeline-no-state"
	buildOrdinaryManifestFixture(t, provider, snapshotID)

	useFakeRestorer(t, &fakeStateRestorer{})

	result, err := RunRecoveryContext(context.Background(), RecoveryConfig{SnapshotID: snapshotID, ExpectSystemState: false}, provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext failed: %v", err)
	}
	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed (soft-skip must not affect status)", result.Status)
	}
	if result.StateApplied {
		t.Fatal("expected StateApplied=false")
	}
}

// TestRunRecoveryContext_HappyPath_StateAppliedAndCompleted proves the
// positive case end to end: a valid system-state manifest with a verified
// artifact and a successful restorer must produce StateApplied=true and
// overall status "completed".
func TestRunRecoveryContext_HappyPath_StateAppliedAndCompleted(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-pipeline-happy"
	buildOrdinaryManifestFixture(t, provider, snapshotID)

	content := []byte("state artifact bytes")
	uploadSystemStateArtifact(t, provider, snapshotID, "config/etc.txt", content)
	uploadSystemStateManifest(t, provider, snapshotID, systemstate.SystemStateManifest{
		SchemaVersion: 1,
		Artifacts: []systemstate.Artifact{
			{Name: "etc", Category: "config", Path: "config/etc.txt", SizeBytes: int64(len(content)), Checksum: sha256Hex(t, content)},
		},
	})

	useFakeRestorer(t, &fakeStateRestorer{})

	result, err := RunRecoveryContext(context.Background(), RecoveryConfig{SnapshotID: snapshotID, ExpectSystemState: true}, provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext failed: %v", err)
	}
	if !result.StateApplied {
		t.Fatalf("expected StateApplied=true, warnings: %v", result.Warnings)
	}
	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed, warnings: %v", result.Status, result.Warnings)
	}
}

// TestRunRecoveryContext_ExpectSystemStateTrue_NotApplied_NeverCompleted
// proves the status-derivation fix at the pipeline level: whenever the
// bootstrap expected system state and it was not (fully) applied, the
// overall status must never be reported as "completed" even though the
// ordinary file restore succeeded — the API only accepts
// completed/failed/partial (bmrCompleteSchema,
// apps/api/src/routes/backup/schemas.ts), so "partial" is the value used
// here.
func TestRunRecoveryContext_ExpectSystemStateTrue_NotApplied_NeverCompleted(t *testing.T) {
	baseDir := t.TempDir()
	provider := providers.NewLocalProvider(baseDir)
	snapshotID := "snap-pipeline-expected-but-missing"
	buildOrdinaryManifestFixture(t, provider, snapshotID)
	// Deliberately no system-state manifest uploaded, but ExpectSystemState
	// is true (as if the bootstrap advertised state for this snapshot).

	useFakeRestorer(t, &fakeStateRestorer{})

	// RunRecoveryContext's second (error) return value only ever carries
	// context-cancellation or the ordinary-manifest download error (see its
	// step 1) — a system-state failure is surfaced through
	// RecoveryResult.Status/Warnings instead (mirrors how filesErr is
	// folded into result.Error rather than returned), so this test asserts
	// on the result, not on err.
	result, err := RunRecoveryContext(context.Background(), RecoveryConfig{SnapshotID: snapshotID, ExpectSystemState: true}, provider)
	if err != nil {
		t.Fatalf("RunRecoveryContext returned an unexpected top-level error: %v", err)
	}
	if result.Status == "completed" {
		t.Fatalf("status must never be completed when ExpectSystemState was true and state was not applied; got %q", result.Status)
	}
	if result.StateApplied {
		t.Fatal("expected StateApplied=false")
	}
	// Files still restored fine, so this should land on "partial", not "failed" —
	// and "partial" is one of the only three status values the API's
	// bmrCompleteSchema accepts (completed/failed/partial).
	if result.Status != "partial" {
		t.Fatalf("status = %q, want partial (files restored fine, only state failed)", result.Status)
	}
}
