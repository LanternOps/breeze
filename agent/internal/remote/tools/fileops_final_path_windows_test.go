//go:build windows

package tools

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// These tests exercise the agent-directory guard against the other names
// Windows accepts for the same directory: junctions, directory symlinks, 8.3
// short names, trailing dots and spaces, stream syntax and the built-in
// compatibility junctions. Each one injects a temporary directory as the
// agent's config directory; the real install directory is never touched.

const protectedSecret = "agent-secret-material"

type protectedFixture struct {
	base      string // scratch directory, outside the protected root
	protected string // the injected agent config directory (long form)
}

func newProtectedFixture(t *testing.T) protectedFixture {
	t.Helper()
	base := longPathForTest(t, t.TempDir())
	protected := filepath.Join(base, "ProtectedAgentRoot")
	if err := os.MkdirAll(protected, 0o755); err != nil {
		t.Fatalf("mkdir protected: %v", err)
	}
	if err := os.WriteFile(filepath.Join(protected, "secret.txt"), []byte(protectedSecret), 0o644); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	injectAgentConfigDir(t, protected)
	return protectedFixture{base: base, protected: protected}
}

func injectAgentConfigDir(t *testing.T, dir string) {
	t.Helper()
	orig := agentConfigDirFunc
	agentConfigDirFunc = func() string { return dir }
	t.Cleanup(func() { agentConfigDirFunc = orig })

	origTrash := getTrashDirFunc
	trash := filepath.Join(t.TempDir(), "trash")
	getTrashDirFunc = func() (string, error) { return trash, os.MkdirAll(trash, 0o700) }
	t.Cleanup(func() { getTrashDirFunc = origTrash })
}

func longPathForTest(t *testing.T, p string) string {
	t.Helper()
	in, err := windows.UTF16PtrFromString(p)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetLongPathName(in, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 {
		t.Fatalf("GetLongPathName(%q): %v", p, err)
	}
	return windows.UTF16ToString(buf[:n])
}

func shortPathForTest(t *testing.T, p string) string {
	t.Helper()
	in, err := windows.UTF16PtrFromString(p)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetShortPathName(in, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 {
		t.Fatalf("GetShortPathName(%q): %v", p, err)
	}
	return windows.UTF16ToString(buf[:n])
}

func mklinkForTest(t *testing.T, flag, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", flag, link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink %s %s %s: %v (%s)", flag, link, target, err, out)
	}
	// Remove the link itself (never its target) even if a test fails midway.
	t.Cleanup(func() { _ = os.Remove(link) })
}

// assertProtectedDirUnreachable runs every file operation against dir, which
// names the protected root by some other spelling, and requires each to be
// refused without touching the protected content.
func assertProtectedDirUnreachable(t *testing.T, fx protectedFixture, dir string) {
	t.Helper()
	secretVia := filepath.Join(dir, "secret.txt")
	secretReal := filepath.Join(fx.protected, "secret.txt")

	requireDenied := func(op string, res CommandResult) {
		t.Helper()
		if res.Status != "failed" || !strings.Contains(res.Error, "denied") {
			t.Errorf("%s via %q: expected a denial, got status=%q error=%q", op, dir, res.Status, res.Error)
		}
	}
	requireSecretIntact := func(op string) {
		t.Helper()
		got, err := os.ReadFile(secretReal)
		if err != nil || string(got) != protectedSecret {
			t.Fatalf("%s via %q changed the protected file: %q, %v", op, dir, got, err)
		}
	}

	requireDenied("ReadFile", ReadFile(map[string]any{"path": secretVia}))
	requireDenied("ListFiles", ListFiles(map[string]any{"path": dir}))

	requireDenied("WriteFile(new)", WriteFile(map[string]any{"path": filepath.Join(dir, "planted.txt"), "content": "x"}))
	if _, err := os.Stat(filepath.Join(fx.protected, "planted.txt")); err == nil {
		t.Errorf("WriteFile via %q created a file in the protected root", dir)
	}
	requireDenied("WriteFile(overwrite)", WriteFile(map[string]any{"path": secretVia, "content": "x"}))
	requireSecretIntact("WriteFile(overwrite)")

	copyDst := filepath.Join(fx.base, "copied.txt")
	requireDenied("CopyFile", CopyFile(map[string]any{"sourcePath": secretVia, "destPath": copyDst}))
	if _, err := os.Stat(copyDst); err == nil {
		t.Errorf("CopyFile via %q produced a copy of the protected file", dir)
		_ = os.Remove(copyDst)
	}

	renameDst := filepath.Join(fx.base, "renamed.txt")
	requireDenied("RenameFile", RenameFile(map[string]any{"oldPath": secretVia, "newPath": renameDst}))
	requireSecretIntact("RenameFile")

	requireDenied("DeleteFile(trash)", DeleteFile(map[string]any{"path": secretVia}))
	requireSecretIntact("DeleteFile(trash)")
	requireDenied("DeleteFile(permanent)", DeleteFile(map[string]any{"path": secretVia, "permanent": true}))
	requireSecretIntact("DeleteFile(permanent)")
}

