package systemstate

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// #5397 follow-up: under VSS the registry hives are copied out of the shadow
// copy's Windows\System32\config instead of spawning `reg.exe save`, which
// Defender flags as Trojan:Win32/Commando.A!ml for SAM and SECURITY. These
// tests build a fake shadow tree on disk, so they run on every GOOS; the
// Windows device-path form is pinned in shadow_hives_windows_test.go.

// forbidRegSave fails the test if anything reaches reg.exe.
func forbidRegSave(t *testing.T) {
	t.Helper()
	orig := runRegSave
	t.Cleanup(func() { runRegSave = orig })
	runRegSave = func(hive, _ string) ([]byte, error) {
		t.Errorf("reg save %s was spawned although the run has a shadow copy of the system volume", hive)
		return nil, errors.New("reg.exe must not run under VSS")
	}
}

// fakeShadowRoot lays out <root>/Windows/System32/config with the named
// files, each holding "shadow-<name>", and returns root.
func fakeShadowRoot(t *testing.T, files ...string) string {
	t.Helper()
	root := t.TempDir()
	cfg := filepath.Join(root, "Windows", "System32", "config")
	if err := os.MkdirAll(cfg, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if err := os.WriteFile(filepath.Join(cfg, f), []byte("shadow-"+f), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func artifactByPath(arts []Artifact) map[string]Artifact {
	m := make(map[string]Artifact, len(arts))
	for _, a := range arts {
		m[a.Path] = a
	}
	return m
}

func TestShadowConfigDir(t *testing.T) {
	root := t.TempDir()
	want := filepath.Join(root, "Windows", "System32", "config")
	tests := []struct {
		name       string
		shadows    map[string]string
		systemRoot string
		want       string
		wantOK     bool
	}{
		{"system volume shadowed", map[string]string{"C:": root}, `C:\Windows`, want, true},
		{"shadow root with trailing separator", map[string]string{"C:": root + string(filepath.Separator)}, `C:\Windows`, want, true},
		{"volume key is case-insensitive", map[string]string{"c:": root}, `C:\Windows`, want, true},
		{"system root with trailing separator", map[string]string{"C:": root}, `C:\Windows\`, want, true},
		{"non-default system root", map[string]string{"C:": root}, `C:\WINNT`, filepath.Join(root, "WINNT", "System32", "config"), true},
		{"system volume not shadowed", map[string]string{"D:": root}, `C:\Windows`, "", false},
		{"no VSS session", nil, `C:\Windows`, "", false},
		{"empty shadow root", map[string]string{"C:": ""}, `C:\Windows`, "", false},
		{"unknown system root", map[string]string{"C:": root}, "", "", false},
		{"system root without a drive letter", map[string]string{"C:": root}, `\Windows`, "", false},
		{"system root that is only a drive", map[string]string{"C:": root}, `C:\`, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := shadowConfigDir(tt.shadows, tt.systemRoot)
			if got != tt.want || ok != tt.wantOK {
				t.Errorf("shadowConfigDir(%v, %q) = (%q, %v), want (%q, %v)", tt.shadows, tt.systemRoot, got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

// The whole point of #5397's follow-up: with a shadow copy of the system
// volume, every hive (and its transaction logs) comes from the shadow copy
// and reg.exe is never spawned. Artifact names and paths keep the layout the
// rebuild engine reads: registry/<HIVE>, named registry_<HIVE>.
func TestCollectRegistryHivesForRun_UnderVSSCopiesFromShadowWithoutRegExe(t *testing.T) {
	forbidRegSave(t)
	root := fakeShadowRoot(t,
		"SYSTEM", "SYSTEM.LOG1", "SYSTEM.LOG2",
		"SOFTWARE", "SOFTWARE.LOG1", "SOFTWARE.LOG2",
		"SAM", "SAM.LOG1", "SAM.LOG2",
		"SECURITY", "SECURITY.LOG1", "SECURITY.LOG2",
		"DEFAULT", "DEFAULT.LOG1", "DEFAULT.LOG2",
		"COMPONENTS", "BBI", // present in a real config dir, not captured
	)
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}

	var acquired, released int
	opts := CollectOptions{
		ShadowPaths: map[string]string{"C:": root},
		AcquireBackupPrivilege: func() (func(), error) {
			acquired++
			return func() { released++ }, nil
		},
	}
	arts, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, opts)
	if err != nil {
		t.Fatalf("collectRegistryHivesForRun: %v", err)
	}
	if acquired != 1 || released != 1 {
		t.Errorf("backup privilege acquired %d / released %d times, want 1/1", acquired, released)
	}

	byPath := artifactByPath(arts)
	var gotPaths []string
	for p := range byPath {
		gotPaths = append(gotPaths, p)
	}
	sort.Strings(gotPaths)
	var wantPaths []string
	for _, h := range []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT"} {
		wantPaths = append(wantPaths, "registry/"+h, "registry/"+h+".LOG1", "registry/"+h+".LOG2")
	}
	sort.Strings(wantPaths)
	if !reflect.DeepEqual(gotPaths, wantPaths) {
		t.Fatalf("artifact paths = %v, want %v", gotPaths, wantPaths)
	}
	for _, h := range []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT"} {
		a := byPath["registry/"+h]
		if a.Name != "registry_"+h || a.Category != "registry" {
			t.Errorf("%s artifact = name %q category %q, want registry_%s / registry", h, a.Name, a.Category, h)
		}
		if a.Checksum == "" || a.SizeBytes == 0 {
			t.Errorf("%s artifact has no checksum/size: %+v", h, a)
		}
		if b, _ := os.ReadFile(filepath.Join(dir, h)); string(b) != "shadow-"+h {
			t.Errorf("staged %s = %q, want the shadow copy's bytes", h, b)
		}
		if l := byPath["registry/"+h+".LOG1"]; l.Name != "registry_"+h+".LOG1" || l.Category != "registry" {
			t.Errorf("%s.LOG1 artifact = %+v", h, l)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "COMPONENTS")); !os.IsNotExist(err) {
		t.Errorf("COMPONENTS was staged; only the named hives are captured")
	}
}

// Logs are optional (a hive can be fully flushed with no log files); a
// missing log is not a failure.
func TestCollectRegistryHivesFromShadow_MissingLogsAreNotAFailure(t *testing.T) {
	forbidRegSave(t)
	root := fakeShadowRoot(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT", "SYSTEM.LOG1")
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)

	arts, err := collectRegistryHivesFromShadow(dir, staging, filepath.Join(root, "Windows", "System32", "config"), shadowRegistryHives)
	if err != nil {
		t.Fatalf("missing optional logs must not fail the step: %v", err)
	}
	if len(arts) != 6 {
		t.Errorf("artifacts = %d, want 5 hives + SYSTEM.LOG1", len(arts))
	}
}

// #5397's merged part stays: any missing hive fails the step and is named in
// the error that lands in errorLog — and under VSS the step does NOT fall
// back to reg.exe for it (that is exactly the call Defender blocks).
func TestCollectRegistryHivesForRun_MissingShadowHiveFailsAndIsNamed(t *testing.T) {
	forbidRegSave(t)
	root := fakeShadowRoot(t, "SYSTEM", "SOFTWARE", "SAM", "DEFAULT") // SECURITY missing
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)

	arts, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, CollectOptions{ShadowPaths: map[string]string{"C:": root}})
	if err == nil {
		t.Fatal("a hive missing from the shadow copy must fail the registry step")
	}
	var rsErr *registrySaveError
	if !errors.As(err, &rsErr) {
		t.Fatalf("error type = %T, want *registrySaveError", err)
	}
	if want := []string{"SECURITY"}; !reflect.DeepEqual(rsErr.FailedHives, want) {
		t.Errorf("FailedHives = %v, want %v", rsErr.FailedHives, want)
	}
	if !strings.Contains(err.Error(), "SECURITY") || !strings.Contains(err.Error(), "shadow copy") {
		t.Errorf("error %q must name SECURITY and the shadow-copy source", err.Error())
	}
	if len(arts) != 4 {
		t.Errorf("artifacts = %d, want the 4 hives that were captured", len(arts))
	}
}

// A log that exists but cannot be read would leave a primary hive that may
// lag its own log: the hive fails as a unit and nothing of it is staged.
func TestCollectRegistryHivesFromShadow_UnreadableLogFailsTheWholeHive(t *testing.T) {
	forbidRegSave(t)
	root := fakeShadowRoot(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT", "SAM.LOG2")
	cfg := filepath.Join(root, "Windows", "System32", "config")
	if err := os.MkdirAll(filepath.Join(cfg, "SAM.LOG1"), 0o755); err != nil { // present, not a file
		t.Fatal(err)
	}
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)

	arts, err := collectRegistryHivesFromShadow(dir, staging, cfg, shadowRegistryHives)
	var rsErr *registrySaveError
	if !errors.As(err, &rsErr) || !reflect.DeepEqual(rsErr.FailedHives, []string{"SAM"}) {
		t.Fatalf("err = %v, want SAM named as failed", err)
	}
	for _, a := range arts {
		if strings.HasPrefix(a.Path, "registry/SAM") {
			t.Errorf("artifact %s recorded for the failed hive", a.Path)
		}
	}
	for _, f := range []string{"SAM", "SAM.LOG1", "SAM.LOG2"} {
		if _, err := os.Lstat(filepath.Join(dir, f)); !os.IsNotExist(err) {
			t.Errorf("%s left staged for a failed hive", f)
		}
	}
}

// Without a shadow copy of the system volume the step keeps using reg.exe
// (the non-VSS fallback), with the original four hives.
func TestCollectRegistryHivesForRun_WithoutShadowUsesRegSave(t *testing.T) {
	orig := runRegSave
	t.Cleanup(func() { runRegSave = orig })
	var saved []string
	runRegSave = func(hive, outPath string) ([]byte, error) {
		saved = append(saved, hive)
		return nil, os.WriteFile(outPath, []byte("hive-"+hive), 0o600)
	}
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)

	// D: is shadowed, the system volume is not.
	opts := CollectOptions{ShadowPaths: map[string]string{"D:": t.TempDir()}}
	if _, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, opts); err != nil {
		t.Fatalf("collectRegistryHivesForRun: %v", err)
	}
	if want := []string{"SYSTEM", "SOFTWARE", "SAM", "SECURITY"}; !reflect.DeepEqual(saved, want) {
		t.Errorf("reg save hives = %v, want %v", saved, want)
	}
}

// A privilege that cannot be enabled is not fatal: SYSTEM and elevated
// Administrators can read the shadow copy's hive files without it.
func TestCollectRegistryHivesForRun_PrivilegeFailureIsNotFatal(t *testing.T) {
	forbidRegSave(t)
	root := fakeShadowRoot(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT")
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)
	opts := CollectOptions{
		ShadowPaths:            map[string]string{"C:": root},
		AcquireBackupPrivilege: func() (func(), error) { return nil, errors.New("privilege not held") },
	}
	if _, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, opts); err != nil {
		t.Fatalf("collectRegistryHivesForRun: %v", err)
	}
}

// fakeSnapshot is a CollectOptions.SnapshotVolume that "snapshots" volume onto
// root and counts calls and releases.
type fakeSnapshot struct {
	root            string
	err             error
	omitVolume      bool
	calls, released int
	volumes         []string
}

func (f *fakeSnapshot) snapshot(volume string) (map[string]string, func(), error) {
	f.calls++
	f.volumes = append(f.volumes, volume)
	if f.err != nil {
		return nil, nil, f.err
	}
	shadows := map[string]string{volume: f.root}
	if f.omitVolume {
		shadows = map[string]string{"Z:": f.root}
	}
	return shadows, func() { f.released++ }, nil
}

// Review item 1: a Windows system_image run with no paths has no run-wide VSS
// session (defaultVSS is false without paths), and the IPC system_state_collect
// has none either. The registry step must then take its OWN shadow copy of the
// system volume, copy the hives from it, and release it — never reg.exe.
func TestCollectRegistryHivesForRun_NoRunShadowTakesOwnSystemVolumeSnapshot(t *testing.T) {
	forbidRegSave(t)
	root := fakeShadowRoot(t, "SYSTEM", "SYSTEM.LOG1", "SOFTWARE", "SAM", "SECURITY", "SECURITY.LOG2", "DEFAULT")
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)
	snap := &fakeSnapshot{root: root}

	arts, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, CollectOptions{SnapshotVolume: snap.snapshot})
	if err != nil {
		t.Fatalf("collectRegistryHivesForRun: %v", err)
	}
	if snap.calls != 1 || !reflect.DeepEqual(snap.volumes, []string{"C:"}) {
		t.Errorf("snapshot calls = %d volumes = %v, want exactly one snapshot of C:", snap.calls, snap.volumes)
	}
	if snap.released != 1 {
		t.Errorf("own snapshot released %d times, want 1", snap.released)
	}
	if len(arts) != 7 {
		t.Errorf("artifacts = %d, want 5 hives + 2 logs", len(arts))
	}
}

// When the run's own VSS session already covers the system volume, no second
// snapshot is taken.
func TestCollectRegistryHivesForRun_RunShadowCoveringSystemVolumeTakesNoSnapshot(t *testing.T) {
	forbidRegSave(t)
	root := fakeShadowRoot(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY", "DEFAULT")
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)
	snap := &fakeSnapshot{root: root}

	opts := CollectOptions{ShadowPaths: map[string]string{"C:": root}, SnapshotVolume: snap.snapshot}
	if _, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, opts); err != nil {
		t.Fatalf("collectRegistryHivesForRun: %v", err)
	}
	if snap.calls != 0 {
		t.Errorf("took %d extra snapshots although the run's session covers C:", snap.calls)
	}
}

// Only a VSS failure reaches reg.exe: the snapshot could not be created.
func TestCollectRegistryHivesForRun_OwnSnapshotFailureFallsBackToRegSave(t *testing.T) {
	orig := runRegSave
	t.Cleanup(func() { runRegSave = orig })
	var saved []string
	runRegSave = func(hive, outPath string) ([]byte, error) {
		saved = append(saved, hive)
		return nil, os.WriteFile(outPath, []byte("hive-"+hive), 0o600)
	}
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)
	snap := &fakeSnapshot{err: errors.New("VSS_E_UNEXPECTED")}

	if _, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, CollectOptions{SnapshotVolume: snap.snapshot}); err != nil {
		t.Fatalf("collectRegistryHivesForRun: %v", err)
	}
	if snap.calls != 1 {
		t.Errorf("snapshot calls = %d, want 1", snap.calls)
	}
	if want := registryHives; !reflect.DeepEqual(saved, want) {
		t.Errorf("reg save hives = %v, want %v", saved, want)
	}
}

// A snapshot that came back without the system volume is released and the
// step falls back to reg.exe.
func TestCollectRegistryHivesForRun_OwnSnapshotMissingSystemVolumeIsReleased(t *testing.T) {
	orig := runRegSave
	t.Cleanup(func() { runRegSave = orig })
	runRegSave = func(hive, outPath string) ([]byte, error) {
		return nil, os.WriteFile(outPath, []byte("hive-"+hive), 0o600)
	}
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)
	snap := &fakeSnapshot{root: t.TempDir(), omitVolume: true}

	if _, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, CollectOptions{SnapshotVolume: snap.snapshot}); err != nil {
		t.Fatalf("collectRegistryHivesForRun: %v", err)
	}
	if snap.released != 1 {
		t.Errorf("unusable snapshot released %d times, want 1", snap.released)
	}
}

// The backup run's own VSS attempt already failed: do not spend another
// snapshot timeout on a VSS subsystem that just refused.
func TestCollectRegistryHivesForRun_SkipSystemVolumeSnapshot(t *testing.T) {
	orig := runRegSave
	t.Cleanup(func() { runRegSave = orig })
	runRegSave = func(hive, outPath string) ([]byte, error) {
		return nil, os.WriteFile(outPath, []byte("hive-"+hive), 0o600)
	}
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)
	snap := &fakeSnapshot{root: t.TempDir()}

	opts := CollectOptions{SnapshotVolume: snap.snapshot, SkipSystemVolumeSnapshot: true}
	if _, err := collectRegistryHivesForRun(dir, staging, `C:\Windows`, opts); err != nil {
		t.Fatalf("collectRegistryHivesForRun: %v", err)
	}
	if snap.calls != 0 {
		t.Errorf("snapshot calls = %d, want 0 when SkipSystemVolumeSnapshot is set", snap.calls)
	}
}

// Review minor: DEFAULT is captured for completeness but no restore consumer
// reads it, so a missing DEFAULT warns instead of failing the required step.
func TestCollectRegistryHivesFromShadow_MissingDefaultIsBestEffort(t *testing.T) {
	forbidRegSave(t)
	root := fakeShadowRoot(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY") // no DEFAULT
	staging := t.TempDir()
	dir := filepath.Join(staging, "registry")
	_ = os.MkdirAll(dir, 0o700)

	arts, err := collectRegistryHivesFromShadow(dir, staging, filepath.Join(root, "Windows", "System32", "config"), shadowRegistryHives)
	if err != nil {
		t.Fatalf("a missing DEFAULT hive must not fail the registry step: %v", err)
	}
	if len(arts) != 4 {
		t.Errorf("artifacts = %d, want the 4 required hives", len(arts))
	}
}
