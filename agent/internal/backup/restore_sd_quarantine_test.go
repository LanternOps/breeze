package backup

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

const (
	testLocalSID   = "S-1-5-21-1-2-3-1001"
	testForeignSID = "S-1-5-21-9-9-9-1001"
)

// fakeSDPlatform drives the restore's descriptor decision with descriptors
// named by their content ("known", "foreign-owner", …) instead of real
// bytes, and records every apply by tag: "captured:<sd>", "nosacl:<sd>",
// "quarantine".
type fakeSDPlatform struct {
	applies         map[string]int // tag -> number of applies
	domainCalls     int
	quarantineFails bool
}

func installFakeSDPlatform(t *testing.T, f *fakeSDPlatform, domainNotes []string) {
	t.Helper()
	origPlatform, origApplier, origEnabled := restoreSDPlatform, restoreSecurityApplier, restoreAppliesSecurityDescriptors
	t.Cleanup(func() {
		restoreSDPlatform, restoreSecurityApplier, restoreAppliesSecurityDescriptors = origPlatform, origApplier, origEnabled
	})
	restoreAppliesSecurityDescriptors = true
	tagged := func(tag string) *securefs.SecurityApplier {
		return &securefs.SecurityApplier{Apply: func(uintptr) error {
			f.applies[tag]++
			return nil
		}}
	}
	restoreSecurityApplier = func(sd []byte) (*securefs.SecurityApplier, error) {
		return tagged("captured:" + string(sd)), nil
	}
	restoreSDPlatform = sdPlatform{
		principals: func(sd []byte) (sdPrincipals, error) {
			switch string(sd) {
			case "known":
				return sdPrincipals{owner: testLocalSID, dacl: []aceEntry{{sid: "S-1-5-18"}, {sid: testLocalSID}}}, nil
			case "foreign-owner":
				return sdPrincipals{owner: testForeignSID, dacl: []aceEntry{{sid: "S-1-5-18"}}}, nil
			case "foreign-group":
				return sdPrincipals{owner: testLocalSID, group: testForeignSID}, nil
			case "foreign-dacl":
				return sdPrincipals{owner: testLocalSID, dacl: []aceEntry{{sid: testForeignSID}}}, nil
			case "foreign-sacl":
				return sdPrincipals{owner: testLocalSID, saclApplied: true, sacl: []aceEntry{{sid: testForeignSID}}}, nil
			}
			return sdPrincipals{}, errors.New("unreadable descriptor")
		},
		domains: func() (knownDomains, []string) {
			f.domainCalls++
			return knownDomains{account: "S-1-5-21-1-2-3"}, domainNotes
		},
		withoutSACL: func(sd []byte) (*securefs.SecurityApplier, error) {
			return tagged("nosacl:" + string(sd)), nil
		},
		quarantine: func() (*securefs.SecurityApplier, error) {
			a := tagged("quarantine")
			if f.quarantineFails {
				a.Apply = func(uintptr) error { return errors.New("injected restrict failure") }
			}
			return a, nil
		},
	}
}

func encSDs(names ...string) []string {
	out := make([]string, len(names))
	for i, n := range names {
		out[i] = base64.StdEncoding.EncodeToString([]byte(n))
	}
	return out
}

