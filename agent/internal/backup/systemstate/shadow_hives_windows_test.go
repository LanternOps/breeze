//go:build windows

package systemstate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// The shadow map's values are bare device roots with no trailing separator
// (vss.CreateShadowCopy returns SnapshotDeviceObject verbatim). The config
// directory must land BELOW the device, never on the bare device itself.
func TestShadowConfigDir_WindowsDevicePath(t *testing.T) {
	const dev = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy3`
	got, ok := shadowConfigDir(map[string]string{"C:": dev}, `C:\Windows`)
	if want := dev + `\Windows\System32\config`; !ok || got != want {
		t.Fatalf("shadowConfigDir = (%q, %v), want (%q, true)", got, ok, want)
	}
}

func setWindowsSystemRoot(t *testing.T, root string) {
	t.Helper()
	orig := windowsSystemRoot
	t.Cleanup(func() { windowsSystemRoot = orig })
	windowsSystemRoot = func() string { return root }
}

// The collector the backup runs (WindowsCollector.collectRegistry) takes the
// shadow path when its options carry a shadow copy of the system volume, and
// reads the files through the real openHiveSource (CreateFile with backup
// semantics).
func TestWindowsCollectRegistry_UnderVSSCopiesFromShadowNotRegExe(t *testing.T) {
	forbidRegSave(t)
	root := fakeShadowRoot(t, "SYSTEM", "SOFTWARE", "SAM", "SAM.LOG1", "SECURITY", "SECURITY.LOG2", "DEFAULT")
	vol := filepath.VolumeName(root)
	setWindowsSystemRoot(t, vol+`\Windows`)
	// The fake shadow root stands in for the device root of vol.
	c := &WindowsCollector{opts: CollectOptions{ShadowPaths: map[string]string{vol: root}}}

	staging := t.TempDir()
	arts, err := c.collectRegistry(staging)
	if err != nil {
		t.Fatalf("collectRegistry: %v", err)
	}
	byPath := artifactByPath(arts)
	for _, p := range []string{"registry/SYSTEM", "registry/SOFTWARE", "registry/SAM", "registry/SAM.LOG1",
		"registry/SECURITY", "registry/SECURITY.LOG2", "registry/DEFAULT"} {
		if _, ok := byPath[p]; !ok {
			t.Errorf("missing artifact %s (got %v)", p, byPath)
		}
	}
	if len(arts) != 7 {
		t.Errorf("artifacts = %d, want 7", len(arts))
	}
}

// TestLive_CollectRegistryFromRealShadowCopy copies all five hives, and their
// logs, out of a REAL shadow copy of the system volume through the production
// collector, with reg.exe forbidden. Run on a Defender-enabled host and check
// Get-MpThreatDetection before/after: this path must raise no detection,
// where `reg save HKLM\SAM|SECURITY` raises Trojan:Win32/Commando.A!ml.
//
//	set BREEZE_VSS_LIVE=1 && go test ./internal/backup/systemstate -run Live -v
func TestLive_CollectRegistryFromRealShadowCopy(t *testing.T) {
	if os.Getenv("BREEZE_VSS_LIVE") != "1" {
		t.Skip("set BREEZE_VSS_LIVE=1 to run live VSS tests (needs an elevated process)")
	}
	forbidRegSave(t)

	sysRoot := windowsSystemRoot()
	vol := filepath.VolumeName(sysRoot)
	p := vss.NewProvider(vss.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	session, err := p.CreateShadowCopy(ctx, []string{vol})
	if err != nil {
		t.Fatalf("CreateShadowCopy(%q): %v", vol, err)
	}
	defer p.ReleaseShadowCopy(session) //nolint:errcheck
	t.Logf("shadow paths: %v", session.ShadowPaths)

	c := &WindowsCollector{opts: CollectOptions{ShadowPaths: session.ShadowPaths}}
	staging := t.TempDir()
	arts, err := c.collectRegistry(staging)
	if err != nil {
		t.Fatalf("collectRegistry from the shadow copy: %v", err)
	}
	byPath := artifactByPath(arts)
	for _, h := range shadowRegistryHives {
		a, ok := byPath["registry/"+h]
		if !ok {
			t.Errorf("hive %s not captured", h)
			continue
		}
		b := make([]byte, 4)
		f, err := os.Open(filepath.Join(staging, "registry", h))
		if err != nil {
			t.Errorf("open staged %s: %v", h, err)
			continue
		}
		_, _ = f.Read(b)
		_ = f.Close()
		if string(b) != "regf" {
			t.Errorf("staged %s does not start with the regf hive signature: %q", h, b)
		}
		t.Logf("%s: %d bytes sha256=%s", h, a.SizeBytes, a.Checksum)
	}
	for _, a := range arts {
		if filepath.Ext(a.Path) == ".LOG1" || filepath.Ext(a.Path) == ".LOG2" {
			t.Logf("log %s: %d bytes", a.Path, a.SizeBytes)
		}
	}
}

// Review item 1: the Windows collector defaults SnapshotVolume to a real VSS
// snapshot, so CollectSystemState (IPC system_state_collect) and a backup's
// system_image run with no paths take their own shadow copy for the hives.
func TestNewCollector_DefaultsToOwnSystemVolumeSnapshot(t *testing.T) {
	c, ok := newCollector(CollectOptions{}).(*WindowsCollector)
	if !ok {
		t.Fatalf("newCollector returned %T", newCollector(CollectOptions{}))
	}
	if c.opts.SnapshotVolume == nil {
		t.Fatal("WindowsCollector has no SnapshotVolume: a run without a VSS session would spawn reg.exe save")
	}
	called := false
	custom := func(string) (map[string]string, func(), error) { called = true; return nil, nil, nil }
	c = newCollector(CollectOptions{SnapshotVolume: custom}).(*WindowsCollector)
	_, _, _ = c.opts.SnapshotVolume("C:")
	if !called {
		t.Error("an explicit SnapshotVolume was replaced by the default")
	}
}

// TestLive_SystemImageShapedCaptureTakesItsOwnShadowCopy is the shape of a
// Windows system_image run with no paths: no run-wide VSS session, the full
// production collector (CollectSystemStateWithOptions with zero options). The
// registry step must take and release its own shadow copy and never spawn
// reg.exe. Check Get-MpThreatDetection and `vssadmin list shadows` around it.
//
//	set BREEZE_VSS_LIVE=1 && go test ./internal/backup/systemstate -run Live -v
func TestLive_SystemImageShapedCaptureTakesItsOwnShadowCopy(t *testing.T) {
	if os.Getenv("BREEZE_VSS_LIVE") != "1" {
		t.Skip("set BREEZE_VSS_LIVE=1 to run live VSS tests (needs an elevated process)")
	}
	forbidRegSave(t)

	manifest, staging, err := CollectSystemStateWithOptions(CollectOptions{})
	if err != nil {
		t.Fatalf("CollectSystemStateWithOptions: %v", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	for _, s := range manifest.IncompleteSteps {
		if s == "registry" {
			t.Fatalf("registry step incomplete: %v", manifest.IncompleteSteps)
		}
	}
	byPath := artifactByPath(manifest.Artifacts)
	for _, h := range shadowRegistryHives {
		if _, ok := byPath["registry/"+h]; !ok {
			t.Errorf("hive %s not captured", h)
		}
	}
	var logs int
	for p := range byPath {
		if filepath.Ext(p) == ".LOG1" || filepath.Ext(p) == ".LOG2" {
			logs++
		}
	}
	t.Logf("captured %d registry artifacts (%d logs); incomplete non-required steps: %v",
		len(shadowRegistryHives), logs, manifest.IncompleteSteps)
	if logs == 0 {
		t.Error("no transaction logs captured alongside the hives")
	}
}
