package observe

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/security"
)

// TestNativeArchArm64UnderEmulation: the agent is built amd64 only and runs
// emulated on ARM64, where the process machine reads as AMD64. The native
// machine, not runtime.GOARCH and not the process machine, is what is reported.
func TestNativeArchArm64UnderEmulation(t *testing.T) {
	cases := []struct {
		process, native uint16
		want            string
	}{
		{machineAMD64, machineARM64, "arm64"},
		{0, machineAMD64, "amd64"},
		{machineI386, machineAMD64, "amd64"},
		{0, machineI386, "x86"},
		{0, 0x01c4, "unknown"}, // ARMNT
	}
	for _, c := range cases {
		host := healthyHost(t, BIOSInfo{}, nil)
		host.IsWow64Process2 = func() (uint16, uint16, error) { return c.process, c.native, nil }
		r := Collect(t.Context(), host, Request{Lane: LaneHP, ObserveLevel: LevelPassive}, "0.131.0")
		if r.NativeArch != c.want {
			t.Errorf("process %#x native %#x: nativeArch = %q, want %q", c.process, c.native, r.NativeArch, c.want)
		}
	}
	host := healthyHost(t, BIOSInfo{}, nil)
	host.IsWow64Process2 = func() (uint16, uint16, error) { return 0, 0, errFake }
	r := Collect(t.Context(), host, Request{Lane: LaneHP, ObserveLevel: LevelPassive}, "0.131.0")
	if r.NativeArch != "unknown" || !hasError(r, stepNativeArch, codeUnavailable) {
		t.Fatalf("unavailable call: nativeArch %q errors %+v", r.NativeArch, r.Errors)
	}
}

func TestBatteryFlag128And255Recorded(t *testing.T) {
	cases := []struct {
		in   PowerStatus
		want Power
	}{
		{PowerStatus{ACLineStatus: 1, BatteryFlag: 128, BatteryLifePercent: 255}, Power{ACLine: "on", BatteryFlag: new(128), BatteryPercent: new(255)}},
		{PowerStatus{ACLineStatus: 0, BatteryFlag: 255, BatteryLifePercent: 255}, Power{ACLine: "off", BatteryFlag: new(255), BatteryPercent: new(255)}},
		{PowerStatus{ACLineStatus: 255, BatteryFlag: 8, BatteryLifePercent: 87}, Power{ACLine: "unknown", BatteryFlag: new(8), BatteryPercent: new(87)}},
	}
	for _, c := range cases {
		host := healthyHost(t, BIOSInfo{}, nil)
		host.Power = func() (PowerStatus, error) { return c.in, nil }
		r := Collect(t.Context(), host, Request{Lane: LaneHP, ObserveLevel: LevelPassive}, "0.131.0")
		mustValid(t, r)
		if !reflect.DeepEqual(r.Power, c.want) {
			t.Errorf("%+v: power = %+v, want %+v", c.in, r.Power, c.want)
		}
	}
}

// TestPreflightLocalisedIsUnknown: manage-bde output in German has no English
// "PCR Validation Profile:" label. The shared Preflight calls that unknown, and
// observe reports pcr7Bound null with an identifier, never the output.
func TestPreflightLocalisedIsUnknown(t *testing.T) {
	host := healthyHost(t, BIOSInfo{}, nil)
	host.TPMProtectors = func(context.Context) (string, error) { return germanTPMListing, nil }
	r := Collect(t.Context(), host, Request{Lane: LaneHP, ObserveLevel: LevelPassive}, "0.131.0")
	mustValid(t, r)
	if r.BitLocker.Protection != "on" || r.BitLocker.PCR7Bound != nil || !hasError(r, stepBitLocker, "preflight_unknown") {
		t.Fatalf("bitlocker %+v errors %+v", r.BitLocker, r.Errors)
	}
	out, _ := json.Marshal(r)
	if strings.Contains(string(out), "Validierungsprofil") || strings.Contains(string(out), "11111111-2222") {
		t.Fatal("manage-bde output reached the result")
	}

	host.TPMProtectors = func(context.Context) (string, error) { return englishTPMListing, nil }
	r = Collect(t.Context(), host, Request{Lane: LaneHP, ObserveLevel: LevelPassive}, "0.131.0")
	if r.BitLocker.PCR7Bound == nil || !*r.BitLocker.PCR7Bound {
		t.Fatalf("english listing with PCR 7: pcr7Bound = %v", r.BitLocker.PCR7Bound)
	}
}

