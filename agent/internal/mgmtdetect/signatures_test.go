package mgmtdetect

import (
	"runtime"
	"strings"
	"testing"
)

func TestSignaturesNotEmpty(t *testing.T) {
	sigs := AllSignatures()
	if len(sigs) == 0 {
		t.Fatal("signature database should not be empty")
	}
}

func TestSignaturesHaveRequiredFields(t *testing.T) {
	for _, sig := range AllSignatures() {
		if sig.Name == "" {
			t.Error("signature missing name")
		}
		if sig.Category == "" {
			t.Errorf("signature %s missing category", sig.Name)
		}
		if len(sig.OS) == 0 {
			t.Errorf("signature %s missing OS", sig.Name)
		}
		if len(sig.Checks) == 0 {
			t.Errorf("signature %s has no checks", sig.Name)
		}
	}
}

func TestSignaturesForCurrentOS(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("management tool signatures target windows/darwin endpoints only")
	}
	count := 0
	for _, sig := range AllSignatures() {
		if sig.MatchesOS(runtime.GOOS) {
			count++
		}
	}
	if count == 0 {
		t.Errorf("no signatures match current OS %s", runtime.GOOS)
	}
	t.Logf("%d signatures match %s", count, runtime.GOOS)
}

func TestSignatureChecksHaveFirstActiveCheck(t *testing.T) {
	activeTypes := map[CheckType]bool{
		CheckServiceRunning: true,
		CheckProcessRunning: true,
	}
	for _, sig := range AllSignatures() {
		first := sig.Checks[0]
		if !activeTypes[first.Type] {
			t.Errorf("signature %s leads with %s instead of active-state check", sig.Name, first.Type)
		}
	}
}

