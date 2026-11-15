package tools

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

const testVolumeGUIDRoot = `\\?\Volume{3f2504e0-4f89-11d3-9a0c-0305e82c3301}\`

// ownParentVolumeRoot is a volume root that is its own parent folder on this
// platform, as a volume GUID root always is on Windows.
func ownParentVolumeRoot(t *testing.T) string {
	t.Helper()
	root := string(filepath.Separator)
	if runtime.GOOS == "windows" {
		root = testVolumeGUIDRoot
	}
	if filepath.Dir(root) != root {
		t.Fatalf("fixture: %s is not its own parent folder here", root)
	}
	return root
}

// stubVolumeSources makes the protected files at the top folder top be
// files, with an empty per-volume cache before and after the test.
func stubVolumeSources(t *testing.T, top string, files ...string) {
	t.Helper()
	orig := volumeSourcesOf
	volumeSourcesOf = func(got string) ([]string, []string, []string) {
		if got == top {
			return files, nil, nil
		}
		return nil, nil, nil
	}
	resetVolumeIdentitiesCache()
	t.Cleanup(func() {
		volumeSourcesOf = orig
		resetVolumeIdentitiesCache()
	})
}

func resetVolumeIdentitiesCache() {
	volumeIdentitiesCache.Lock()
	volumeIdentitiesCache.sets, volumeIdentitiesCache.at = nil, nil
	volumeIdentitiesCache.Unlock()
}

func stubHandleVolumeRoot(t *testing.T, root string) {
	t.Helper()
	orig := handleVolumeRoot
	handleVolumeRoot = func(*os.File) string { return root }
	t.Cleanup(func() { handleVolumeRoot = orig })
}

func stubHandleVolumePath(t *testing.T, vol string) {
	t.Helper()
	orig := handleVolumePath
	handleVolumePath = func(*os.File) (string, bool) { return vol, vol != "" }
	t.Cleanup(func() { handleVolumePath = orig })
}

// The protected files at the root of the volume an open file is on are
// recorded for that volume, though a volume root is its own parent folder.
func TestVolumeIdentitiesOfHandleRecordVolumeRoots(t *testing.T) {
	secret := filepath.Join(t.TempDir(), "secrets.yaml")
	writeScanFixture(t, secret, "x")
	want, ok, err := identityOfPath(secret)
	if err != nil || !ok {
		t.Fatalf("identity of fixture: ok=%v err=%v", ok, err)
	}
	f, err := os.Open(secret)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()

	cases := []struct {
		name  string
		top   string
		setup func(t *testing.T)
	}{
		{"volume root of the handle", ownParentVolumeRoot(t), func(t *testing.T) { stubHandleVolumeRoot(t, ownParentVolumeRoot(t)) }},
		{"volume GUID path of the handle", testVolumeGUIDRoot, func(t *testing.T) { stubHandleVolumePath(t, testVolumeGUIDRoot+`docs\notes.txt`) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.setup(t)
			stubVolumeSources(t, tc.top, secret)
			set := volumeIdentitiesOfHandle(f, "")
			if !set.complete {
				t.Fatalf("set for %s is incomplete", tc.top)
			}
			if _, hit := set.ids[want]; !hit {
				t.Fatalf("set for %s has %d entries, want the protected file at that volume's root", tc.top, len(set.ids))
			}
		})
	}
}

// The file browser refuses another name of a protected file at the root of
// the volume it is on, when that volume is reached through its volume root.
func TestReadFileRefusesOtherNameAtVolumeRoot(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, "vol", "ProgramData", "Breeze", "secrets.yaml")
	writeScanFixture(t, secret, "x")
	link := filepath.Join(dir, "vol", "docs", "notes.txt")
	if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(secret, link); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	root := ownParentVolumeRoot(t)
	if runtime.GOOS == "windows" {
		stubHandleVolumePath(t, root+`docs\notes.txt`)
	} else {
		stubHandleVolumeRoot(t, root)
	}

	// Control: with no protected file recorded at that root, the link reads.
	stubVolumeSources(t, root)
	if result := ReadFile(map[string]any{"path": link}); result.Status == "failed" {
		t.Fatalf("control: status=%s (%s), want the read to pass", result.Status, result.Error)
	}

	stubVolumeSources(t, root, secret)
	if result := ReadFile(map[string]any{"path": link}); result.Status != "failed" {
		t.Fatalf("status=%s, want a refusal", result.Status)
	}
	if result := WriteFile(map[string]any{"path": link, "content": "y"}); result.Status != "failed" {
		t.Fatalf("write: status=%s, want a refusal", result.Status)
	}
	if got, err := os.ReadFile(secret); err != nil || string(got) != "x" {
		t.Fatalf("protected file after a refused write: %q, %v", got, err)
	}
}