func TestAgentDirGuardFollowsJunctionToProtectedRoot(t *testing.T) {
	fx := newProtectedFixture(t)
	link := filepath.Join(fx.base, "innocuous-junction")
	mklinkForTest(t, "/J", link, fx.protected)
	assertProtectedDirUnreachable(t, fx, link)
}

func TestAgentDirGuardFollowsJunctionToProtectedParent(t *testing.T) {
	fx := newProtectedFixture(t)
	link := filepath.Join(fx.base, "parent-junction")
	mklinkForTest(t, "/J", link, fx.base)
	assertProtectedDirUnreachable(t, fx, filepath.Join(link, filepath.Base(fx.protected)))
}

func TestAgentDirGuardFollowsDirectorySymlinkToProtectedRoot(t *testing.T) {
	fx := newProtectedFixture(t)
	link := filepath.Join(fx.base, "innocuous-symlink")
	mklinkForTest(t, "/D", link, fx.protected)
	assertProtectedDirUnreachable(t, fx, link)
}

func TestAgentDirGuardResolvesShortName(t *testing.T) {
	fx := newProtectedFixture(t)
	short := shortPathForTest(t, fx.protected)
	if strings.EqualFold(filepath.Base(short), filepath.Base(fx.protected)) {
		// 8.3 generation is off for this volume; assign one explicitly.
		out, err := exec.Command("fsutil", "file", "setshortname", fx.protected, "PROTEC~9").CombinedOutput()
		if err != nil {
			t.Skipf("no 8.3 name available on this volume: %v (%s)", err, out)
		}
		short = shortPathForTest(t, fx.protected)
	}
	if strings.EqualFold(filepath.Base(short), filepath.Base(fx.protected)) {
		t.Skip("no 8.3 name available on this volume")
	}
	t.Logf("protected root %q has short form %q", fx.protected, short)
	assertProtectedDirUnreachable(t, fx, short)
}

func TestAgentDirGuardStripsTrailingDotsAndSpaces(t *testing.T) {
	fx := newProtectedFixture(t)
	for _, alias := range []string{fx.protected + ".", fx.protected + " ", fx.protected + ". ."} {
		t.Run(strings.ReplaceAll(alias[len(fx.protected):], " ", "_"), func(t *testing.T) {
			assertProtectedDirUnreachable(t, fx, alias)
		})
	}
}

func TestAgentDirGuardStripsDirectoryStreamSuffix(t *testing.T) {
	fx := newProtectedFixture(t)
	alias := fx.protected + "::$INDEX_ALLOCATION"
	res := ListFiles(map[string]any{"path": alias})
	if res.Status != "failed" || !strings.Contains(res.Error, "denied") {
		t.Fatalf("ListFiles(%q): expected a denial, got status=%q error=%q", alias, res.Status, res.Error)
	}
	moved := filepath.Join(fx.base, "moved")
	res = RenameFile(map[string]any{"oldPath": alias, "newPath": moved})
	if res.Status != "failed" || !strings.Contains(res.Error, "denied") {
		t.Fatalf("RenameFile(%q): expected a denial, got status=%q error=%q", alias, res.Status, res.Error)
	}
	if _, err := os.Stat(filepath.Join(fx.protected, "secret.txt")); err != nil {
		t.Fatalf("protected root was moved: %v", err)
	}
}

