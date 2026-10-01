package hyperv

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/integrity"
)

const vmSnapID = "snap-vm-1"
const vmManifestKey = "snapshots/" + vmSnapID + "/manifest.json"

func attestedFor(t *testing.T, manifest []byte) *integrity.Expectation {
	t.Helper()
	raw := fmt.Sprintf(`{"v":1,"mode":"attested","trust":"server_verified","snapshotId":%q,"objects":[{"role":"manifest","key":%q,"sha256":%q,"size":%d}]}`,
		vmSnapID, vmManifestKey, integrity.DigestBytes(manifest), len(manifest))
	e, err := integrity.Parse(json.RawMessage(raw))
	if err != nil {
		t.Fatalf("parse expectation: %v", err)
	}
	return e
}

func overrideFor(t *testing.T, snapshotID string) *integrity.Expectation {
	t.Helper()
	e, err := integrity.Parse(json.RawMessage(fmt.Sprintf(`{"v":1,"mode":"unattested_override","snapshotId":%q,"authorizationId":"a1"}`, snapshotID)))
	if err != nil {
		t.Fatalf("parse expectation: %v", err)
	}
	return e
}

func TestFetchVMRestoreManifest(t *testing.T) {
	manifest := []byte(`{"id":"snap-vm-1","files":[{"sourcePath":"C:\\a.txt","backupPath":"k1","size":1}]}`)
	sameSizeOther := []byte(strings.Replace(string(manifest), `"k1"`, `"k9"`, 1))
	if len(sameSizeOther) != len(manifest) {
		t.Fatal("fixture: the differing manifest must be the same size")
	}
	cases := []struct {
		name           string
		expect         func(t *testing.T) *integrity.Expectation
		stored         []byte
		wantErr        string
		wantKey        string
		wantUnattested bool
	}{
		{name: "attested manifest matches", expect: func(t *testing.T) *integrity.Expectation { return attestedFor(t, manifest) }, stored: manifest, wantKey: "k1"},
		{name: "attested manifest bytes differ from attestation", expect: func(t *testing.T) *integrity.Expectation { return attestedFor(t, manifest) }, stored: sameSizeOther, wantErr: "differs from its attestation"},
		{name: "unattested override parses and warns", expect: func(t *testing.T) *integrity.Expectation { return overrideFor(t, vmSnapID) }, stored: sameSizeOther, wantKey: "k9", wantUnattested: true},
		{name: "expectation for another snapshot is refused", expect: func(t *testing.T) *integrity.Expectation { return overrideFor(t, "snap-other") }, stored: manifest, wantErr: "invalid integrity expectation"},
		{name: "no expectation downloads as before", expect: func(*testing.T) *integrity.Expectation { return nil }, stored: sameSizeOther, wantKey: "k9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := &fakeObjectStore{objects: map[string][]byte{vmManifestKey: tc.stored}}
			m, warnings, err := fetchVMRestoreManifest(context.Background(), vmSnapID, store, tc.expect(t))
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				if m != nil {
					t.Fatal("a manifest was returned for bytes that failed the check")
				}
				return
			}
			if err != nil {
				t.Fatalf("fetch: %v", err)
			}
			if len(m.Files) != 1 || m.Files[0].BackupPath != tc.wantKey {
				t.Fatalf("manifest = %+v", m)
			}
			n := 0
			for _, w := range warnings {
				if w == integrity.UnattestedRestoreWarning {
					n++
				}
			}
			if want := map[bool]int{true: 1, false: 0}[tc.wantUnattested]; n != want {
				t.Fatalf("unattested warning %d times, want %d (%q)", n, want, warnings)
			}
		})
	}
}

// destRecorder records the local path each object was downloaded to.
type destRecorder struct {
	*fakeObjectStore
	dests map[string]string
}

func (d *destRecorder) Download(key, local string) error {
	d.dests[key] = local
	return d.fakeObjectStore.Download(key, local)
}

func findStaging(t *testing.T, root string) []string {
	t.Helper()
	var found []string
	_ = filepath.WalkDir(root, func(p string, e os.DirEntry, err error) error {
		if err == nil && strings.HasPrefix(e.Name(), integrity.StagingPrefix) {
			found = append(found, p)
		}
		return nil
	})
	return found
}

