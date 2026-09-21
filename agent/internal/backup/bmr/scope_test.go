package bmr

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// nonScopedProvider is a minimal providers.BackupProvider that does NOT
// implement scopedProvider — exercising ApplyManifestScope's no-confinement
// branch (e.g. a plain local/S3 provider used outside token-mode recovery).
type nonScopedProvider struct{ files map[string][]byte }

func (p *nonScopedProvider) Upload(string, string) error { return nil }
func (p *nonScopedProvider) Download(remote, local string) error {
	b, ok := p.files[remote]
	if !ok {
		return os.ErrNotExist
	}
	return writeScopeTestFile(local, b)
}
func (p *nonScopedProvider) List(string) ([]string, error) { return nil, nil }
func (p *nonScopedProvider) Delete(string) error           { return nil }

func writeScopeTestFile(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o600)
}

// scopedTestProvider implements scopedProvider on top of nonScopedProvider
// so ApplyManifestScope's interface-assertion branch can be exercised.
type scopedTestProvider struct {
	nonScopedProvider
	membership bool
	admitted   map[string]struct{}
}

func (p *scopedTestProvider) MembershipNegotiated() bool { return p.membership }
func (p *scopedTestProvider) ExtendAdmissible(keys []string) {
	if p.admitted == nil {
		p.admitted = map[string]struct{}{}
	}
	for _, k := range keys {
		p.admitted[k] = struct{}{}
	}
}
func (p *scopedTestProvider) Admits(key string) bool { _, ok := p.admitted[key]; return ok }

func TestExternalObjectKeys_SplitsOwnFromExternalAndBad(t *testing.T) {
	external, bad := ExternalObjectKeys([]string{
		"snapshots/gen-2/files/own.gz",
		"snapshots/gen-1/files/ext.gz",
		"snapshots/gen-1/files/ext.gz", // duplicate, de-duplicated
		"snapshots/gen-2/",             // invalid
	}, "gen-2")
	if !reflect.DeepEqual(external, []string{"snapshots/gen-1/files/ext.gz"}) {
		t.Fatalf("external = %v", external)
	}
	if !reflect.DeepEqual(bad, []string{"snapshots/gen-2/"}) {
		t.Fatalf("bad = %v", bad)
	}
}

func TestApplyManifestScope_NonScopedProviderIsNoConfinement(t *testing.T) {
	p := &nonScopedProvider{}
	if err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApplyManifestScope_NoExternalEntriesIsFine(t *testing.T) {
	p := &scopedTestProvider{membership: false}
	if err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-2/files/a.gz"}, "sha", nil); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApplyManifestScope_ExternalWithoutMembershipRefuses(t *testing.T) {
	p := &scopedTestProvider{membership: false}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha", nil)
	var refusal *ScopeRefusalError
	if !errors.As(err, &refusal) {
		t.Fatalf("expected *ScopeRefusalError, got %v", err)
	}
	if refusal.External != 1 {
		t.Fatalf("External = %d, want 1", refusal.External)
	}
	if !strings.Contains(refusal.Reason, "cross-snapshot") {
		t.Fatalf("Reason = %q, want it to mention cross-snapshot", refusal.Reason)
	}
}

// TestApplyManifestScope_MembershipGrantedButNoFileIndexRefuses covers the
// case where the server negotiated the capability (so bootstrap.Snapshot.
// FileIndex is technically reachable) but sent no fileIndex at all —
// meaning the server itself believed this snapshot was self-contained
// (referenced_files NULL/0) even though the manifest we just parsed proves
// otherwise (e.g. an older agent never reported referenced_files). Never
// widen scope on that assumption.
func TestApplyManifestScope_MembershipGrantedButNoFileIndexRefuses(t *testing.T) {
	p := &scopedTestProvider{membership: true}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha-actual", nil)
	var refusal *ScopeRefusalError
	if !errors.As(err, &refusal) {
		t.Fatalf("expected *ScopeRefusalError, got %v", err)
	}
	if refusal.External != 1 {
		t.Fatalf("External = %d, want 1", refusal.External)
	}
	if !strings.Contains(refusal.Reason, "no verified file index") {
		t.Fatalf("Reason = %q, want it to mention 'no verified file index'", refusal.Reason)
	}
	if p.Admits("snapshots/gen-1/files/a.gz") {
		t.Fatalf("admissible set must not have been widened on refusal")
	}
}

func TestApplyManifestScope_MissingOrIncompleteFileIndexRefuses(t *testing.T) {
	p := &scopedTestProvider{membership: true}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha-actual", nil)
	if err == nil {
		t.Fatal("expected error for nil fileIndex")
	}

	err = ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha-actual",
		&FileIndexInfo{Status: "hydrating", ManifestSHA256: "sha-actual"})
	if err == nil {
		t.Fatal("expected error for hydrating fileIndex")
	}
}

