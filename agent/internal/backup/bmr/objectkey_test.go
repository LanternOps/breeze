package bmr

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// realManifestShape mirrors the fields these tests need from
// testdata/real-manifest-shape.json — a REAL agent manifest shape (KIT lab,
// PR #6491) shared byte-for-byte with the API side
// (apps/api/src/services/backupSnapshotFileIndex.test.ts) and the fake
// server (fakeserver_test.go).
type realManifestShape struct {
	ID             string `json:"id"`
	BaseSnapshotID string `json:"baseSnapshotId"`
	Files          []struct {
		SourcePath string `json:"sourcePath"`
		BackupPath string `json:"backupPath"`
		Kind       string `json:"kind"`
	} `json:"files"`
}

func loadRealManifestShape(t *testing.T) realManifestShape {
	t.Helper()
	data, err := os.ReadFile("testdata/real-manifest-shape.json")
	if err != nil {
		t.Fatalf("read real-manifest fixture: %v", err)
	}
	var m realManifestShape
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("unmarshal real-manifest fixture: %v", err)
	}
	return m
}

// TestParseObjectKey_RealManifestShape is the D-W09-1/D-W09-2 regression on
// the agent side: every content entry of a real Linux manifest — systemd's
// backslash unit names and dpkg's colon names included — must parse, and
// ExternalObjectKeys must classify the base-snapshot keys as external with
// NO bad keys (a single bad key is a hard refusal of the whole recovery in
// ApplyManifestScope, which is exactly how the KIT rig failed closed).
func TestParseObjectKey_RealManifestShape(t *testing.T) {
	m := loadRealManifestShape(t)

	var contentless, backslash, colon int
	var paths []string
	for _, f := range m.Files {
		if f.BackupPath == "" {
			if f.Kind != "dir" && f.Kind != "symlink" {
				t.Fatalf("fixture entry %q has empty backupPath but kind %q — only dir/symlink may be content-less", f.SourcePath, f.Kind)
			}
			contentless++
			paths = append(paths, f.BackupPath)
			continue
		}
		if strings.Contains(f.BackupPath, `\x2d`) {
			backslash++
		}
		if strings.Contains(f.BackupPath, ":") {
			colon++
		}
		parsed, ok := ParseObjectKey(f.BackupPath)
		if !ok {
			t.Fatalf("real manifest key %q must parse", f.BackupPath)
		}
		if parsed.SnapshotID != m.ID && parsed.SnapshotID != m.BaseSnapshotID {
			t.Fatalf("key %q parsed to snapshot %q, want %q or %q", f.BackupPath, parsed.SnapshotID, m.ID, m.BaseSnapshotID)
		}
		paths = append(paths, f.BackupPath)
	}
	// The fixture must actually carry the traits that broke the KIT run.
	if contentless == 0 || backslash == 0 || colon == 0 {
		t.Fatalf("fixture lost a trait: contentless=%d backslash=%d colon=%d, all must be > 0", contentless, backslash, colon)
	}

	external, bad := ExternalObjectKeys(paths, m.ID)
	if len(bad) != 0 {
		t.Fatalf("ExternalObjectKeys reported bad keys on a real manifest: %v", bad)
	}
	if len(external) != 4 {
		t.Fatalf("external keys = %d (%v), want the fixture's 4 base-snapshot content entries", len(external), external)
	}
	for _, k := range external {
		if !strings.HasPrefix(k, "snapshots/"+m.BaseSnapshotID+"/") {
			t.Fatalf("external key %q is not under the base snapshot %q", k, m.BaseSnapshotID)
		}
	}
}

type objectKeyVector struct {
	Key        string `json:"key"`
	Valid      bool   `json:"valid"`
	SnapshotID string `json:"snapshotId,omitempty"`
	Rest       string `json:"rest,omitempty"`
}

func loadObjectKeyVectors(t *testing.T) []objectKeyVector {
	t.Helper()
	data, err := os.ReadFile("testdata/object-key-vectors.json")
	if err != nil {
		t.Fatalf("read vectors file: %v", err)
	}
	var vectors []objectKeyVector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("unmarshal vectors file: %v", err)
	}
	if len(vectors) < 20 {
		t.Fatalf("vectors file must pin at least 20 cases per Part 0 §1, got %d", len(vectors))
	}
	return vectors
}

func TestParseObjectKey_MatchesSharedVectors(t *testing.T) {
	for _, v := range loadObjectKeyVectors(t) {
		v := v
		t.Run(v.Key, func(t *testing.T) {
			parsed, ok := ParseObjectKey(v.Key)
			if ok != v.Valid {
				t.Fatalf("key %q: ok = %v, want %v", v.Key, ok, v.Valid)
			}
			if v.Valid {
				if parsed.SnapshotID != v.SnapshotID {
					t.Fatalf("key %q: snapshotID = %q, want %q", v.Key, parsed.SnapshotID, v.SnapshotID)
				}
				if parsed.Rest != v.Rest {
					t.Fatalf("key %q: rest = %q, want %q", v.Key, parsed.Rest, v.Rest)
				}
			}
		})
	}
}

func TestIsExternalObjectKey_ClassifiesOwnVsExternal(t *testing.T) {
	external, origin, ok := IsExternalObjectKey("snapshots/gen-1/files/a.gz", "gen-2")
	if !ok || !external || origin != "gen-1" {
		t.Fatalf("external, origin, ok = %v, %q, %v; want true, gen-1, true", external, origin, ok)
	}

	external, origin, ok = IsExternalObjectKey("snapshots/gen-2/files/a.gz", "gen-2")
	if !ok || external || origin != "gen-2" {
		t.Fatalf("external, origin, ok = %v, %q, %v; want false, gen-2, true", external, origin, ok)
	}

	_, _, ok = IsExternalObjectKey("snapshots/gen-2/", "gen-2")
	if ok {
		t.Fatal("an invalid key must never be classified as own")
	}
}
