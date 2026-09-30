package integrity

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

type memProvider struct {
	objects   map[string]string
	downloads []string
}

func (m *memProvider) Upload(string, string) error   { return nil }
func (m *memProvider) List(string) ([]string, error) { return nil, nil }
func (m *memProvider) Delete(string) error           { return nil }
func (m *memProvider) Download(remote, local string) error {
	m.downloads = append(m.downloads, remote)
	body, ok := m.objects[remote]
	if !ok {
		return providers.ErrObjectNotFound
	}
	return os.WriteFile(local, []byte(body), 0o600)
}

const manifestKey = "snapshots/snap-1/manifest.json"

func TestFetchControlObject(t *testing.T) {
	manifest := `{"id":"snap-1","files":[]}`
	attested := mustParse(t, attestedJSON("snap-1", manifest))
	override := mustParse(t, `{"v":1,"mode":"unattested_override","snapshotId":"snap-1","authorizationId":"a"}`)
	tampered := `{"id":"snap-1","files":[1]}`[:len(manifest)] // same length, different bytes
	if len(tampered) != len(manifest) || tampered == manifest {
		t.Fatal("fixture: tampered manifest must be the same size and differ")
	}
	cases := []struct {
		name    string
		e       *Expectation
		stored  string
		role    string
		key     string
		wantErr error
		errText string
	}{
		{name: "attested matching bytes", e: attested, stored: manifest, role: RoleManifest, key: manifestKey},
		{name: "attested same size different bytes", e: attested, stored: tampered, role: RoleManifest, key: manifestKey, wantErr: ErrIntegrityMismatch},
		{name: "attested requested key differs from attestation", e: attested, stored: manifest, role: RoleManifest, key: "snapshots/snap-2/manifest.json", errText: "key"},
		{name: "attested role not attested", e: attested, stored: manifest, role: RoleLayout, key: "snapshots/snap-1/layout.json", wantErr: ErrObjectNotAttested},
		{name: "override skips digest", e: override, stored: tampered, role: RoleManifest, key: manifestKey},
		{name: "absent expectation skips digest", e: nil, stored: tampered, role: RoleManifest, key: manifestKey},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := &memProvider{objects: map[string]string{tc.key: tc.stored, manifestKey: tc.stored}}
			data, warnings, err := FetchControlObject(context.Background(), p, tc.e, tc.role, tc.key, t.TempDir())
			if tc.wantErr != nil || tc.errText != "" {
				if err == nil {
					t.Fatal("expected an error")
				}
				if tc.wantErr != nil && !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				if tc.errText != "" && !strings.Contains(err.Error(), tc.errText) {
					t.Fatalf("err = %v, want containing %q", err, tc.errText)
				}
				if data != nil {
					t.Fatal("no bytes may be returned on failure")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if string(data) != tc.stored {
				t.Fatalf("data = %q", data)
			}
			if len(warnings) != 0 {
				t.Fatalf("warnings = %v", warnings)
			}
		})
	}
}

func TestFetchControlObjectFallsBackToPrimaryWhenVaultCopyDiffers(t *testing.T) {
	manifest := `{"id":"snap-1","files":[]}`
	other := `{"id":"snap-1","files":{}}`
	attested := mustParse(t, attestedJSON("snap-1", manifest))

	vault := &memProvider{objects: map[string]string{manifestKey: other}}
	primary := &memProvider{objects: map[string]string{manifestKey: manifest}}
	data, warnings, err := FetchControlObject(context.Background(), providers.NewFallbackProvider(vault, primary), attested, RoleManifest, manifestKey, t.TempDir())
	if err != nil || string(data) != manifest {
		t.Fatalf("data=%q err=%v", data, err)
	}
	if len(warnings) != 1 || warnings[0] != VaultCopyDiffersWarning(manifestKey) {
		t.Fatalf("warnings = %v", warnings)
	}

	// Both differ: refused.
	primary.objects[manifestKey] = other
	if _, _, err := FetchControlObject(context.Background(), providers.NewFallbackProvider(vault, primary), attested, RoleManifest, manifestKey, t.TempDir()); !errors.Is(err, ErrIntegrityMismatch) {
		t.Fatalf("err = %v", err)
	}
}