func TestApplyManifestScope_ShaMismatchRefuses(t *testing.T) {
	p := &scopedTestProvider{membership: true}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz"}, "sha-actual",
		&FileIndexInfo{Status: "complete", ManifestSHA256: "sha-different"})
	if err == nil {
		t.Fatal("expected error for sha mismatch")
	}
}

func TestApplyManifestScope_GrantedPathExtendsAdmissibleSet(t *testing.T) {
	p := &scopedTestProvider{membership: true}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-1/files/a.gz", "snapshots/gen-2/files/own.gz"}, "sha-actual",
		&FileIndexInfo{Status: "complete", ManifestSHA256: "sha-actual"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !p.Admits("snapshots/gen-1/files/a.gz") {
		t.Fatal("expected external key to be admitted")
	}
}

func TestApplyManifestScope_BadKeyAlwaysRefusesRegardlessOfMembership(t *testing.T) {
	p := &scopedTestProvider{membership: true}
	err := ApplyManifestScope(p, "gen-2", []string{"snapshots/gen-2/"}, "sha-actual",
		&FileIndexInfo{Status: "complete", ManifestSHA256: "sha-actual"})
	var refusal *ScopeRefusalError
	if !errors.As(err, &refusal) {
		t.Fatalf("expected *ScopeRefusalError, got %v", err)
	}
}

func TestWidenScopeFromManifest_DownloadsHashesAndAppliesScope(t *testing.T) {
	manifestJSON := `{"id":"gen-2","files":[{"backupPath":"snapshots/gen-1/files/a.gz","size":1},{"backupPath":"snapshots/gen-2/files/b.gz","size":1}]}`
	sum := sha256.Sum256([]byte(manifestJSON))
	sha := hex.EncodeToString(sum[:])

	files := map[string][]byte{"snapshots/gen-2/manifest.json": []byte(manifestJSON)}
	p := &scopedTestProvider{membership: true, nonScopedProvider: nonScopedProvider{files: files}}
	bs := &BootstrapResponse{Snapshot: &AuthenticatedSnapshot{SnapshotID: "gen-2",
		FileIndex: &FileIndexInfo{Status: "complete", ManifestSHA256: sha}}}

	if err := WidenScopeFromManifest(context.Background(), p, bs); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !p.Admits("snapshots/gen-1/files/a.gz") {
		t.Fatal("expected external key to be admitted")
	}
}

func TestWidenScopeFromManifest_RefusesWithoutIOWhenCapabilityMissing(t *testing.T) {
	// The manifest download still happens (it's needed to classify entries),
	// but no target write occurs — this is a pure classification/refusal
	// path, proven here by the caller never reaching restore.
	manifestJSON := `{"id":"gen-2","files":[{"backupPath":"snapshots/gen-1/files/a.gz","size":1}]}`
	files := map[string][]byte{"snapshots/gen-2/manifest.json": []byte(manifestJSON)}
	p := &scopedTestProvider{membership: false, nonScopedProvider: nonScopedProvider{files: files}}
	bs := &BootstrapResponse{Snapshot: &AuthenticatedSnapshot{SnapshotID: "gen-2"}}

	err := WidenScopeFromManifest(context.Background(), p, bs)
	var refusal *ScopeRefusalError
	if !errors.As(err, &refusal) {
		t.Fatalf("expected *ScopeRefusalError, got %v", err)
	}
	if p.Admits("snapshots/gen-1/files/a.gz") {
		t.Fatal("admissible set must not have been widened on refusal")
	}
}