// TestRestore_SecurityDescriptorQuarantine drives the real restore with the
// descriptor decision's platform faked: known principals apply as captured;
// an unrecognised owner, group or DACL trustee — or principals that cannot be
// read — quarantine the entry (file or directory) with the restrictive
// descriptor and list it in the result; an unrecognised SACL trustee applies
// the descriptor without its SACL. Every entry still restores, the machine's
// domains are resolved once per run, and the run carries one aggregate
// warning per outcome.
func TestRestore_SecurityDescriptorQuarantine(t *testing.T) {
	files := []sdTestFile{
		{name: "known.txt", content: "k", sourcePath: "/original/top/known.txt", sdIndex: 1},
		{name: "owner.txt", content: "o", sourcePath: "/original/top/owner.txt", sdIndex: 2},
		{name: "group.txt", content: "g", sourcePath: "/original/top/group.txt", sdIndex: 3},
		{name: "dacl.txt", content: "d", sourcePath: "/original/top/dacl.txt", sdIndex: 4},
		{name: "sacl.txt", content: "s", sourcePath: "/original/top/sacl.txt", sdIndex: 5},
		{name: "unread.txt", content: "u", sourcePath: "/original/top/unread.txt", sdIndex: 6},
	}
	extra := []SnapshotFile{
		{SourcePath: "/original/top", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), SDIndex: 1},
		{SourcePath: "/original/top/qdir", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), SDIndex: 4},
	}
	provider, snapshotID := setupRestoreTestSnapshotWithSDEntries(t, files, extra,
		encSDs("known", "foreign-owner", "foreign-group", "foreign-dacl", "foreign-sacl", "garbage"))
	target := t.TempDir()

	f := &fakeSDPlatform{applies: map[string]int{}}
	installFakeSDPlatform(t, f, []string{"trusted domains could not be enumerated (injected)"})

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.FilesRestored != len(files)+len(extra) || result.FilesFailed != 0 {
		t.Fatalf("result = %+v, want every entry restored", result)
	}
	if f.applies["captured:known"] != 2 || f.applies["nosacl:foreign-sacl"] != 1 || f.applies["quarantine"] != 5 {
		t.Fatalf("applies = %v, want captured:known x2 (file + top dir), nosacl x1, quarantine x5 (owner, group, dacl, unreadable files + qdir)", f.applies)
	}
	for tag := range f.applies {
		if strings.HasPrefix(tag, "captured:foreign") || tag == "captured:garbage" {
			t.Errorf("descriptor %q was applied as captured", tag)
		}
	}
	wantPaths := []string{"/original/top/owner.txt", "/original/top/group.txt", "/original/top/dacl.txt", "/original/top/unread.txt", "/original/top/qdir"}
	if result.SecurityDescriptorQuarantined != len(wantPaths) {
		t.Errorf("SecurityDescriptorQuarantined = %d, want %d", result.SecurityDescriptorQuarantined, len(wantPaths))
	}
	for _, p := range wantPaths {
		if !slices.Contains(result.SecurityDescriptorQuarantinedPaths, p) {
			t.Errorf("SecurityDescriptorQuarantinedPaths %v missing %q", result.SecurityDescriptorQuarantinedPaths, p)
		}
	}
	if f.domainCalls != 1 {
		t.Errorf("domains resolved %d times, want once per restore run", f.domainCalls)
	}
	var quarantineWarn, saclWarn, domainWarn int
	for _, w := range result.Warnings {
		switch {
		case strings.HasPrefix(w, "5 entries were restored with a restrictive access list"):
			quarantineWarn++
		case strings.HasPrefix(w, "1 entries were restored without their recorded audit entries"):
			saclWarn++
		case strings.Contains(w, "trusted domains could not be enumerated (injected)"):
			domainWarn++
		}
	}
	if quarantineWarn != 1 || saclWarn != 1 || domainWarn != 1 {
		t.Errorf("warnings = %q, want one quarantine, one SACL and one domain warning", result.Warnings)
	}
	for _, file := range files {
		r, _ := restoreRelativePath(file.sourcePath)
		if b, err := os.ReadFile(filepath.Join(target, r)); err != nil || string(b) != file.content {
			t.Errorf("%s not restored: %q, %v", file.sourcePath, b, err)
		}
	}
}

// TestRestore_SecurityDescriptorQuarantineFailureNeverPublishes: when the
// restrictive descriptor cannot be applied, the file is failed and nothing
// is published under its name (it must never land with the parent's ACL); a
// directory that cannot be restricted is reported failed.
func TestRestore_SecurityDescriptorQuarantineFailureNeverPublishes(t *testing.T) {
	files := []sdTestFile{
		{name: "dacl.txt", content: "d", sourcePath: "/original/top/dacl.txt", sdIndex: 1},
		{name: "known.txt", content: "k", sourcePath: "/original/top/known.txt", sdIndex: 2},
	}
	extra := []SnapshotFile{
		{SourcePath: "/original/top/qdir", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), SDIndex: 1},
	}
	provider, snapshotID := setupRestoreTestSnapshotWithSDEntries(t, files, extra, encSDs("foreign-dacl", "known"))
	target := t.TempDir()
	f := &fakeSDPlatform{applies: map[string]int{}, quarantineFails: true}
	installFakeSDPlatform(t, f, nil)

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.FilesRestored != 1 || result.FilesFailed != 2 {
		t.Fatalf("result = %+v, want 1 restored (known.txt), 2 failed", result)
	}
	for _, p := range []string{"/original/top/dacl.txt", "/original/top/qdir"} {
		if !slices.Contains(result.FailedFiles, p) {
			t.Errorf("FailedFiles %v missing %q", result.FailedFiles, p)
		}
	}
	if result.SecurityDescriptorQuarantined != 0 || len(result.SecurityDescriptorQuarantinedPaths) != 0 {
		t.Errorf("entries that could not be restricted were counted as quarantined: %+v", result)
	}
	r, _ := restoreRelativePath("/original/top/dacl.txt")
	if _, err := os.Stat(filepath.Join(target, r)); !os.IsNotExist(err) {
		t.Errorf("dacl.txt was published although it could not be restricted (stat err %v)", err)
	}
	entries, _ := os.ReadDir(filepath.Dir(filepath.Join(target, r)))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".breeze-restore-") {
			t.Errorf("temporary %s left behind", e.Name())
		}
	}
}

