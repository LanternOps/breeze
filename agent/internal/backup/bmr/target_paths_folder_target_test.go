package bmr

import (
	"context"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
)

// mustSymlink makes link point at target, failing (not skipping) so these
// tests never pass vacuously on a runner that cannot create links.
func mustSymlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink %s -> %s: %v", link, target, err)
	}
}

// A folder mapping's target must be a real directory: entries beneath it
// are created through it. The plan refuses a target that is a link before
// anything is written, naming the mapping — for a direct child of the
// target, for a deeper entry, and when the target is spelled with a
// trailing separator.
func TestPlanTargetPaths_RefusesFolderTargetThatIsALink(t *testing.T) {
	src := filepath.Join(t.TempDir(), "home") // never created
	outside := t.TempDir()
	link := filepath.Join(t.TempDir(), "restore")
	mustSymlink(t, outside, link)
	cases := []struct {
		name   string
		entry  string
		target string
	}{
		{"direct child", filepath.Join(src, "doc.txt"), link},
		{"deeper entry", filepath.Join(src, "alice", "doc.txt"), link},
		{"trailing separator", filepath.Join(src, "alice", "doc.txt"), link + string(filepath.Separator)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := planTargetPaths(contentManifest(tc.entry), map[string]string{src: tc.target})
			if err == nil {
				t.Fatal("plan accepted a folder target that is a link")
			}
			if !strings.Contains(err.Error(), src) || !strings.Contains(err.Error(), "not a directory") {
				t.Fatalf("err = %v, want it to name the mapping and say the target is not a directory", err)
			}
		})
	}
}

// End to end: the refusal comes before the system-state phase and nothing
// lands where the link points.
func TestRunRecoveryContext_RefusesFolderTargetThatIsALinkBeforeAnyWrite(t *testing.T) {
	src := filepath.ToSlash(filepath.Join(t.TempDir(), "data")) // never created
	fx := newRecoveryFixture(t, "snap-target-link", []fixtureFile{
		{source: src + "/a.txt", content: []byte("a")},
		{source: src + "/sub/b.txt", content: []byte("bb")},
	})
	outside := t.TempDir()
	link := filepath.Join(fx.targetRoot, "restored")
	mustSymlink(t, outside, link)
	cfg := fx.config(nil)
	cfg.TargetPaths = map[string]string{filepath.FromSlash(src): link}
	if strings.Contains(src, ":") {
		cfg.TargetPaths = map[string]string{src: link}
	}
	restorerBuilt := false
	orig := newRestorerFunc
	newRestorerFunc = func() Restorer { restorerBuilt = true; return &fakeStateRestorer{} }
	t.Cleanup(func() { newRestorerFunc = orig })
	fx.putObject(t, path.Join("snapshots", fx.snapshotID, "system-state", "manifest.json"), []byte(`{"schemaVersion":1,"platform":"linux","artifacts":[]}`))

	result, err := RunRecoveryContext(context.Background(), cfg, fx.provider)
	if err == nil || result == nil || result.Status != "failed" || result.FilesRestored != 0 {
		t.Fatalf("result=%+v err=%v, want a failed run with nothing restored", result, err)
	}
	if restorerBuilt {
		t.Fatal("the system-state phase ran before the refusal")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("something was written through the target: %v", entries)
	}
}

// The file phase re-checks the target before each write, so a link that
// replaces the target after the plan was made is refused too, with an error
// naming the mapping.
func TestRestoreFiles_RefusesFolderTargetReplacedByLinkAfterPlanning(t *testing.T) {
	for _, entryRel := range []string{"doc.txt", filepath.Join("alice", "doc.txt")} {
		t.Run(entryRel, func(t *testing.T) {
			src := filepath.Join(t.TempDir(), "home")
			parent, outside := t.TempDir(), t.TempDir()
			dst := filepath.Join(parent, "restore")
			if err := os.Mkdir(dst, 0o755); err != nil {
				t.Fatal(err)
			}
			manifest := contentManifest(filepath.Join(src, entryRel))
			cfg := RecoveryConfig{TargetPaths: map[string]string{src: dst}}
			plan, err := planTargetPaths(manifest, cfg.TargetPaths)
			if err != nil {
				t.Fatalf("plan: %v", err)
			}
			if err := os.Remove(dst); err != nil {
				t.Fatal(err)
			}
			mustSymlink(t, outside, dst)

			provider := &destRecorder{}
			_, _, warnings, failed, _ := restoreFiles(context.Background(), manifest, plan, cfg, provider)
			if failed != 1 || len(provider.dests) != 0 {
				t.Fatalf("failed=%d dests=%v warnings=%v, want the write refused", failed, provider.dests, warnings)
			}
			joined := strings.Join(warnings, "\n")
			if !strings.Contains(joined, src) || !strings.Contains(joined, "not a directory") {
				t.Fatalf("warnings = %v, want one naming the mapping", warnings)
			}
			if entries, _ := os.ReadDir(outside); len(entries) != 0 {
				t.Fatalf("something was written through the target: %v", entries)
			}
		})
	}
}