func TestRestoreManifestFiles_Integrity(t *testing.T) {
	good := []byte("good bytes")
	other := []byte("othr bytes") // same size, different bytes
	attested := func(t *testing.T) *integrity.Expectation { return attestedFor(t, []byte("{}")) }
	override := func(t *testing.T) *integrity.Expectation { return overrideFor(t, vmSnapID) }
	entry := func(mut func(*vmRestoreManifFile)) vmRestoreManifFile {
		f := vssEntry(1, `C:\data\1.bin`, "k1", good)
		if mut != nil {
			mut(&f)
		}
		return f
	}
	cases := []struct {
		name         string
		expect       func(t *testing.T) *integrity.Expectation
		stored       []byte
		file         vmRestoreManifFile
		wantRestored bool
		wantWarning  string
		wantReason   string
	}{
		{name: "attested object matches", expect: attested, stored: good, file: entry(nil), wantRestored: true},
		{name: "attested same-size different bytes fail", expect: attested, stored: other, file: entry(nil), wantReason: "differs from its attestation"},
		{name: "attested volatile mismatch fails", expect: attested, stored: other, file: entry(func(f *vmRestoreManifFile) { f.Volatile = true }), wantReason: "differs from its attestation"},
		{name: "attested entry without checksum fails", expect: attested, stored: good, file: entry(func(f *vmRestoreManifFile) { f.Checksum = "" }), wantReason: "no checksum"},
		{name: "override volatile mismatch is a warning", expect: override, stored: other, file: entry(func(f *vmRestoreManifFile) { f.Volatile = true }), wantRestored: true, wantWarning: "volatile"},
		{name: "override checksum mismatch fails", expect: override, stored: other, file: entry(nil), wantReason: "checksum differs"},
		{name: "override entry without checksum is size checked", expect: override, stored: other, file: entry(func(f *vmRestoreManifFile) { f.Checksum = "" }), wantRestored: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			workDir := t.TempDir()
			store := &destRecorder{fakeObjectStore: &fakeObjectStore{objects: map[string][]byte{"k1": tc.stored}}, dests: map[string]string{}}
			tally := restoreManifestFiles(context.Background(), []vmRestoreManifFile{tc.file}, store, root, workDir, tc.expect(t))

			// Objects are staged in a private directory under the work
			// directory, never on the volume being restored, and placed
			// only after the check.
			target := filepath.Join(root, "data", "1.bin")
			if dest := store.dests["k1"]; !underRoot(workDir, dest) || !strings.HasPrefix(filepath.Base(filepath.Dir(dest)), integrity.StagingPrefix) {
				t.Fatalf("object downloaded to %q, want a staging file in a private directory under %q", dest, workDir)
			}
			if left := findStaging(t, root); len(left) != 0 {
				t.Fatalf("staging files left on the volume: %v", left)
			}
			if left, _ := os.ReadDir(workDir); len(left) != 0 {
				t.Fatalf("staging left in the work directory: %v", left)
			}
			if !tc.wantRestored {
				if tally.Failed != 1 || tally.Restored != 0 || tally.err() == nil {
					t.Fatalf("tally = %+v, want the file failed", tally)
				}
				if !strings.Contains(strings.Join(tally.Warnings, "\n"), tc.wantReason) {
					t.Fatalf("warnings = %q, want the reason %q", tally.Warnings, tc.wantReason)
				}
				if _, err := os.Stat(target); !os.IsNotExist(err) {
					t.Fatalf("the file is at its destination: %v", err)
				}
				return
			}
			if tally.Restored != 1 || tally.Failed != 0 {
				t.Fatalf("tally = %+v, want the file restored", tally)
			}
			got, err := os.ReadFile(target)
			if err != nil || string(got) != string(tc.stored) {
				t.Fatalf("destination = %q, %v", got, err)
			}
			if tc.wantWarning != "" && !strings.Contains(strings.Join(tally.Warnings, "\n"), tc.wantWarning) {
				t.Fatalf("warnings = %q, want %q", tally.Warnings, tc.wantWarning)
			}
		})
	}
}

// The instant-boot background sync places files with the same checks.
func TestRunBackgroundSync_Integrity(t *testing.T) {
	data := []byte("payload")
	other := []byte("paylod!")
	files := []vmRestoreManifFile{vssEntry(1, `C:\d\1.bin`, "k1", data), vssEntry(1, `C:\d\2.bin`, "k2", data)}
	e := attestedFor(t, []byte("{}"))

	t.Run("same-size different bytes degrade the sync", func(t *testing.T) {
		syncDir := filepath.Join(t.TempDir(), "sync-staging")
		store := &fakeObjectStore{objects: map[string][]byte{"k1": data, "k2": other}}
		result := &InstantBootResult{Status: "completed"}
		runBackgroundSync(context.Background(), result, syncDir, files, store, e)
		if result.Status != "degraded" || result.SyncProgress == nil || result.SyncProgress.Synced != 1 || result.SyncProgress.Failed != 1 {
			t.Fatalf("result = %+v progress %+v, want degraded with one failure", result, result.SyncProgress)
		}
		if !strings.Contains(strings.Join(result.Warnings, "\n"), "differs from its attestation") {
			t.Fatalf("warnings = %q", result.Warnings)
		}
	})
	t.Run("matching bytes complete the sync", func(t *testing.T) {
		syncDir := filepath.Join(t.TempDir(), "sync-staging")
		store := &fakeObjectStore{objects: map[string][]byte{"k1": data, "k2": data}}
		result := &InstantBootResult{Status: "completed"}
		runBackgroundSync(context.Background(), result, syncDir, files, store, e)
		if result.Status != "completed" || result.SyncProgress.Synced != 2 {
			t.Fatalf("result = %+v progress %+v", result, result.SyncProgress)
		}
		if left := findStaging(t, syncDir); len(left) != 0 {
			t.Fatalf("staging files left: %v", left)
		}
	})
}

func TestAppendBoundedWarnings(t *testing.T) {
	var base []string
	for i := 0; i < maxReportedFiles-1; i++ {
		base = append(base, "w")
	}
	got := appendBoundedWarnings(base, "a", "b", "c")
	if len(got) != maxReportedFiles || got[len(got)-1] != "a" {
		t.Fatalf("len %d last %q", len(got), got[len(got)-1])
	}
}