func TestRestoreResult_QuarantineFieldNames(t *testing.T) {
	b, err := json.Marshal(RestoreResult{SecurityDescriptorQuarantined: 2, SecurityDescriptorQuarantinedPaths: []string{`C:\a`, `C:\b`}})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"securityDescriptorQuarantined":2`, `"securityDescriptorQuarantinedPaths":["C:\\a","C:\\b"]`} {
		if !strings.Contains(string(b), key) {
			t.Errorf("%s missing %s", b, key)
		}
	}
	b, _ = json.Marshal(RestoreResult{})
	if strings.Contains(string(b), "securityDescriptorQuarantined") {
		t.Errorf("empty result carries quarantine fields: %s", b)
	}
}

// TestRestore_SecurityDescriptorsAsCapturedSkipsTheDecision: a whole-machine
// rebuild restores the tree that becomes the machine the snapshot's accounts
// belong to, so it opts out of the principal check and every descriptor is
// applied as captured.
func TestRestore_SecurityDescriptorsAsCapturedSkipsTheDecision(t *testing.T) {
	files := []sdTestFile{
		{name: "owner.txt", content: "o", sourcePath: "/original/top/owner.txt", sdIndex: 1},
		{name: "dacl.txt", content: "d", sourcePath: "/original/top/dacl.txt", sdIndex: 2},
	}
	provider, snapshotID := setupRestoreTestSnapshotWithSD(t, files, encSDs("foreign-owner", "foreign-dacl"))
	f := &fakeSDPlatform{applies: map[string]int{}}
	installFakeSDPlatform(t, f, nil)

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: t.TempDir(), SecurityDescriptorsAsCaptured: true}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.FilesRestored != 2 || result.SecurityDescriptorQuarantined != 0 {
		t.Fatalf("result = %+v, want 2 restored, none quarantined", result)
	}
	if f.applies["captured:foreign-owner"] != 1 || f.applies["captured:foreign-dacl"] != 1 || f.applies["quarantine"] != 0 || f.domainCalls != 0 {
		t.Fatalf("applies = %v domainCalls = %d, want both captured and no domain lookup", f.applies, f.domainCalls)
	}
}

// TestRestore_UnreadableSecurityDescriptorIsQuarantined: an entry whose
// recorded descriptor cannot be used — it does not validate, its table slot
// does not decode, or its index points past the table — is restricted like
// one naming unknown principals, never left with the target's inherited ACL.
// This holds for a whole-machine rebuild too (the principal check is what
// that opts out of, not a readable descriptor).
func TestRestore_UnreadableSecurityDescriptorIsQuarantined(t *testing.T) {
	for _, asCaptured := range []bool{false, true} {
		t.Run(map[bool]string{false: "restore", true: "rebuild"}[asCaptured], func(t *testing.T) {
			files := []sdTestFile{
				{name: "invalid.txt", content: "i", sourcePath: "/original/top/invalid.txt", sdIndex: 1},
				{name: "corrupt.txt", content: "c", sourcePath: "/original/top/corrupt.txt", sdIndex: 2},
				{name: "past.txt", content: "p", sourcePath: "/original/top/past.txt", sdIndex: 9},
				{name: "known.txt", content: "k", sourcePath: "/original/top/known.txt", sdIndex: 3},
			}
			extra := []SnapshotFile{
				{SourcePath: "/original/top/cdir", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), SDIndex: 2},
			}
			table := append(encSDs("invalid"), "!!!not base64!!!")
			table = append(table, encSDs("known")...)
			provider, snapshotID := setupRestoreTestSnapshotWithSDEntries(t, files, extra, table)
			f := &fakeSDPlatform{applies: map[string]int{}}
			installFakeSDPlatform(t, f, nil)
			captured := restoreSecurityApplier
			restoreSecurityApplier = func(sd []byte) (*securefs.SecurityApplier, error) {
				if string(sd) == "invalid" {
					return nil, errors.New("not a valid security descriptor")
				}
				return captured(sd)
			}

			result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: t.TempDir(), SecurityDescriptorsAsCaptured: asCaptured}, nil)
			if err != nil {
				t.Fatalf("RestoreFromSnapshot: %v", err)
			}
			wantPaths := []string{"/original/top/invalid.txt", "/original/top/corrupt.txt", "/original/top/past.txt", "/original/top/cdir"}
			if result.FilesFailed != 0 || f.applies["quarantine"] != len(wantPaths) || f.applies["captured:known"] != 1 {
				t.Fatalf("result = %+v applies = %v, want the four unreadable entries restricted and known applied", result, f.applies)
			}
			if result.SecurityDescriptorQuarantined != len(wantPaths) {
				t.Fatalf("SecurityDescriptorQuarantined = %d, want %d", result.SecurityDescriptorQuarantined, len(wantPaths))
			}
			for _, p := range wantPaths {
				if !slices.Contains(result.SecurityDescriptorQuarantinedPaths, p) {
					t.Errorf("SecurityDescriptorQuarantinedPaths %v missing %q", result.SecurityDescriptorQuarantinedPaths, p)
				}
			}
		})
	}
}

// TestRestore_QuarantinedDirectoryIsRestrictedBeforeItsChildren: a directory
// whose recorded descriptor is restricted gets the restrictive descriptor
// before anything is restored beneath it, so children restored without a
// descriptor of their own inherit the restriction, not the target's ACL.
func TestRestore_QuarantinedDirectoryIsRestrictedBeforeItsChildren(t *testing.T) {
	files := []sdTestFile{
		{name: "child.txt", content: "c", sourcePath: "/original/top/qdir/child.txt"}, // no descriptor
		{name: "known.txt", content: "k", sourcePath: "/original/top/known.txt", sdIndex: 1},
	}
	extra := []SnapshotFile{
		{SourcePath: "/original/top/qdir", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), SDIndex: 2},
	}
	provider, snapshotID := setupRestoreTestSnapshotWithSDEntries(t, files, extra, encSDs("known", "foreign-dacl"))
	target := t.TempDir()
	f := &fakeSDPlatform{applies: map[string]int{}}
	installFakeSDPlatform(t, f, nil)
	childRel, _ := restoreRelativePath("/original/top/qdir/child.txt")
	childPresentAtRestrict := true
	restoreSDPlatform.quarantine = func() (*securefs.SecurityApplier, error) {
		return &securefs.SecurityApplier{Apply: func(uintptr) error {
			f.applies["quarantine"]++
			_, err := os.Stat(filepath.Join(target, childRel))
			childPresentAtRestrict = err == nil
			return nil
		}}, nil
	}

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.FilesFailed != 0 || f.applies["quarantine"] != 1 {
		t.Fatalf("result = %+v applies = %v, want the directory restricted once", result, f.applies)
	}
	if childPresentAtRestrict {
		t.Fatal("the directory was restricted after its child was restored")
	}
	if !slices.Contains(result.SecurityDescriptorQuarantinedPaths, "/original/top/qdir") || result.SecurityDescriptorQuarantined != 1 {
		t.Fatalf("quarantined = %d %v", result.SecurityDescriptorQuarantined, result.SecurityDescriptorQuarantinedPaths)
	}
	if b, err := os.ReadFile(filepath.Join(target, childRel)); err != nil || string(b) != "c" {
		t.Fatalf("child not restored: %q %v", b, err)
	}
}

// When the directory cannot be restricted, nothing is restored beneath it:
// its children would otherwise land with the target's inherited ACL.
func TestRestore_UnrestrictableDirectoryBlocksItsChildren(t *testing.T) {
	files := []sdTestFile{
		{name: "child.txt", content: "c", sourcePath: "/original/top/qdir/child.txt"},
		{name: "known.txt", content: "k", sourcePath: "/original/top/known.txt", sdIndex: 1},
	}
	extra := []SnapshotFile{
		{SourcePath: "/original/top/qdir", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755), SDIndex: 2},
		{SourcePath: "/original/top/qdir/sub", Kind: KindDir, ModeBits: uint32(os.ModeDir | 0o755)},
	}
	provider, snapshotID := setupRestoreTestSnapshotWithSDEntries(t, files, extra, encSDs("known", "foreign-dacl"))
	target := t.TempDir()
	f := &fakeSDPlatform{applies: map[string]int{}, quarantineFails: true}
	installFakeSDPlatform(t, f, nil)

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/original/top/qdir", "/original/top/qdir/child.txt", "/original/top/qdir/sub"} {
		if !slices.Contains(result.FailedFiles, p) {
			t.Errorf("FailedFiles %v missing %q", result.FailedFiles, p)
		}
	}
	childRel, _ := restoreRelativePath("/original/top/qdir/child.txt")
	if _, err := os.Stat(filepath.Join(target, childRel)); !os.IsNotExist(err) {
		t.Fatalf("child restored beneath a directory that could not be restricted (%v)", err)
	}
	knownRel, _ := restoreRelativePath("/original/top/known.txt")
	if _, err := os.Stat(filepath.Join(target, knownRel)); err != nil {
		t.Fatalf("unrelated file not restored: %v", err)
	}
}