// The mapping source's own directory entry is restored AT the target that
// the rest of the mapping is written beneath; its mode bits must not be
// applied through a link sitting there.
func TestRestoreFiles_FolderSourceDirectoryEntryNotAppliedThroughLinkAtTarget(t *testing.T) {
	src := filepath.Join(t.TempDir(), "home")
	parent, outside := t.TempDir(), t.TempDir()
	dst := filepath.Join(parent, "restore")
	if err := os.Mkdir(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := contentManifest(filepath.Join(src, "doc.txt"))
	manifest.Files = append([]manifestFile{{SourcePath: src, Kind: "dir", ModeBits: 0o700}}, manifest.Files...)
	cfg := RecoveryConfig{TargetPaths: map[string]string{src: dst}}
	plan, err := planTargetPaths(manifest, cfg.TargetPaths)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := os.Remove(dst); err != nil {
		t.Fatal(err)
	}
	mustSymlink(t, outside, dst)

	var chmodded []string
	origChmod := chmodFile
	chmodFile = func(p string, _ os.FileMode) error { chmodded = append(chmodded, p); return nil }
	t.Cleanup(func() { chmodFile = origChmod })

	provider := &destRecorder{}
	_, _, warnings, failed, _ := restoreFiles(context.Background(), manifest, plan, cfg, provider)
	if failed != 2 || len(chmodded) != 0 || len(provider.dests) != 0 {
		t.Fatalf("failed=%d chmod=%v dests=%v warnings=%v, want both entries refused", failed, chmodded, provider.dests, warnings)
	}
}

// A symlink entry the snapshot restores in place exactly at a folder
// mapping's target would turn the target into a link; the plan refuses it.
func TestPlanTargetPaths_RefusesFolderTargetWhereSnapshotRestoresALink(t *testing.T) {
	src := filepath.Join(t.TempDir(), "home")
	dst := filepath.Join(t.TempDir(), "restore") // not created yet
	manifest := contentManifest(filepath.Join(src, "doc.txt"))
	manifest.Files = append(manifest.Files, manifestFile{SourcePath: dst, Kind: "symlink", LinkTarget: t.TempDir()})
	_, err := planTargetPaths(manifest, map[string]string{src: dst})
	if err == nil || !strings.Contains(err.Error(), src) || !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("err = %v, want the mapping refused because its target is a link this snapshot restores", err)
	}
}

// Only the target itself is checked, not the directories above it: an
// operator-chosen target under a system-level link (macOS /var, a Linux
// /home link) is legitimate, the same trust the exact-mapping guard gives
// the root it derives.
func TestRestoreFiles_FolderTargetUnderLinkedParentIsAllowed(t *testing.T) {
	src := filepath.Join(t.TempDir(), "home")
	real := t.TempDir()
	linkedParent := filepath.Join(t.TempDir(), "linked")
	mustSymlink(t, real, linkedParent)
	dst := filepath.Join(linkedParent, "restore")
	if err := os.Mkdir(dst, 0o755); err != nil {
		t.Fatal(err)
	}
	provider := &destRecorder{}
	cfg := RecoveryConfig{TargetPaths: map[string]string{src: dst}}
	_, _, warnings, failed, err := restoreFilesPlanned(context.Background(), contentManifest(filepath.Join(src, "a", "doc.txt")), cfg, provider)
	if err != nil || failed != 0 {
		t.Fatalf("err=%v failed=%d warnings=%v, want the entry restored", err, failed, warnings)
	}
	if want := filepath.Join(dst, "a", "doc.txt"); len(provider.dests) != 1 || provider.dests[0] != want {
		t.Fatalf("dests = %v, want %q", provider.dests, want)
	}
}

// A target that does not exist yet is created by the restore as a real
// directory and is fine.
func TestPlanTargetPaths_AcceptsMissingFolderTarget(t *testing.T) {
	src := filepath.Join(t.TempDir(), "home")
	dst := filepath.Join(t.TempDir(), "new", "restore")
	if _, err := planTargetPaths(contentManifest(filepath.Join(src, "doc.txt")), map[string]string{src: dst}); err != nil {
		t.Fatalf("plan: %v", err)
	}
}
