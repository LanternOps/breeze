package security

import (
	"errors"
	"runtime"
	"strings"
	"testing"
)

// fakeMacCylanceHost is an in-memory macOS host for the Cylance probe (#9390),
// so detection is exercised on every OS without a real app bundle.
type fakeMacCylanceHost struct {
	files         map[string]bool
	bundleKeys    map[string]string // Info.plist key -> value for macCylanceAppPath
	bundleErr     error             // returned for every Info.plist read when set
	daemonRunning bool
	procRunning   bool
}

func (h fakeMacCylanceHost) probes() macCylanceProbes {
	return macCylanceProbes{
		fileExists: func(path string) bool { return h.files[path] },
		bundleString: func(appPath, key string) (string, error) {
			if appPath != macCylanceAppPath {
				return "", errors.New("unexpected bundle path " + appPath)
			}
			if h.bundleErr != nil {
				return "", h.bundleErr
			}
			value, ok := h.bundleKeys[key]
			if !ok {
				return "", errors.New("key not found: " + key)
			}
			return value, nil
		},
		daemonRunning:  func(label string) bool { return h.daemonRunning && label == macCylanceDaemonLabel },
		processRunning: func(name string) bool { return h.procRunning && name == macCylanceServiceProcess },
	}
}

func TestDetectMacCylance(t *testing.T) {
	appAndDaemon := map[string]bool{macCylanceAppPath: true, macCylanceDaemonPlist: true}

	cases := []struct {
		name         string
		host         fakeMacCylanceHost
		wantDetected bool
		wantDisplay  string
		wantVersion  string
		wantRTP      bool
		wantPath     string
	}{
		{
			// The reporter's macOS fleet on #9178: still branded CylancePROTECT.
			name: "old-name bundle, daemon running",
			host: fakeMacCylanceHost{
				files:         appAndDaemon,
				bundleKeys:    map[string]string{"CFBundleName": "CylanceUI", "CFBundleShortVersionString": "3.1.1001"},
				daemonRunning: true,
			},
			wantDetected: true, wantDisplay: "CylancePROTECT", wantVersion: "3.1.1001", wantRTP: true,
			wantPath: macCylanceAppPath,
		},
		{
			// Arctic Wolf's rebrand: the bundle names itself Aurora.
			name: "new-name (Aurora) bundle",
			host: fakeMacCylanceHost{
				files: appAndDaemon,
				bundleKeys: map[string]string{
					"CFBundleName":               "CylanceUI",
					"CFBundleDisplayName":        "Aurora Protect Desktop",
					"CFBundleShortVersionString": "3.3.1000",
				},
				daemonRunning: true,
			},
			wantDetected: true, wantDisplay: "Aurora Endpoint Defense", wantVersion: "3.3.1000", wantRTP: true,
			wantPath: macCylanceAppPath,
		},
		{
			name: "aurora in CFBundleName only",
			host: fakeMacCylanceHost{
				files:       appAndDaemon,
				bundleKeys:  map[string]string{"CFBundleName": "AuroraUI"},
				procRunning: true,
			},
			wantDetected: true, wantDisplay: "Aurora Endpoint Defense", wantRTP: true,
			wantPath: macCylanceAppPath,
		},
		{
			name:         "neither bundle nor daemon",
			host:         fakeMacCylanceHost{files: map[string]bool{}},
			wantDetected: false,
		},
		{
			// Info.plist unreadable: still attributed, version simply empty.
			name: "version read failure",
			host: fakeMacCylanceHost{
				files:         appAndDaemon,
				bundleErr:     errors.New("defaults: domain does not exist"),
				daemonRunning: true,
			},
			wantDetected: true, wantDisplay: "CylancePROTECT", wantVersion: "", wantRTP: true,
			wantPath: macCylanceAppPath,
		},
		{
			// UI app removed or relocated, protection daemon still installed.
			name:         "daemon plist only",
			host:         fakeMacCylanceHost{files: map[string]bool{macCylanceDaemonPlist: true}, daemonRunning: true},
			wantDetected: true, wantDisplay: "CylancePROTECT", wantRTP: true,
		},
		{
			name: "installed but service stopped",
			host: fakeMacCylanceHost{
				files:      appAndDaemon,
				bundleKeys: map[string]string{"CFBundleShortVersionString": "3.1.1001"},
			},
			wantDetected: true, wantDisplay: "CylancePROTECT", wantVersion: "3.1.1001", wantRTP: false,
			wantPath: macCylanceAppPath,
		},
		{
			// The process check covers a relabelled launchd job, but only
			// alongside an install artifact.
			name:         "service process running, daemon job not visible",
			host:         fakeMacCylanceHost{files: map[string]bool{macCylanceDaemonPlist: true}, procRunning: true},
			wantDetected: true, wantDisplay: "CylancePROTECT", wantRTP: true,
		},
		{
			// A process name alone is spoofable by any local user (running a
			// binary named CylanceSvc), so it must never attribute Cylance or
			// report real-time protection without an install artifact.
			name:         "service process running with no bundle or plist",
			host:         fakeMacCylanceHost{files: map[string]bool{}, procRunning: true},
			wantDetected: false,
		},
		{
			// Same for a launchd job reading as running with nothing installed.
			name:         "daemon job running with no bundle or plist",
			host:         fakeMacCylanceHost{files: map[string]bool{}, daemonRunning: true},
			wantDetected: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			product, version, err := detectMacCylance(tc.host.probes())
			if !tc.wantDetected {
				if !errors.Is(err, ErrNotSupported) {
					t.Fatalf("err = %v, want ErrNotSupported", err)
				}
				if product != nil {
					t.Fatalf("product = %+v, want nil", product)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if product == nil {
				t.Fatal("product = nil, want a Cylance product")
			}
			if product.Provider != "cylance" {
				t.Errorf("provider = %q, want cylance", product.Provider)
			}
			if product.DisplayName != tc.wantDisplay {
				t.Errorf("displayName = %q, want %q", product.DisplayName, tc.wantDisplay)
			}
			if version != tc.wantVersion {
				t.Errorf("version = %q, want %q", version, tc.wantVersion)
			}
			if product.RealTimeProtection != tc.wantRTP {
				t.Errorf("realTimeProtection = %v, want %v", product.RealTimeProtection, tc.wantRTP)
			}
			if !product.Registered {
				t.Error("registered = false, want true")
			}
			if product.PathToSignedProduct != tc.wantPath {
				t.Errorf("pathToSignedProduct = %q, want %q", product.PathToSignedProduct, tc.wantPath)
			}
		})
	}
}

func TestGetMacCylanceProductNonDarwin(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("darwin host: the probe runs for real")
	}
	if _, _, err := getMacCylanceProduct(); !errors.Is(err, ErrNotSupported) {
		t.Fatalf("err = %v, want ErrNotSupported off macOS", err)
	}
}

