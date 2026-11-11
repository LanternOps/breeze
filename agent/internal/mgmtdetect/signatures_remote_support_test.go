package mgmtdetect

import "testing"

type signatureProbeCase struct {
	name     string
	category Category
	os       []string
	probes   []Check
}

// assertSignatureProbes checks that each case's signature exists with exactly
// the listed probes, in order, matched on type, value and OS.
func assertSignatureProbes(t *testing.T, cases []signatureProbeCase) {
	t.Helper()
	byName := map[string]Signature{}
	for _, sig := range AllSignatures() {
		if _, dup := byName[sig.Name]; dup && (sig.Category == CategoryRMM || sig.Category == CategoryRemoteAccess) {
			t.Errorf("duplicate signature name %q", sig.Name)
		}
		byName[sig.Name] = sig
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sig, ok := byName[tc.name]
			if !ok {
				t.Fatalf("no signature named %q", tc.name)
			}
			if sig.Category != tc.category {
				t.Errorf("category = %q, want %q", sig.Category, tc.category)
			}
			if len(sig.OS) != len(tc.os) {
				t.Errorf("OS = %v, want %v", sig.OS, tc.os)
			}
			for _, goos := range tc.os {
				if !sig.MatchesOS(goos) {
					t.Errorf("signature does not cover %s", goos)
				}
			}
			if len(sig.Checks) != len(tc.probes) {
				t.Fatalf("signature has %d probes, test lists %d", len(sig.Checks), len(tc.probes))
			}
			for i, probe := range tc.probes {
				if c := sig.Checks[i]; c.Type != probe.Type || c.Value != probe.Value || c.OS != probe.OS {
					t.Errorf("probe %d = %s %q (os %q), want %s %q (os %q)", i, c.Type, c.Value, c.OS, probe.Type, probe.Value, probe.OS)
				}
			}
			for _, c := range sig.Checks {
				if c.OS != "" && !sig.MatchesOS(c.OS) {
					t.Errorf("probe %q targets %s, which the signature does not cover", c.Value, c.OS)
				}
			}
		})
	}
}

// TestRemoteSupportToolSignatures locks the remote-access signatures added for
// #11306: remote support tools common in tech-support scams that the agent did
// not report before. The API alerts partners when one of these first appears
// on a managed device, so a typo here means a missed alert.
func TestRemoteSupportToolSignatures(t *testing.T) {
	assertSignatureProbes(t, []signatureProbeCase{
		{
			name:     "UltraViewer",
			category: CategoryRemoteAccess,
			os:       []string{"windows"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "UltraViewService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "UltraViewer_Service.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "UltraViewer_Desktop.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\UltraViewer\UltraViewer_Service.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\UltraViewer\UltraViewer_Desktop.exe`, OS: "windows"},
			},
		},
		{
			name:     "Zoho Assist",
			category: CategoryRemoteAccess,
			os:       []string{"windows"},
			probes: []Check{
				{Type: CheckProcessRunning, Value: "ZohoURSService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "ZohoURS.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "ZA_Access.exe", OS: "windows"},
				{Type: CheckRegistryValue, Value: `HKLM\SOFTWARE\Zoho Assist\Unattended Remote Support`, OS: "windows"},
				{Type: CheckRegistryValue, Value: `HKLM\SOFTWARE\WOW6432Node\Zoho Assist\Unattended Remote Support`, OS: "windows"},
			},
		},
		{
			name:     "DWService",
			category: CategoryRemoteAccess,
			os:       []string{"windows"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "DWAgent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "dwagent.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files\DWAgent`, OS: "windows"},
			},
		},
		{
			name:     "Supremo",
			category: CategoryRemoteAccess,
			os:       []string{"windows"},
			probes: []Check{
				{Type: CheckProcessRunning, Value: "SupremoService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "Supremo.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SupremoSystem.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\ProgramData\SupremoRemoteDesktop`, OS: "windows"},
			},
		},
		{
			name:     "Ammyy Admin",
			category: CategoryRemoteAccess,
			os:       []string{"windows"},
			probes: []Check{
				{Type: CheckProcessRunning, Value: "AA_v3.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "AMMYY_Admin.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\ProgramData\AMMYY`, OS: "windows"},
			},
		},
		{
			name:     "Chrome Remote Desktop",
			category: CategoryRemoteAccess,
			os:       []string{"windows", "darwin"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "chromoting", OS: "windows"},
				{Type: CheckProcessRunning, Value: "remoting_host.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "remoting_me2me_host", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Google\Chrome Remote Desktop`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/PrivilegedHelperTools/ChromeRemoteDesktopHost.app", OS: "darwin"},
				{Type: CheckLaunchDaemon, Value: "org.chromium.chromoting", OS: "darwin"},
			},
		},
	})
}

// TestQuickAssistIsNotASignature: Quick Assist ships with Windows 11, so a
// signature would report it on nearly every Windows device and, on the first
// scan after an agent upgrade, raise a "new remote access tool" alert on each
// of them (#11306). Leave it out until detection can tell a session from the
// inbox app.
func TestQuickAssistIsNotASignature(t *testing.T) {
	for _, sig := range AllSignatures() {
		if sig.Name == "Quick Assist" || sig.Name == "QuickAssist" {
			t.Fatalf("signature %q must not be added; see the test comment", sig.Name)
		}
		for _, c := range sig.Checks {
			if c.Value == "QuickAssist.exe" {
				t.Fatalf("signature %q probes QuickAssist.exe; see the test comment", sig.Name)
			}
		}
	}
}