func TestBitLockerStates(t *testing.T) {
	escrowed := []string{"3c6c3b5e-0d1e-4a3e-9d0a-6f2f8c1b2a11"}
	cases := map[string]struct {
		state        string
		stateErr     error
		live         []string
		liveErr      error
		protectorsOK bool
		want         BitLocker
		code         string
	}{
		"on, escrowed (case, braces)": {state: "on", live: []string{"{3C6C3B5E-0D1E-4A3E-9D0A-6F2F8C1B2A11}"}, protectorsOK: true,
			want: BitLocker{Protection: "on", PCR7Bound: new(true), ActiveProtectorEscrowed: new(true)}},
		"on, not escrowed": {state: "on", live: []string{"00000000-0000-0000-0000-000000000000"}, protectorsOK: true,
			want: BitLocker{Protection: "on", PCR7Bound: new(true), ActiveProtectorEscrowed: new(false)}},
		"on, protectors unreadable": {state: "on", liveErr: errFake, protectorsOK: true,
			want: BitLocker{Protection: "on", PCR7Bound: new(true)}, code: "protectors_unreadable"},
		"suspended": {state: "suspended", live: []string{"00000000-0000-0000-0000-000000000000"},
			want: BitLocker{Protection: "suspended", ActiveProtectorEscrowed: new(false)}},
		"off": {state: "off",
			want: BitLocker{Protection: "off"}},
		"unreadable": {stateErr: errFake,
			want: BitLocker{Protection: "unknown"}, code: "state_unreadable"},
		"no bitlocker module": {state: "off", stateErr: security.ErrBitLockerUnavailable,
			want: BitLocker{Protection: "unknown"}, code: "bitlocker_unavailable"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			host := healthyHost(t, BIOSInfo{}, nil)
			host.BitLockerState = func() (string, error) { return c.state, c.stateErr }
			host.TPMProtectors = func(context.Context) (string, error) {
				if !c.protectorsOK {
					t.Fatal("manage-bde ran for a volume that is not on")
				}
				return englishTPMListing, nil
			}
			host.RecoveryProtectorIDs = func() ([]string, error) {
				if c.state == "off" || c.stateErr != nil {
					t.Fatal("recovery protectors read for a volume that is off or unreadable")
				}
				return c.live, c.liveErr
			}
			r := Collect(t.Context(), host, Request{Lane: LaneHP, ObserveLevel: LevelPassive, EscrowedProtectorIDs: escrowed}, "0.131.0")
			mustValid(t, r)
			if !reflect.DeepEqual(r.BitLocker, c.want) {
				t.Fatalf("bitlocker = %s, want %s", jsonOf(r.BitLocker), jsonOf(c.want))
			}
			if c.code != "" && !hasError(r, stepBitLocker, c.code) {
				t.Fatalf("errors = %+v, want %s", r.Errors, c.code)
			}
			if c.code == "" && hasStep(r, stepBitLocker) {
				t.Fatalf("unexpected bitlocker error: %+v", r.Errors)
			}
		})
	}
}

