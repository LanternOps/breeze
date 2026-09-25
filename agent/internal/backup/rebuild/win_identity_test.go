package rebuild

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/winhive"
	"gopkg.in/yaml.v3"
)

// newWinIdentityRun: a run whose SYSTEM/SOFTWARE hives are already loaded
// (as after the restore phase) and whose restored root VOLUME has agent
// config (ruling C1). rootDir is a separate, empty folder: anything the
// phase reads or writes there instead of the volume is a bug the tests see.
func newWinIdentityRun(t *testing.T, sysFake *fakeWinSystem) *run {
	t.Helper()
	dir := t.TempDir()
	rootVolume := filepath.Join(dir, "vol-root")
	breeze := filepath.Join(rootVolume, "ProgramData", "Breeze")
	if err := os.MkdirAll(filepath.Join(breeze, "data"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(breeze, "agent.yaml"), []byte("agent_id: old\nserver_url: https://example.invalid\norg_id: org-1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(breeze, "secrets.yaml"), []byte("auth_token: t\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rootDir := filepath.Join(dir, "mnt", "root")
	if err := os.MkdirAll(rootDir, 0o700); err != nil {
		t.Fatal(err)
	}
	sets, err := winhive.ControlSets(sysFake.hives["SYSTEM"])
	if err != nil {
		t.Fatal(err)
	}
	return &run{
		opts:       Options{Identity: IdentityNew, SnapshotID: "snap1", WinSystem: sysFake, Target: Target{Kind: TargetVHDX, Path: "x.vhdx"}},
		rootVolume: rootVolume, rootDir: rootDir, result: &Result{}, layout: testLayoutWindows(),
		hives:       map[string]winhive.Handle{"SYSTEM": sysFake.hives["SYSTEM"], "SOFTWARE": sysFake.hives["SOFTWARE"]},
		controlSets: sets,
	}
}

func breezeDir(r *run) string { return filepath.Join(r.rootVolume, "ProgramData", "Breeze") }

func assertRootDirUntouched(t *testing.T, r *run) {
	t.Helper()
	entries, err := os.ReadDir(r.rootDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("the phase wrote through the rootDir folder mount (ruling C1): %v", entries)
	}
}

func computerName(t *testing.T, sys *fakeWinSystem, controlSet string) string {
	t.Helper()
	cn, err := sys.hives["SYSTEM"].OpenKey(controlSet + `\Control\ComputerName\ComputerName`)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := cn.GetString("ComputerName")
	return v
}

// R21.
func TestWinIdentity_NewRenamesRotatesMachineGuidStripsEnrollment(t *testing.T) {
	sys := newFakeWinSystem(t.TempDir())
	seedFakeHives(sys) // ComputerName FILESERVER01 in ControlSet001
	r := newWinIdentityRun(t, sys)
	if err := winIdentity(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if v := computerName(t, sys, "ControlSet001"); v != "FILESE-RESTORED" {
		t.Fatalf("ComputerName = %q", v)
	}
	tcpip, _ := sys.hives["SYSTEM"].OpenKey(`ControlSet001\Services\Tcpip\Parameters`)
	for _, name := range []string{"Hostname", "NV Hostname"} {
		if v, _ := tcpip.GetString(name); v != "FILESE-RESTORED" {
			t.Fatalf("%s = %q", name, v)
		}
	}
	crypto, _ := sys.hives["SOFTWARE"].OpenKey(`Microsoft\Cryptography`)
	if v, _ := crypto.GetString("MachineGuid"); len(v) != 36 {
		t.Fatalf("MachineGuid = %q", v)
	}
	if _, err := os.Stat(filepath.Join(breezeDir(r), "secrets.yaml")); !os.IsNotExist(err) {
		t.Fatal("secrets.yaml must be deleted")
	}
	b, _ := os.ReadFile(filepath.Join(breezeDir(r), "agent.yaml"))
	var doc map[string]any
	if err := yaml.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc["agent_id"]; ok {
		t.Fatal("agent_id must be stripped")
	}
	if doc["org_id"] != "org-1" {
		t.Fatalf("org_id must survive: %v", doc)
	}
	assertRootDirUntouched(t, r)
}

// R19: both control sets renamed when Select\Current differs.
func TestWinIdentity_EditsBothControlSets(t *testing.T) {
	sys := newFakeWinSystem(t.TempDir())
	seedFakeHives(sys)
	sel, _ := sys.hives["SYSTEM"].OpenKey("Select")
	_ = sel.SetDWORD("Current", 2)
	_, _ = sys.hives["SYSTEM"].CreateKey(`ControlSet002\Services`)
	r := newWinIdentityRun(t, sys)
	if err := winIdentity(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	for _, cs := range []string{"ControlSet001", "ControlSet002"} {
		if v := computerName(t, sys, cs); v != "FILESE-RESTORED" {
			t.Fatalf("%s ComputerName = %q", cs, v)
		}
	}
}

// Ruling C5: a resumed run (restore skipped) or one after winBoot closed
// them loads the hives itself, and leaves them loaded for validate.
func TestWinIdentity_LoadsHivesWhenRestoreWasSkipped(t *testing.T) {
	sys := newFakeWinSystem(t.TempDir())
	seedFakeHives(sys)
	r := newWinIdentityRun(t, sys)
	r.hives, r.controlSets = nil, nil
	if err := winIdentity(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	loads := countCalls(sys.cmds, "LoadHive")
	if len(loads) != 2 || r.hives["SYSTEM"] == nil || r.hives["SOFTWARE"] == nil {
		t.Fatalf("expected SYSTEM and SOFTWARE loaded and kept: %v", sys.cmds)
	}
	for _, l := range loads {
		if !strings.HasPrefix(l, "LoadHive "+r.rootVolume) {
			t.Fatalf("hive loaded from outside the root volume: %q", l)
		}
	}
	if v := computerName(t, sys, "ControlSet001"); v != "FILESE-RESTORED" {
		t.Fatalf("ComputerName = %q", v)
	}
}

// Ruling C8 / F13: an empty hive name falls back to the layout manifest's
// hostname, else the bare RESTORED — never "-RESTORED".
func TestWinIdentity_EmptyComputerNameFallsBack(t *testing.T) {
	for _, tc := range []struct {
		name, manifestHost, want string
	}{
		{"manifest hostname", "FILESERVER01", "FILESE-RESTORED"},
		{"no hostname anywhere", "", "RESTORED"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sys := newFakeWinSystem(t.TempDir())
			seedFakeHives(sys)
			cn, _ := sys.hives["SYSTEM"].OpenKey(`ControlSet001\Control\ComputerName\ComputerName`)
			if err := cn.DeleteValue("ComputerName"); err != nil {
				t.Fatal(err)
			}
			r := newWinIdentityRun(t, sys)
			r.layout.Hostname = tc.manifestHost
			if err := winIdentity(context.Background(), r); err != nil {
				t.Fatal(err)
			}
			if v := computerName(t, sys, "ControlSet001"); v != tc.want {
				t.Fatalf("ComputerName = %q, want %q", v, tc.want)
			}
		})
	}
}

// Global Constraint "Identity" original: the marker lands where the restored
// agent's heartbeat.LoadRecoveryMarker(config.GetDataDir()) reads it on
// Windows — <root volume>\ProgramData\Breeze\data — and nothing else changes.
func TestWinIdentity_OriginalWritesMarker(t *testing.T) {
	sys := newFakeWinSystem(t.TempDir())
	seedFakeHives(sys)
	r := newWinIdentityRun(t, sys)
	r.opts.Identity = IdentityOriginal
	r.opts.Marker = &Marker{RecoveryID: "rec-1", Nonce: "n-1"}
	if err := winIdentity(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(breezeDir(r), "data", "recovery-marker.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]string
	_ = json.Unmarshal(b, &m)
	if m["recoveryId"] != "rec-1" || m["nonce"] != "n-1" || m["snapshotId"] != "snap1" || m["completedAt"] == "" {
		t.Fatalf("marker = %v", m)
	}
	if v := computerName(t, sys, "ControlSet001"); v != "FILESERVER01" {
		t.Fatalf("original identity renamed the machine: %q", v)
	}
	if _, err := os.Stat(filepath.Join(breezeDir(r), "secrets.yaml")); err != nil {
		t.Fatalf("original identity must keep secrets.yaml: %v", err)
	}
	assertRootDirUntouched(t, r)
}

func TestWinIdentity_OriginalWithoutMarkerWarns(t *testing.T) {
	sys := newFakeWinSystem(t.TempDir())
	seedFakeHives(sys)
	r := newWinIdentityRun(t, sys)
	r.opts.Identity = IdentityOriginal
	if err := winIdentity(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if len(r.warnings) != 1 || r.warnings[0] != "no recovery marker given; the server will not auto-complete this recovery" {
		t.Fatalf("warnings = %v", r.warnings)
	}
}

// F1: a full fake run strips the RESTORED volume's agent.yaml and deletes
// its secrets.yaml — not an empty directory under the folder mount.
func TestWinRun_NewIdentityEditsRestoredVolume(t *testing.T) {
	withHostPlatformWindows(t)
	opts, sys := winFakeOptions(t, t.TempDir())
	addWindowsSnapshotFile(t, opts.Provider.(*memProvider), "win-1", "ProgramData/Breeze/secrets.yaml", []byte("auth_token: t\n"))
	res, err := Run(context.Background(), opts)
	if err != nil || res.Status != "completed" {
		t.Fatalf("res=%+v err=%v", res, err)
	}
	if !phaseCompleted(res, PhaseIdentity) {
		t.Fatalf("identity phase did not complete: %+v", res.Phases)
	}
	breeze := filepath.Join(sys.volumeDirForPartition(t, 3), "ProgramData", "Breeze")
	b, err := os.ReadFile(filepath.Join(breeze, "agent.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc["agent_id"]; ok {
		t.Fatalf("agent_id not stripped from the restored volume: %v", doc)
	}
	if _, ok := doc["device_id"]; ok {
		t.Fatalf("device_id not stripped from the restored volume: %v", doc)
	}
	if doc["server_url"] != "https://example.invalid" {
		t.Fatalf("server_url must survive: %v", doc)
	}
	if _, err := os.Stat(filepath.Join(breeze, "secrets.yaml")); !os.IsNotExist(err) {
		t.Fatalf("secrets.yaml not deleted from the restored volume: %v", err)
	}
	if v := computerName(t, sys, "ControlSet001"); v != "FILESE-RESTORED" {
		t.Fatalf("ComputerName = %q", v)
	}
}

// addWindowsSnapshotFile adds one file to a seedWindowsSnapshot snapshot.
func addWindowsSnapshotFile(t *testing.T, p *memProvider, id, rel string, content []byte) {
	t.Helper()
	key := "snapshots/" + id + "/manifest.json"
	var man backup.Snapshot
	if err := json.Unmarshal(p.files[key], &man); err != nil {
		t.Fatal(err)
	}
	backupKey := "snapshots/" + id + "/files/path_0/" + rel
	p.files[backupKey] = content
	tmpl := man.Files[0]
	tmpl.SourcePath = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1/` + rel
	tmpl.OriginalPath = "C:/" + rel
	tmpl.BackupPath, tmpl.Size, tmpl.Checksum = backupKey, int64(len(content)), sum(content)
	man.Files = append(man.Files, tmpl)
	b, _ := json.Marshal(man)
	p.files[key] = b
}