func TestDownloadCheckedRetriesPrimaryOnlyWithAnExpectation(t *testing.T) {
	body := "file bytes"
	other := "FILE BYTES"
	want := Stored{Size: int64(len(body)), SHA256: sum(body)}
	attested := mustParse(t, attestedJSON("snap-1", "m"))

	for _, tc := range []struct {
		name        string
		e           *Expectation
		vault, prim string
		wantErr     bool
		wantBody    string
		wantWarning bool
	}{
		{name: "attested vault differs, primary good", e: attested, vault: other, prim: body, wantBody: body, wantWarning: true},
		{name: "attested both differ", e: attested, vault: other, prim: other, wantErr: true},
		{name: "attested vault good", e: attested, vault: body, prim: other, wantBody: body},
		{name: "no expectation keeps single attempt", e: nil, vault: other, prim: body, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			vault := &memProvider{objects: map[string]string{"k": tc.vault}}
			primary := &memProvider{objects: map[string]string{"k": tc.prim}}
			dest := filepath.Join(t.TempDir(), "dest")
			_, warnings, err := DownloadChecked(context.Background(), providers.NewFallbackProvider(vault, primary), "k", dest, want, tc.e)
			if tc.wantErr {
				if err == nil {
					t.Fatal("expected failure")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(dest)
			if string(got) != tc.wantBody {
				t.Fatalf("body %q", got)
			}
			if (len(warnings) == 1) != tc.wantWarning {
				t.Fatalf("warnings = %v", warnings)
			}
		})
	}
}

func TestStageAndPublish(t *testing.T) {
	body := "vhdx bytes"
	want := Stored{Size: int64(len(body)), SHA256: sum(body)}
	attested := mustParse(t, attestedJSON("snap-1", "m"))

	t.Run("match publishes and leaves no staging file", func(t *testing.T) {
		dir := t.TempDir()
		final := filepath.Join(dir, "disk.vhdx")
		p := &memProvider{objects: map[string]string{"k": body}}
		if _, _, err := StageAndPublish(context.Background(), p, "k", final, want, attested); err != nil {
			t.Fatal(err)
		}
		got, _ := os.ReadFile(final)
		if string(got) != body {
			t.Fatalf("final = %q", got)
		}
		assertOnlyEntries(t, dir, "disk.vhdx")
	})
	t.Run("mismatch leaves neither the final file nor staging", func(t *testing.T) {
		dir := t.TempDir()
		final := filepath.Join(dir, "disk.vhdx")
		p := &memProvider{objects: map[string]string{"k": "VHDX BYTES"}}
		_, _, err := StageAndPublish(context.Background(), p, "k", final, want, attested)
		if !errors.Is(err, ErrIntegrityMismatch) {
			t.Fatalf("err = %v", err)
		}
		assertOnlyEntries(t, dir)
	})
	t.Run("mismatch keeps an existing final file untouched", func(t *testing.T) {
		dir := t.TempDir()
		final := filepath.Join(dir, "disk.vhdx")
		if err := os.WriteFile(final, []byte("previous"), 0o600); err != nil {
			t.Fatal(err)
		}
		p := &memProvider{objects: map[string]string{"k": "VHDX BYTES"}}
		if _, _, err := StageAndPublish(context.Background(), p, "k", final, want, attested); err == nil {
			t.Fatal("expected failure")
		}
		got, _ := os.ReadFile(final)
		if string(got) != "previous" {
			t.Fatalf("final changed to %q", got)
		}
	})
}

func assertOnlyEntries(t *testing.T, dir string, names ...string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range entries {
		got = append(got, e.Name())
	}
	if strings.Join(got, ",") != strings.Join(names, ",") {
		t.Fatalf("dir holds %v, want %v", got, names)
	}
}

func TestDownloadCheckedViaUsesTheSuppliedDownloaderForEveryAttempt(t *testing.T) {
	body := "file bytes"
	want := Stored{Size: int64(len(body)), SHA256: sum(body)}
	attested := mustParse(t, attestedJSON("snap-1", "m"))
	vault := &memProvider{objects: map[string]string{"k": "FILE BYTES"}}
	primary := &memProvider{objects: map[string]string{"k": body}}
	calls := 0
	dl := func(ctx context.Context, p providers.BackupProvider, key, dest string) error {
		calls++
		return p.Download(key, dest)
	}
	dest := filepath.Join(t.TempDir(), "dest")
	_, warnings, err := DownloadCheckedVia(context.Background(), dl, providers.NewFallbackProvider(vault, primary), "k", dest, want, attested)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || len(warnings) != 1 {
		t.Fatalf("calls=%d warnings=%v", calls, warnings)
	}
	if len(vault.downloads) != 1 || len(primary.downloads) != 1 {
		t.Fatalf("vault=%v primary=%v", vault.downloads, primary.downloads)
	}
}

func TestCheckControlObjectFile(t *testing.T) {
	manifest := `{"id":"snap-1","files":[]}`
	attested := mustParse(t, attestedJSON("snap-1", manifest))
	good := writeTemp(t, manifest)
	if err := CheckControlObjectFile(attested, RoleManifest, manifestKey, good); err != nil {
		t.Fatal(err)
	}
	if err := CheckControlObjectFile(attested, RoleManifest, manifestKey, writeTemp(t, `{"id":"snap-1","files":{}}`)); !errors.Is(err, ErrIntegrityMismatch) {
		t.Fatalf("err = %v", err)
	}
	if err := CheckControlObjectFile(attested, RoleLayout, "snapshots/snap-1/layout.json", good); !errors.Is(err, ErrObjectNotAttested) {
		t.Fatalf("err = %v", err)
	}
	if err := CheckControlObjectFile(nil, RoleManifest, manifestKey, good); err != nil {
		t.Fatal("absent expectation checks nothing")
	}
}