func TestCommonIdentityAndOSBuild(t *testing.T) {
	host := healthyHost(t, surfaceBIOS(), nil)
	host.OSVersion = func() (OSVersion, error) {
		return OSVersion{Major: 10, Minor: 0, HasMajorMinor: true, CurrentBuild: "26100", UBR: 2314, HasUBR: true}, nil
	}
	host.ChassisType = func() (int, error) { return 32, nil }
	r := Collect(t.Context(), host, Request{Lane: LaneSurface, ObserveLevel: LevelPassive}, "0.131.0")
	mustValid(t, r)
	if r.OSBuild == nil || *r.OSBuild != "10.0.26100.2314" {
		t.Fatalf("osBuild = %v", r.OSBuild)
	}
	if *r.SMBIOS.Model != "Surface Laptop, 7th Edition" || *r.SMBIOS.BaseboardProduct != "Surface Laptop" || *r.BIOS.ReleaseDate != "2026-08-14" {
		t.Fatalf("smbios %s bios %s", jsonOf(r.SMBIOS), jsonOf(r.BIOS))
	}
	if r.Chassis != "detachable" {
		t.Fatalf("chassis = %q", r.Chassis)
	}
	for code, want := range map[int]string{3: "desktop", 13: "all_in_one", 10: "laptop", 30: "tablet", 31: "convertible", 17: "other", 0: "unknown"} {
		if got := chassisOf(code); got != want {
			t.Errorf("chassisOf(%d) = %q, want %q", code, got, want)
		}
	}
}

func TestPathsReducedToLocationClass(t *testing.T) {
	c := &collector{host: healthyHost(t, BIOSInfo{}, nil)}
	cases := map[string]string{
		fakeProgramFiles + `\HP\HPIA\HPImageAssistant.exe`:                          LocationProgramFiles,
		`c:\program files\WindowsPowerShell\Modules\HPCMSL\1.8.1\x`:                 LocationProgramFiles,
		fakeProgramFilesX86 + `\Lenovo\System Update\tvsu.exe`:                      LocationProgramFiles,
		fakeProgramFiles + `\WindowsApps\E046963F.LenovoCompanion_1.0.0.0_x64__k\x`: LocationWindowsApps,
		fakeDataDir + `\oemupdates\hp-image-assistant\HPImageAssistant.exe`:         LocationAgentDir,
		`C:\Users\alice\Downloads\HPImageAssistant.exe`:                             LocationOther,
		`C:\Program Files Evil\HPImageAssistant.exe`:                                LocationOther,
		`C:/Program Files/HP/x.exe`:                                                 LocationProgramFiles,
		`\\server\share\HPImageAssistant.exe`:                                       LocationOther,
	}
	for path, want := range cases {
		if got := c.classifyLocation(path); got != want {
			t.Errorf("classifyLocation(%q) = %q, want %q", path, got, want)
		}
	}
	// No path ever reaches the wire: a result with every tool present carries
	// no drive letter, backslash or user directory.
	files := &fakeFS{
		files: map[string]string{
			hpiaAgentPath: "5.3.3.0",
			fakeProgramFilesX86 + `\Lenovo\System Update\tvsu.exe`: "5.08.03.59",
		},
		dirs: map[string][]string{fakeProgramFiles + `\WindowsPowerShell\Modules\HPCMSL`: {"1.8.1"}},
	}
	for _, lane := range []string{LaneHP, LaneLenovo} {
		r := Collect(t.Context(), healthyHost(t, lenovoBIOS(), files), Request{Lane: lane, ObserveLevel: LevelPassive}, "0.131.0")
		if len(r.Tools) == 0 {
			t.Fatalf("%s: no tools found", lane)
		}
		out := jsonOf(r)
		if regexp.MustCompile(`(?i)[a-z]:\\\\|program files|users|programdata|\\\\\\\\`).MatchString(out) {
			t.Fatalf("%s: a path reached the result: %s", lane, out)
		}
	}
}