// TestEndpointSecuritySignatures_AVProviders locks the endpoint-security
// signatures for the AV/EDR products added in #7551. Each row lists every probe
// of the signature, in order; a probe is matched on type, value and OS so a typo
// in a service or process name fails here, not on a fleet.
func TestEndpointSecuritySignatures_AVProviders(t *testing.T) {
	cases := []struct {
		name   string
		os     []string
		probes []Check
	}{
		{
			name: "ESET",
			os:   []string{"windows", "darwin"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "ekrn", OS: "windows"},
				{Type: CheckProcessRunning, Value: "ekrn.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "esets_daemon", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\ESET\ESET Security\ekrn.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/ESET", OS: "darwin"},
			},
		},
		{
			name: "Emsisoft",
			os:   []string{"windows"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "a2AntiMalware", OS: "windows"},
				{Type: CheckProcessRunning, Value: "a2service.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files\Emsisoft Anti-Malware\a2service.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Emsisoft Anti-Malware\a2service.exe`, OS: "windows"},
			},
		},
		{
			name: "Webroot SecureAnywhere",
			os:   []string{"windows", "darwin"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "WRSVC", OS: "windows"},
				{Type: CheckProcessRunning, Value: "WRSA.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files\Webroot\WRSA.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Webroot\WRSA.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/Webroot SecureAnywhere.app", OS: "darwin"},
			},
		},
		{
			name: "ThreatDown",
			os:   []string{"windows", "darwin"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "MBEndpointAgent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "MBCloudEA.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "EndpointAgentDaemon", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Malwarebytes Endpoint Agent\MBCloudEA.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/Application Support/Malwarebytes/Malwarebytes Endpoint Agent", OS: "darwin"},
			},
		},
		{
			name: "WithSecure Elements",
			os:   []string{"windows"},
			probes: []Check{
				{Type: CheckProcessRunning, Value: "fshoster64.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "fshoster32.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\F-Secure\PSB`, OS: "windows"},
			},
		},
	}

	byName := map[string]Signature{}
	for _, sig := range AllSignatures() {
		if _, dup := byName[sig.Name]; dup && sig.Category == CategoryEndpointSecurity {
			t.Errorf("duplicate endpoint-security signature name %q", sig.Name)
		}
		byName[sig.Name] = sig
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sig, ok := byName[tc.name]
			if !ok {
				t.Fatalf("no signature named %q", tc.name)
			}
			if sig.Category != CategoryEndpointSecurity {
				t.Errorf("category = %q, want %q", sig.Category, CategoryEndpointSecurity)
			}
			for _, goos := range tc.os {
				if !sig.MatchesOS(goos) {
					t.Errorf("signature does not cover %s", goos)
				}
			}
			if len(sig.Checks) != len(tc.probes) {
				t.Fatalf("signature has %d probes, test lists %d — keep the table complete", len(sig.Checks), len(tc.probes))
			}
			for i, probe := range tc.probes {
				if c := sig.Checks[i]; c.Type != probe.Type || c.Value != probe.Value || c.OS != probe.OS {
					t.Errorf("probe %d = %s %q (os %q), want %s %q (os %q)", i, c.Type, c.Value, c.OS, probe.Type, probe.Value, probe.OS)
				}
			}
			// Every per-check OS must be one the signature declares, or the
			// probe can never run.
			for _, c := range sig.Checks {
				if c.OS != "" && !sig.MatchesOS(c.OS) {
					t.Errorf("probe %q targets %s, which the signature does not cover", c.Value, c.OS)
				}
			}
		})
	}
}

// genericProcessNames are process names shared by many unrelated products.
// Matching on them alone (no path check) produces false positives (#8084).
var genericProcessNames = []string{"agent", "agent.exe", "service.exe", "client.exe", "daemon"}

func TestSignaturesAvoidGenericProcessNames(t *testing.T) {
	denied := make(map[string]bool, len(genericProcessNames))
	for _, n := range genericProcessNames {
		denied[strings.ToLower(n)] = true
	}
	for _, sig := range AllSignatures() {
		for _, c := range sig.Checks {
			if c.Type == CheckProcessRunning && denied[strings.ToLower(c.Value)] {
				t.Errorf("signature %s uses generic process name %q (%s); process checks match by name only, use a service, path or launch-daemon check", sig.Name, c.Value, c.OS)
			}
		}
	}
}

// Regression for #8084: an unrelated product's agent.exe / agent process must
// not make N-able show as active. The data-level assertion holds on every host
// OS; the behavioral one exercises the real dispatcher for the host OS.
func TestNableNotDetectedFromGenericAgentProcess(t *testing.T) {
	var nable *Signature
	for _, sig := range AllSignatures() {
		if sig.Name == "N-able" {
			s := sig
			nable = &s
		}
	}
	if nable == nil {
		t.Fatal("N-able signature not found")
	}

	for _, c := range nable.Checks {
		if c.Type == CheckProcessRunning {
			t.Errorf("N-able must not have a process check, found %q (%s)", c.Value, c.OS)
		}
	}

	// Hermetic: drop the host-state probes (service, file, launch daemon,
	// registry, command) so real N-able artifacts on the machine running the
	// test cannot match. Only the injected process snapshot can detect.
	hermetic := *nable
	hermetic.Checks = nil
	for _, c := range nable.Checks {
		if c.Type == CheckProcessRunning {
			hermetic.Checks = append(hermetic.Checks, c)
		}
	}

	snap := &processSnapshot{names: map[string]bool{"agent.exe": true, "agent": true}}
	d := &checkDispatcher{processSnap: snap}
	if det, ok := evaluateSignature(d, hermetic); ok {
		t.Errorf("N-able detected from generic agent process on %s: %+v", runtime.GOOS, det)
	}

	// Positive control: the same snapshot DOES activate a signature that has a
	// process check for the host OS, so the assertion above is not vacuous
	// plumbing (an empty signature never reaches the dispatcher).
	control := Signature{
		Name: "control", Category: CategoryRMM, OS: []string{runtime.GOOS},
		Checks: []Check{{Type: CheckProcessRunning, Value: "agent", OS: runtime.GOOS}},
	}
	if det, ok := evaluateSignature(d, control); !ok || det.Status != StatusActive {
		t.Errorf("positive control: process snapshot did not activate a process check (ok=%v det=%+v)", ok, det)
	}
}
