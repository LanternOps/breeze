package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// The journal-less source-gone abort publishes a PARTIAL manifest mid-loop.
// It must carry the run's junctions like the end-of-run publish does
// (finalizeManifest runs before both).
func TestCreateSnapshot_SourceGoneWithoutJournal_PartialManifestCarriesJunctions(t *testing.T) {
	defer setShortUploadRetryDelayForTest(0)()
	defer setUploadRetryDelayForTest(0)()

	f := newFakeStat()
	f.install(t)
	root, files := filesUnderCommonRoot(t, 5)
	f.set(root, true)

	backing := newMockProvider()
	provider := &snapshotKillingProvider{
		backing: backing,
		target:  files[2].sourcePath,
		srcRoot: root,
		onDeath: func() { f.set(root, false) },
	}
	junctions := []SnapshotJunction{{SourcePath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`, ModTime: time.Now().UTC()}}
	liveness := newShadowRootLiveness(map[string]string{`C:`: root})
	_, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, liveness, withJunctions(junctions))
	if !errors.Is(err, errSourceSnapshotGone) {
		t.Fatalf("want errSourceSnapshotGone, got %v", err)
	}

	backing.mu.Lock()
	var raw []byte
	for key, data := range backing.files {
		if strings.HasSuffix(key, "/"+snapshotManifestKey) {
			raw = data
		}
	}
	backing.mu.Unlock()
	if raw == nil {
		t.Fatal("no partial manifest was published")
	}
	var published Snapshot
	if err := json.Unmarshal(raw, &published); err != nil {
		t.Fatalf("decode published manifest: %v", err)
	}
	if len(published.Junctions) != 1 || published.Junctions[0].Target != `C:\Users\a\Music` {
		t.Fatalf("partial manifest junctions = %+v", published.Junctions)
	}
}

// Junctions are re-collected by every scan and never carried forward from the
// previous manifest: an incremental run that saw none publishes none, even
// though its base had one. Otherwise a junction deleted since the last backup
// would come back on restore.
func TestCreateSnapshot_IncrementalNeverInheritsJunctions(t *testing.T) {
	provider := newMockProvider()
	tmpDir := t.TempDir()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	const identity = "s3|bucket|device-a|file"

	f1 := createTempFile(t, tmpDir, "f1.txt", "one")
	if err := os.Chtimes(f1, modTime, modTime); err != nil {
		t.Fatal(err)
	}
	files := []backupFile{{sourcePath: f1, snapshotPath: "path_0/f1.txt", size: 3, modTime: modTime}}

	run1, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, nil, nil,
		withRunIdentity(identity),
		withJunctions([]SnapshotJunction{{SourcePath: `C:\Users\a\My Music`, Target: `C:\Users\a\Music`}}))
	if err != nil {
		t.Fatalf("run 1: %v", err)
	}
	if len(run1.Junctions) != 1 {
		t.Fatalf("run 1 junctions = %+v", run1.Junctions)
	}

	prev, reason := previousManifest(context.Background(), provider, identity)
	if prev == nil || prev.ID != run1.ID || len(prev.Junctions) != 1 {
		t.Fatalf("run 2 must see run 1 (with its junction) as its base: %+v (%s)", prev, reason)
	}
	run2, err := createSnapshotWithProgress(context.Background(), provider, files, nil, nil, prev, nil, withRunIdentity(identity))
	if err != nil {
		t.Fatalf("run 2: %v", err)
	}
	if run2.BaseSnapshotID != run1.ID {
		t.Fatalf("run 2 is not incremental against run 1: base %q", run2.BaseSnapshotID)
	}
	if len(run2.Junctions) != 0 {
		t.Fatalf("run 2 inherited junctions from its base: %+v", run2.Junctions)
	}
}