// TestObserveWritesNoMarker: what this proves, and what it does not. Host has
// no Store and no seam that writes (TestHostHasNoWriteSeam), so the collector
// has nothing to write a marker with; and a collection over a real temp
// directory as the agent data directory leaves that directory exactly as it
// was. The production readers themselves are not run here (they are Windows
// only); the source check in observe_structure_test.go bans file-writing calls
// in this package, which covers them.
func TestObserveWritesNoMarker(t *testing.T) {
	data := t.TempDir()
	hpia := filepath.Join(data, HPIAStoreDir, HPIAToolDir)
	if err := os.MkdirAll(hpia, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hpia, HPIAExe), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := listTree(t, data)
	// The collector joins Windows paths, which drops the leading "/" of a POSIX
	// temp dir; map them back so every read really lands in data.
	local := func(p string) string {
		p = strings.ReplaceAll(p, `\`, "/")
		if !strings.HasPrefix(p, "/") {
			p = "/" + p
		}
		return p
	}
	reached := false
	host := healthyHost(t, hpBIOS(), nil)
	host.AgentDataDir = func() string { return data }
	host.RegularFile = func(p string) bool {
		info, err := os.Lstat(local(p))
		ok := err == nil && info.Mode().IsRegular()
		reached = reached || ok
		return ok
	}
	host.ListDirs = func(p string) ([]string, error) {
		entries, err := os.ReadDir(local(p))
		if err != nil {
			return nil, err
		}
		var out []string
		for _, e := range entries {
			if e.IsDir() {
				out = append(out, e.Name())
			}
		}
		return out, nil
	}
	for _, lane := range []string{LaneSurface, LaneHP, LaneLenovo} {
		Collect(t.Context(), host, Request{Lane: lane, ObserveLevel: LevelPassive}, "0.131.0")
	}
	if !reached {
		t.Fatal("the collector never read inside the data directory; the test proves nothing")
	}
	if after := listTree(t, data); !reflect.DeepEqual(before, after) {
		t.Fatalf("the agent data directory changed: before %v after %v", before, after)
	}
}

func TestHostHasNoWriteSeam(t *testing.T) {
	// Every seam is reviewed as a read. A new field fails here until it is
	// added to this list, which is the review.
	reviewedReads := setOf(
		"IsWow64Process2", "BIOSInfo", "OSVersion", "ChassisType", "Power", "BitLockerState",
		"TPMProtectors", "RecoveryProtectorIDs", "PendingReboot", "WindowsUpdateDisabled",
		"SearchDriverUpdates", "ExcludeWUDriversPolicy", "ProgramFiles", "ProgramFilesX86",
		"AgentDataDir", "RegularFile", "FileVersion", "Signer", "ListDirs", "ProgramEntries",
		"WMINamespaceExists", "Net",
	)
	// A name that starts with a write or run verb is refused even if listed.
	verb := regexp.MustCompile(`^(Install|Download|Write|Remove|Delete|Create|Suspend|Resume|Reboot|Exec|Run|Spawn|Set|Lock|Flash|Mark|Store|Apply|Start|Stop)`)
	for f := range reflect.TypeFor[Host]().Fields() {
		if !reviewedReads[f.Name] {
			t.Errorf("Host field %s is not in the reviewed list of reads", f.Name)
		}
		if verb.MatchString(f.Name) {
			t.Errorf("Host field %s names a write or run", f.Name)
		}
		if strings.Contains(f.Type.String(), "Store") || strings.Contains(f.Type.String(), "DriverInstallOutcome") {
			t.Errorf("Host field %s has type %s", f.Name, f.Type)
		}
	}
	// Positive control: the same checks catch a seam named like a write.
	if !verb.MatchString("InstallDriverUpdates") || !verb.MatchString("WriteMarker") || reviewedReads["InstallDriverUpdates"] {
		t.Fatal("the check does not catch what it is for")
	}
}

func listTree(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		out = append(out, p)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func hasStep(r Result, step string) bool {
	for _, e := range r.Errors {
		if e.Step == step {
			return true
		}
	}
	return false
}

func jsonOf(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