func TestLaunchctlPrintRunning(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   bool
	}{
		{"running", "system/com.cylance.agent_service = {\n\tactive count = 1\n\tstate = running\n\tpid = 412\n}", true},
		{"loaded but not running", "system/com.cylance.agent_service = {\n\tstate = not running\n}", false},
		{"spawn scheduled", "system/com.cylance.agent_service = {\n\tstate = spawn scheduled\n}", false},
		{"empty", "", false},
		// A nested endpoint block's state must not be read as the job's.
		{"nested state only", "system/x = {\n\tendpoints = {\n\t\t\"x\" = {\n\t\t\tstate = running\n\t\t}\n\t}\n\tstate = not running\n}", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := launchctlPrintRunning(tc.output); got != tc.want {
				t.Fatalf("launchctlPrintRunning = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestMacDefenderClaimsProvider pins the macOS attribution order: Cylance is
// probed first, and Microsoft Defender only takes the provider label under the
// same rule the Windows Defender fallback uses (#3593).
func TestMacDefenderClaimsProvider(t *testing.T) {
	enabledRTP := DefenderStatus{Enabled: true, RealTimeProtection: true}
	enabledNoRTP := DefenderStatus{Enabled: true}
	disabled := DefenderStatus{}

	cases := []struct {
		name               string
		providerIdentified bool
		currentRealTime    bool
		defender           DefenderStatus
		want               bool
	}{
		{"defender alone, enabled", false, false, enabledNoRTP, true},
		{"defender alone, not enabled", false, false, disabled, false},
		{"cylance active, defender active", true, true, enabledRTP, false},
		{"cylance active, defender passive", true, true, enabledNoRTP, false},
		{"cylance stopped, defender active", true, false, enabledRTP, true},
		{"cylance stopped, defender passive", true, false, enabledNoRTP, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := macDefenderClaimsProvider(tc.providerIdentified, tc.currentRealTime, tc.defender); got != tc.want {
				t.Fatalf("macDefenderClaimsProvider = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestApplyMacAVSources pins the CollectStatus macOS merge end to end:
// provider, providerVersion, real-time protection, AVProducts and the
// collected/failed tallies for each Cylance × Defender combination.
func TestApplyMacAVSources(t *testing.T) {
	cylance := func(running bool) *AVProduct {
		return &AVProduct{DisplayName: macCylanceDisplayName, Provider: "cylance", Registered: true, RealTimeProtection: running}
	}
	defenderProduct := &AVProduct{DisplayName: "Microsoft Defender for Endpoint", Provider: "windows_defender"}
	defenderPassive := DefenderStatus{Enabled: true, ProviderVersion: "101.24012"}
	defenderActive := DefenderStatus{Enabled: true, RealTimeProtection: true, ProviderVersion: "101.24012"}

	cases := []struct {
		name          string
		src           macAVSources
		wantProvider  string
		wantVersion   string
		wantRealTime  bool
		wantProducts  []string
		wantCollected bool
		wantFailed    bool
		wantErrs      int
	}{
		{
			name:         "cylance running, defender passive",
			src:          macAVSources{cylance: cylance(true), cylanceVersion: "3.1.1001", defender: defenderPassive, defenderProduct: defenderProduct},
			wantProvider: "cylance", wantVersion: "3.1.1001", wantRealTime: true,
			wantProducts: []string{"cylance", "windows_defender"}, wantCollected: true,
		},
		{
			name:         "cylance running, defender active",
			src:          macAVSources{cylance: cylance(true), cylanceVersion: "3.1.1001", defender: defenderActive, defenderProduct: defenderProduct},
			wantProvider: "cylance", wantVersion: "3.1.1001", wantRealTime: true,
			wantProducts: []string{"cylance", "windows_defender"}, wantCollected: true,
		},
		{
			name:         "cylance stopped, defender active",
			src:          macAVSources{cylance: cylance(false), cylanceVersion: "3.1.1001", defender: defenderActive, defenderProduct: defenderProduct},
			wantProvider: "windows_defender", wantVersion: "101.24012", wantRealTime: true,
			wantProducts: []string{"cylance", "windows_defender"}, wantCollected: true,
		},
		{
			// Daemon-only / unreadable Info.plist: Cylance owns the label with
			// no version, and Defender's version must not fill it.
			name:         "cylance without version, defender passive",
			src:          macAVSources{cylance: cylance(true), defender: defenderPassive, defenderProduct: defenderProduct},
			wantProvider: "cylance", wantVersion: "", wantRealTime: true,
			wantProducts: []string{"cylance", "windows_defender"}, wantCollected: true,
		},
		{
			name:         "defender only, passive",
			src:          macAVSources{cylanceErr: ErrNotSupported, defender: defenderPassive, defenderProduct: defenderProduct},
			wantProvider: "windows_defender", wantVersion: "101.24012", wantRealTime: false,
			wantProducts: []string{"windows_defender"}, wantCollected: true,
		},
		{
			// Pre-#9390 behaviour kept: an installed-but-disabled Defender
			// leaves the provider "other" yet still fills the version.
			name:         "defender only, not enabled",
			src:          macAVSources{cylanceErr: ErrNotSupported, defender: DefenderStatus{ProviderVersion: "101.24012"}},
			wantProvider: "other", wantVersion: "101.24012", wantCollected: true,
		},
		{
			name:         "neither installed",
			src:          macAVSources{cylanceErr: ErrNotSupported, defenderErr: ErrNotSupported},
			wantProvider: "other",
		},
		{
			name:         "cylance running, defender probe errors",
			src:          macAVSources{cylance: cylance(true), cylanceVersion: "3.1.1001", defenderErr: errors.New("mdatp health failed")},
			wantProvider: "cylance", wantVersion: "3.1.1001", wantRealTime: true,
			wantProducts: []string{"cylance"}, wantCollected: true, wantFailed: true, wantErrs: 1,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status := SecurityStatus{Provider: "other"}
			var tally avTally
			applyMacAVSources(&status, &tally, tc.src)

			if status.Provider != tc.wantProvider {
				t.Errorf("provider = %q, want %q", status.Provider, tc.wantProvider)
			}
			if status.ProviderVersion != tc.wantVersion {
				t.Errorf("providerVersion = %q, want %q", status.ProviderVersion, tc.wantVersion)
			}
			if tally.realTime != tc.wantRealTime {
				t.Errorf("realTime = %v, want %v", tally.realTime, tc.wantRealTime)
			}
			if tally.collected != tc.wantCollected || tally.failed != tc.wantFailed {
				t.Errorf("collected/failed = %v/%v, want %v/%v", tally.collected, tally.failed, tc.wantCollected, tc.wantFailed)
			}
			if len(tally.errs) != tc.wantErrs {
				t.Errorf("errs = %v, want %d", tally.errs, tc.wantErrs)
			}
			var gotProducts []string
			for _, p := range status.AVProducts {
				gotProducts = append(gotProducts, p.Provider)
			}
			if strings.Join(gotProducts, ",") != strings.Join(tc.wantProducts, ",") {
				t.Errorf("avProducts = %v, want %v", gotProducts, tc.wantProducts)
			}
		})
	}
}
