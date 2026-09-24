package bmr

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/winhive"
)

const testRootGUID = "12345678-1234-5678-9abc-def012345678"

func fakeLoad(seed map[string]*winhive.Fake, calls *[]string) func(string, string) (winhive.Handle, error) {
	return func(hiveFile, mountName string) (winhive.Handle, error) {
		*calls = append(*calls, mountName)
		f, ok := seed[filepath.Base(hiveFile)]
		if !ok {
			return nil, os.ErrNotExist
		}
		return f, nil
	}
}

func seedTree(t *testing.T, hives ...string) string {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "Windows", "System32", "config")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, h := range hives {
		if err := os.WriteFile(filepath.Join(dir, h), []byte("tree-"+h), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func seedArtifacts(t *testing.T, hives ...string) string {
	t.Helper()
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, h := range hives {
		if err := os.WriteFile(filepath.Join(dir, h), []byte("artifact-"+h), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return staging
}

func systemFake(ntds bool) *winhive.Fake {
	f := winhive.NewFake()
	sel, _ := f.CreateKey("Select")
	_ = sel.SetDWORD("Default", 1)
	_ = sel.SetDWORD("Current", 1)
	_, _ = f.CreateKey(`ControlSet001\Services`)
	if ntds {
		_, _ = f.CreateKey(`ControlSet001\Services\NTDS`)
	}
	return f
}

func TestSelectOfflineHives_TreeCompleteNoFallback(t *testing.T) {
	root := seedTree(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY")
	warning, err := selectOfflineHives(root, seedArtifacts(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY"))
	if err != nil || warning != "" {
		t.Fatalf("warning=%q err=%v", warning, err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "Windows", "System32", "config", "SAM")); string(b) != "tree-SAM" {
		t.Fatalf("tree hive replaced although the tree was complete: %q", b)
	}
}

// R16: one hive missing from the tree → ALL FOUR replaced + logs removed.
func TestSelectOfflineHives_AllOrNothingFallback(t *testing.T) {
	root := seedTree(t, "SYSTEM", "SOFTWARE", "SAM") // SECURITY missing
	cfg := filepath.Join(root, "Windows", "System32", "config")
	_ = os.WriteFile(filepath.Join(cfg, "SYSTEM.LOG1"), []byte("stale"), 0o600)
	_ = os.WriteFile(filepath.Join(cfg, "SYSTEM.LOG2"), []byte("stale"), 0o600)
	warning, err := selectOfflineHives(root, seedArtifacts(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY"))
	if err != nil || warning != "registry hives restored from the system-state artifacts, not the file tree" {
		t.Fatalf("warning=%q err=%v", warning, err)
	}
	for _, h := range offlineRequiredHives {
		if b, _ := os.ReadFile(filepath.Join(cfg, h)); string(b) != "artifact-"+h {
			t.Errorf("%s = %q, want the artifact", h, b)
		}
	}
	for _, log := range []string{"SYSTEM.LOG1", "SYSTEM.LOG2"} {
		if _, err := os.Stat(filepath.Join(cfg, log)); !os.IsNotExist(err) {
			t.Errorf("%s must be deleted", log)
		}
	}
}

// R17: missing from both → error, and nothing in the tree was overwritten.
func TestSelectOfflineHives_MissingFromBoth(t *testing.T) {
	root := seedTree(t, "SYSTEM", "SOFTWARE") // SAM, SECURITY missing
	_, err := selectOfflineHives(root, seedArtifacts(t, "SYSTEM", "SOFTWARE", "SAM"))
	if err == nil || err.Error() != "hive SECURITY missing from both the file tree and the system-state artifacts" {
		t.Fatalf("err = %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "Windows", "System32", "config", "SYSTEM")); string(b) != "tree-SYSTEM" {
		t.Fatalf("SYSTEM was overwritten before every artifact was confirmed: %q", b)
	}
}

func TestSelectOfflineHives_NoStagingDir(t *testing.T) {
	_, err := selectOfflineHives(seedTree(t, "SYSTEM"), "")
	if err == nil || !strings.Contains(err.Error(), "missing from both") {
		t.Fatalf("err = %v", err)
	}
}

func TestRestoreSystemStateOfflineWindows_AppliesAndLeavesHivesOpen(t *testing.T) {
	root := seedTree(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY")
	sys := systemFake(false)
	var calls []string
	load := fakeLoad(map[string]*winhive.Fake{"SYSTEM": sys, "SOFTWARE": winhive.NewFake()}, &calls)
	st, warnings, err := RestoreSystemStateOfflineWindows(context.Background(), root, "", testRootGUID, []string{testRootGUID}, "k1", false, load)
	if err != nil {
		t.Fatalf("err=%v warnings=%v", err, warnings)
	}
	if st.System == nil || st.Software == nil || len(st.ControlSets) != 1 {
		t.Fatalf("state = %+v", st)
	}
	if strings.Join(calls, ",") != "BRZ_k1_SYSTEM,BRZ_k1_SOFTWARE" {
		t.Fatalf("mounts = %v", calls)
	}
	want := false
	for _, w := range warnings {
		want = want || w == "MountedDevices: C: remapped to the restored partition; 0 stale drive letters removed"
	}
	if !want {
		t.Fatalf("warnings = %v", warnings)
	}
}

// R15 (restore-phase leg).
func TestRestoreSystemStateOfflineWindows_RefusesDomainController(t *testing.T) {
	root := seedTree(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY")
	var calls []string
	load := fakeLoad(map[string]*winhive.Fake{"SYSTEM": systemFake(true), "SOFTWARE": winhive.NewFake()}, &calls)
	_, _, err := RestoreSystemStateOfflineWindows(context.Background(), root, "", testRootGUID, nil, "k1", false, load)
	if err == nil || err.Error() != `source is a domain controller (Services\NTDS present); pass --allow-domain-controller and read the DC recovery guidance` {
		t.Fatalf("err = %v", err)
	}
	if _, _, err := RestoreSystemStateOfflineWindows(context.Background(), root, "", testRootGUID, nil, "k1", true, load); err != nil {
		t.Fatalf("allowDC: %v", err)
	}
}

// A hive present in the tree whose artifact is missing: the fallback cannot
// replace all four, and the error does not claim that hive is missing from
// both. Nothing is overwritten.
func TestSelectOfflineHives_TreeHiveWithoutArtifact(t *testing.T) {
	root := seedTree(t, "SOFTWARE", "SAM", "SECURITY") // SYSTEM missing from the tree
	_, err := selectOfflineHives(root, seedArtifacts(t, "SYSTEM", "SOFTWARE", "SAM"))
	want := "hive SYSTEM missing from the file tree, and the all-or-nothing artifact fallback cannot replace all four hives: system-state artifact SECURITY is missing"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v", err)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "Windows", "System32", "config", "SAM")); string(b) != "tree-SAM" {
		t.Fatalf("SAM was overwritten before every artifact was confirmed: %q", b)
	}
}

// systemFakeTwoSets: Select\Default=1, Select\Current=2, both sets present.
func systemFakeTwoSets() *winhive.Fake {
	f := winhive.NewFake()
	sel, _ := f.CreateKey("Select")
	_ = sel.SetDWORD("Default", 1)
	_ = sel.SetDWORD("Current", 2)
	_, _ = f.CreateKey(`ControlSet001\Services`)
	_, _ = f.CreateKey(`ControlSet002\Services`)
	return f
}

// Fix round 1: boot-start storage edits land in EVERY selected control set.
func TestRestoreSystemStateOfflineWindows_BootStartInEachControlSet(t *testing.T) {
	root := seedTree(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY")
	sys := systemFakeTwoSets()
	for _, cs := range []string{"ControlSet001", "ControlSet002"} {
		k, _ := sys.CreateKey(cs + `\Services\storahci`)
		_ = k.SetDWORD("Start", 3)
		_, _ = k.CreateKey("StartOverride")
	}
	var calls []string
	load := fakeLoad(map[string]*winhive.Fake{"SYSTEM": sys, "SOFTWARE": winhive.NewFake()}, &calls)
	st, _, err := RestoreSystemStateOfflineWindows(context.Background(), root, "", testRootGUID, []string{testRootGUID}, "k1", false, load)
	if err != nil || len(st.ControlSets) != 2 {
		t.Fatalf("st=%+v err=%v", st, err)
	}
	for _, cs := range []string{"ControlSet001", "ControlSet002"} {
		k, err := sys.OpenKey(cs + `\Services\storahci`)
		if err != nil {
			t.Fatal(err)
		}
		if v, _ := k.GetDWORD("Start"); v != 0 {
			t.Errorf("%s storahci Start = %d, want 0", cs, v)
		}
		if _, err := k.OpenKey("StartOverride"); err == nil {
			t.Errorf("%s storahci StartOverride must be deleted", cs)
		}
	}
}

// Fix round 1: a DC whose NTDS key is only under Select\Current is refused.
func TestRestoreSystemStateOfflineWindows_RefusesNTDSUnderCurrentOnly(t *testing.T) {
	root := seedTree(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY")
	sys := systemFakeTwoSets()
	_, _ = sys.CreateKey(`ControlSet002\Services\NTDS`)
	var calls []string
	load := fakeLoad(map[string]*winhive.Fake{"SYSTEM": sys, "SOFTWARE": winhive.NewFake()}, &calls)
	_, _, err := RestoreSystemStateOfflineWindows(context.Background(), root, "", testRootGUID, nil, "k1", false, load)
	if err == nil || !strings.Contains(err.Error(), "source is a domain controller") {
		t.Fatalf("err = %v", err)
	}
}

// Fix round 1: a copy failure on the 3rd hive leaves the tree untouched —
// no mix of artifact and tree hives, logs kept, no temp files left.
func TestSelectOfflineHives_CopyFailureLeavesTreeUntouched(t *testing.T) {
	root := seedTree(t, "SYSTEM", "SOFTWARE") // SAM, SECURITY missing
	cfg := filepath.Join(root, "Windows", "System32", "config")
	_ = os.WriteFile(filepath.Join(cfg, "SYSTEM.LOG1"), []byte("log"), 0o600)
	staging := seedArtifacts(t, "SYSTEM", "SOFTWARE", "SECURITY")
	// SAM (the 3rd hive copied) is a directory: present, but unreadable as a file.
	if err := os.MkdirAll(filepath.Join(staging, "registry", "SAM"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := selectOfflineHives(root, staging); err == nil || !strings.Contains(err.Error(), "SAM") {
		t.Fatalf("err = %v, want a SAM copy failure", err)
	}
	entries, _ := os.ReadDir(cfg)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if strings.Join(names, ",") != "SOFTWARE,SYSTEM,SYSTEM.LOG1" {
		t.Fatalf("config dir = %v, want the untouched tree", names)
	}
	for _, h := range []string{"SYSTEM", "SOFTWARE"} {
		if b, _ := os.ReadFile(filepath.Join(cfg, h)); string(b) != "tree-"+h {
			t.Errorf("%s = %q, want the tree hive", h, b)
		}
	}
}