// The compatibility junctions every Windows install ships with. The fixture
// lives under the real ProgramData (not the agent's own directory) so the
// built-in links reach it.
func TestAgentDirGuardFollowsBuiltInCompatibilityLinks(t *testing.T) {
	programData := os.Getenv("ProgramData")
	if programData == "" {
		t.Skip("ProgramData is not set")
	}
	var suffix [6]byte
	_, _ = rand.Read(suffix[:])
	protected := filepath.Join(programData, "agent-dir-guard-test-"+hex.EncodeToString(suffix[:]))
	if err := os.MkdirAll(protected, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(protected) })
	if err := os.WriteFile(filepath.Join(protected, "secret.txt"), []byte(protectedSecret), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	injectAgentConfigDir(t, protected)
	fx := protectedFixture{base: t.TempDir(), protected: protected}

	volume := filepath.VolumeName(programData)
	name := filepath.Base(protected)
	aliases := []string{
		filepath.Join(programData, "Application Data", name),
		filepath.Join(volume+`\`, "Documents and Settings", "All Users", name),
		filepath.Join(volume+`\`, "Users", "All Users", name),
	}
	for _, alias := range aliases {
		if _, err := os.Stat(alias); err != nil {
			t.Logf("skipping %q: not present on this host (%v)", alias, err)
			continue
		}
		t.Run(alias, func(t *testing.T) { assertProtectedDirUnreachable(t, fx, alias) })
	}
}

// String-level spellings of the default install directory: these do not need
// to exist, and must be refused before anything is opened.
func TestIsSensitiveReadPathWindowsAliasSpellings(t *testing.T) {
	orig := agentConfigDirFunc
	agentConfigDirFunc = func() string { return "" }
	t.Cleanup(func() { agentConfigDirFunc = orig })

	sensitive := []string{
		`C:\Documents and Settings\All Users\Breeze\secrets.yaml`,
		`C:\Users\All Users\Breeze\agent.yaml`,
		`C:\ProgramData\Application Data\Breeze\secrets.yaml`,
		`C:\ProgramData.\Breeze\secrets.yaml`,
		`C:\ProgramData\Breeze.\secrets.yaml`,
		`C:\ProgramData\Breeze. .\secrets.yaml`,
		`C:\ProgramData\Breeze::$INDEX_ALLOCATION`,
		`C:\ProgramData\Breeze:stream`,
		`\\?\C:\ProgramData\Breeze\secrets.yaml`,
		`\\localhost\C$\ProgramData\Breeze\secrets.yaml`,
		`C:\Windows\System32\config\SAM.`,
		`C:\Windows\Sysnative\config\SAM`,
	}
	for _, p := range sensitive {
		if !isSensitiveReadPath(p) {
			t.Errorf("isSensitiveReadPath(%q) = false, want true", p)
		}
	}
	ordinary := []string{
		`C:\ProgramData\BreezeTools\readme.txt`,
		`C:\Users\alice\Documents\Breeze\notes.txt`,
		`D:\Data\Application Data\report.txt`,
	}
	for _, p := range ordinary {
		if isSensitiveReadPath(p) {
			t.Errorf("isSensitiveReadPath(%q) = true, want false", p)
		}
	}
}

// Positive control: the guard must not get in the way of ordinary work done
// through a junction to an unprotected directory.
func TestFileOpsThroughJunctionToOrdinaryDirStillWork(t *testing.T) {
	fx := newProtectedFixture(t)
	ordinary := filepath.Join(fx.base, "ordinary")
	if err := os.MkdirAll(filepath.Join(ordinary, "sub", "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(fx.base, "ordinary-junction")
	mklinkForTest(t, "/J", link, ordinary)

	mustOK := func(op string, res CommandResult) {
		t.Helper()
		if res.Status != "completed" {
			t.Fatalf("%s: expected success, got %q", op, res.Error)
		}
	}
	mustOK("WriteFile", WriteFile(map[string]any{"path": filepath.Join(link, "a.txt"), "content": "hello"}))
	mustOK("WriteFile(overwrite)", WriteFile(map[string]any{"path": filepath.Join(link, "a.txt"), "content": "hi"}))
	if got, _ := os.ReadFile(filepath.Join(ordinary, "a.txt")); string(got) != "hi" {
		t.Fatalf("overwrite left %q, want %q", got, "hi")
	}
	res := ReadFile(map[string]any{"path": filepath.Join(link, "a.txt")})
	mustOK("ReadFile", res)
	mustOK("ListFiles", ListFiles(map[string]any{"path": link}))
	mustOK("CopyFile", CopyFile(map[string]any{"sourcePath": filepath.Join(link, "a.txt"), "destPath": filepath.Join(link, "b.txt")}))
	mustOK("RenameFile", RenameFile(map[string]any{"oldPath": filepath.Join(link, "b.txt"), "newPath": filepath.Join(fx.base, "c.txt")}))
	if _, err := os.Stat(filepath.Join(fx.base, "c.txt")); err != nil {
		t.Fatalf("rename did not land: %v", err)
	}

	// Read-only file deleted permanently, as os.Remove used to manage.
	ro := filepath.Join(link, "ro.txt")
	mustOK("WriteFile(ro)", WriteFile(map[string]any{"path": ro, "content": "ro"}))
	if err := os.Chmod(ro, 0o444); err != nil {
		t.Fatal(err)
	}
	mustOK("DeleteFile(permanent ro)", DeleteFile(map[string]any{"path": ro, "permanent": true}))
	if _, err := os.Lstat(filepath.Join(ordinary, "ro.txt")); !os.IsNotExist(err) {
		t.Fatalf("read-only file survived permanent delete: %v", err)
	}

	// Recursive permanent delete of a tree that holds a junction to content
	// outside it: the junction goes, the content it points at stays.
	outside := filepath.Join(fx.base, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "keep.txt"), []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ordinary, "sub", "deeper", "f.txt"), []byte("f"), 0o444); err != nil {
		t.Fatal(err)
	}
	mklinkForTest(t, "/J", filepath.Join(ordinary, "sub", "out-link"), outside)
	mustOK("DeleteFile(recursive)", DeleteFile(map[string]any{"path": filepath.Join(link, "sub"), "permanent": true, "recursive": true}))
	if _, err := os.Lstat(filepath.Join(ordinary, "sub")); !os.IsNotExist(err) {
		t.Fatalf("directory survived recursive delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "keep.txt")); err != nil {
		t.Fatalf("recursive delete followed a junction out of the tree: %v", err)
	}

	// Trash round trip through the junction.
	mustOK("WriteFile(t)", WriteFile(map[string]any{"path": filepath.Join(link, "t.txt"), "content": "t"}))
	del := DeleteFile(map[string]any{"path": filepath.Join(link, "t.txt")})
	mustOK("DeleteFile(trash)", del)
	if _, err := os.Lstat(filepath.Join(ordinary, "t.txt")); !os.IsNotExist(err) {
		t.Fatalf("trashed file still in place: %v", err)
	}
	trashID, _ := resultField(t, del, "trashId").(string)
	mustOK("TrashRestore", TrashRestore(map[string]any{"trashId": trashID}))
	if got, _ := os.ReadFile(filepath.Join(ordinary, "t.txt")); string(got) != "t" {
		t.Fatalf("restore left %q", got)
	}
}

func resultField(t *testing.T, res CommandResult, key string) any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &body); err != nil {
		t.Fatalf("decode result: %v (%q)", err, res.Stdout)
	}
	return body[key]
}

// A junction re-pointed between the path check and the open must not carry
// the operation into the protected root: the decision is taken on the handle
// the operation then uses.
func TestAgentDirGuardHoldsWhenJunctionIsRepointedAfterPathCheck(t *testing.T) {
	fx := newProtectedFixture(t)
	benign := filepath.Join(fx.base, "benign")
	if err := os.MkdirAll(benign, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(benign, "secret.txt"), []byte("benign"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(fx.base, "flip")
	mklinkForTest(t, "/J", link, benign)
	t.Cleanup(func() { testHookAfterPathCheck = nil })

	pointAt := func(target string) {
		_ = os.Remove(link)
		if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
			t.Fatalf("point junction at %s: %v (%s)", target, err, out)
		}
	}
	repointAfterCheck := func() {
		testHookAfterPathCheck = func(string) {
			testHookAfterPathCheck = nil
			pointAt(fx.protected)
		}
	}

	secretVia := filepath.Join(link, "secret.txt")
	ops := []struct {
		name string
		run  func() CommandResult
	}{
		{"ReadFile", func() CommandResult { return ReadFile(map[string]any{"path": secretVia}) }},
		{"ListFiles", func() CommandResult { return ListFiles(map[string]any{"path": link}) }},
		{"WriteFile", func() CommandResult { return WriteFile(map[string]any{"path": secretVia, "content": "x"}) }},
		{"CopyFile", func() CommandResult {
			return CopyFile(map[string]any{"sourcePath": secretVia, "destPath": filepath.Join(fx.base, "copy.txt")})
		}},
		{"RenameFile", func() CommandResult {
			return RenameFile(map[string]any{"oldPath": secretVia, "newPath": filepath.Join(fx.base, "moved.txt")})
		}},
		{"DeleteFile(permanent)", func() CommandResult {
			return DeleteFile(map[string]any{"path": secretVia, "permanent": true})
		}},
		{"DeleteFile(trash)", func() CommandResult { return DeleteFile(map[string]any{"path": secretVia}) }},
	}
	for _, op := range ops {
		pointAt(benign)
		repointAfterCheck()
		res := op.run()
		if testHookAfterPathCheck != nil {
			t.Fatalf("%s never reached the post-check hook", op.name)
		}
		if res.Status != "failed" || !strings.Contains(res.Error, "denied") {
			t.Errorf("%s: expected a denial after the junction was re-pointed, got status=%q error=%q stdout=%.80q",
				op.name, res.Status, res.Error, res.Stdout)
		}
		got, err := os.ReadFile(filepath.Join(fx.protected, "secret.txt"))
		if err != nil || string(got) != protectedSecret {
			t.Fatalf("%s changed the protected file: %q, %v", op.name, got, err)
		}
	}
	pointAt(benign)
}

// A restore never writes through whatever now occupies the original path: a
// dangling link there must not redirect the restored content, and an
// existing file must not be replaced.
func TestTrashRestoreRefusesOccupiedDestination(t *testing.T) {
	fx := newProtectedFixture(t)
	work := filepath.Join(fx.base, "work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(work, "doc.txt")
	trashOne := func() string {
		t.Helper()
		if err := os.WriteFile(original, []byte("trashed"), 0o644); err != nil {
			t.Fatal(err)
		}
		del := DeleteFile(map[string]any{"path": original})
		if del.Status != "completed" {
			t.Fatalf("trash: %q", del.Error)
		}
		id, _ := resultField(t, del, "trashId").(string)
		return id
	}

	// Dangling file symlink at the original path.
	id := trashOne()
	redirected := filepath.Join(fx.base, "redirected.txt")
	if err := os.Symlink(redirected, original); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	res := TrashRestore(map[string]any{"trashId": id})
	if res.Status != "failed" {
		t.Errorf("restore onto a dangling link: expected a refusal, got %q", res.Stdout)
	}
	if _, err := os.Lstat(redirected); err == nil {
		t.Errorf("restore wrote through the dangling link to %s", redirected)
	}
	if fi, err := os.Lstat(original); err != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Errorf("the link at the original path was replaced: %v", err)
	}
	_ = os.Remove(original)

	// Existing file at the original path.
	id = trashOne()
	if err := os.WriteFile(original, []byte("occupant"), 0o644); err != nil {
		t.Fatal(err)
	}
	res = TrashRestore(map[string]any{"trashId": id})
	if res.Status != "failed" {
		t.Errorf("restore onto an existing file: expected a refusal, got %q", res.Stdout)
	}
	if got, _ := os.ReadFile(original); string(got) != "occupant" {
		t.Errorf("restore replaced the existing file: %q", got)
	}
}

// A volume mounted into a folder (no drive letter) must stay usable. Set
// BREEZE_TEST_FOLDER_MOUNT to a directory that is the mount point of another
// volume to run this; it is skipped otherwise.
func TestFileOpsOnFolderMountedVolume(t *testing.T) {
	mount := os.Getenv("BREEZE_TEST_FOLDER_MOUNT")
	if mount == "" {
		t.Skip("BREEZE_TEST_FOLDER_MOUNT not set")
	}
	newProtectedFixture(t)
	f, err := os.Open(mount)
	if err != nil {
		t.Fatal(err)
	}
	dos, dosErr := finalPathOfFile(f)
	_ = f.Close()
	t.Logf("VOLUME_NAME_DOS final path of the mount: %q, err=%v", dos, dosErr)

	p := filepath.Join(mount, "folder-mount-probe.txt")
	t.Cleanup(func() { _ = os.Remove(p) })
	for _, step := range []struct {
		name string
		res  CommandResult
	}{
		{"WriteFile", WriteFile(map[string]any{"path": p, "content": "probe"})},
		{"ReadFile", ReadFile(map[string]any{"path": p})},
		{"ListFiles", ListFiles(map[string]any{"path": mount})},
		{"DeleteFile", DeleteFile(map[string]any{"path": p, "permanent": true})},
	} {
		if step.res.Status != "completed" {
			t.Errorf("%s on folder-mounted volume: %q", step.name, step.res.Error)
		}
	}
}
