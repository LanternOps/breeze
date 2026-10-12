package mgmtdetect

import "testing"

// TestAdditionalRMMAndRemoteAccessSignatures locks the signatures added for
// #8014 (OpenFrame) and #8013 (SimpleHelp, MeshCentral, VNC family, plus the
// extra Splashtop probes). Each row lists every probe in order, matched on
// type, value and OS, so a typo in a service/process name fails here instead
// of silently missing on a fleet.
func TestAdditionalRMMAndRemoteAccessSignatures(t *testing.T) {
	cases := []struct {
		name     string
		category Category
		os       []string
		probes   []Check
	}{
		{
			name:     "OpenFrame",
			category: CategoryRMM,
			os:       []string{"windows"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "com.openframe.client", OS: "windows"},
				{Type: CheckProcessRunning, Value: "openframe-client.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files\OpenFrame\bin\openframe-client.exe`, OS: "windows"},
			},
		},
		{
			name:     "SimpleHelp",
			category: CategoryRemoteAccess,
			os:       []string{"windows"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "Remote Access Service", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SimpleService.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\ProgramData\JWrapper-Remote Access\JWAppsSharedConfig\restricted\SimpleService.exe`, OS: "windows"},
			},
		},
		{
			name:     "MeshCentral",
			category: CategoryRemoteAccess,
			os:       []string{"windows", "darwin"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "Mesh Agent", OS: "windows"},
				{Type: CheckProcessRunning, Value: "MeshAgent.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "meshagent", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\Mesh Agent\MeshAgent.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/usr/local/mesh_services/meshagent/meshagent", OS: "darwin"},
			},
		},
		{
			name:     "TightVNC",
			category: CategoryRemoteAccess,
			os:       []string{"windows"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "tvnserver", OS: "windows"},
				{Type: CheckProcessRunning, Value: "tvnserver.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files\TightVNC\tvnserver.exe`, OS: "windows"},
			},
		},
		{
			name:     "RealVNC",
			category: CategoryRemoteAccess,
			os:       []string{"windows", "darwin"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "vncserver", OS: "windows"},
				{Type: CheckProcessRunning, Value: "vncserver.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "vncserver", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files\RealVNC\VNC Server\vncserver.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Library/vnc/vncserver", OS: "darwin"},
			},
		},
		{
			name:     "UltraVNC",
			category: CategoryRemoteAccess,
			os:       []string{"windows"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "uvnc_service", OS: "windows"},
				{Type: CheckProcessRunning, Value: "winvnc.exe", OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files\uvnc bvba\UltraVNC\winvnc.exe`, OS: "windows"},
			},
		},
		{
			name:     "Splashtop",
			category: CategoryRemoteAccess,
			os:       []string{"windows", "darwin"},
			probes: []Check{
				{Type: CheckServiceRunning, Value: "SplashtopRemoteService", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SRService.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SRManager.exe", OS: "windows"},
				{Type: CheckProcessRunning, Value: "SplashtopStreamer", OS: "darwin"},
				{Type: CheckFileExists, Value: `C:\Program Files (x86)\Splashtop\Splashtop Remote\Server\SRService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: `C:\Program Files\Splashtop\Splashtop Remote\Server\SRService.exe`, OS: "windows"},
				{Type: CheckFileExists, Value: "/Applications/Splashtop Streamer.app", OS: "darwin"},
			},
		},
	}

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
