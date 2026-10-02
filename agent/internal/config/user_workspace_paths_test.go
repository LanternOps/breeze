package config

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

// machineLocations are the machine-wide Breeze locations on every platform.
// A support session must not resolve anything under any of them.
func machineLocations(standIn string) []string {
	return []string{
		standIn,
		platformConfigDir(),
		filepath.FromSlash("/Library/Application Support/Breeze"),
		filepath.FromSlash("/etc/breeze"),
		filepath.FromSlash("/var/lib/breeze"),
		filepath.FromSlash("/var/log/breeze"),
	}
}

// TestUserWorkspacePathHelpersResolveIntoIt: once a support session has
// registered its private folder, every path helper the agent derives a
// persisted file from (config dir, data dir, log dir, the default agent.yaml
// and secrets.yaml, the default log file) resolves inside that folder. The
// data dir carries the audit log, agent state, desktop-fence, hardware-health
// and time-sync stores and the downloaded codec, so none of them can land in
// the machine-wide folder either.
func TestUserWorkspacePathHelpersResolveIntoIt(t *testing.T) {
	machineDir, _ := plantInstalledAgentConfig(t)
	t.Cleanup(resetUserWorkspaceForTest)
	viper.Reset()
	t.Cleanup(viper.Reset)

	ws := filepath.Join(t.TempDir(), "breeze-support-7629")
	if err := SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}

	paths := map[string]string{
		"ConfigDir()":              ConfigDir(),
		"GetDataDir()":             GetDataDir(),
		"LogDir()":                 LogDir(),
		"defaultLogFile()":         defaultLogFile(),
		"Default().LogFile":        Default().LogFile,
		"ResolveSavePath(\"\")":    ResolveSavePath(""),
		"secretsFilePathFor(\"\")": secretsFilePathFor(""),
		"secretsFilePath()":        secretsFilePath(),
	}
	for name, p := range paths {
		if !inUserWorkspace(p) {
			t.Errorf("%s = %q, want inside the support folder %q", name, p, ws)
		}
		for _, machine := range machineLocations(machineDir) {
			if pathWithin(filepath.Clean(machine), filepath.Clean(p), true) {
				t.Errorf("%s = %q resolves under the machine location %q", name, p, machine)
			}
		}
	}
	if got := MachineConfigDir(); got != machineDir {
		t.Errorf("MachineConfigDir() = %q, want the machine dir %q regardless of the support folder", got, machineDir)
	}

	resetUserWorkspaceForTest()
	if got := ConfigDir(); got != machineDir {
		t.Errorf("ConfigDir() = %q once no support folder is registered, want the machine dir %q", got, machineDir)
	}
	if strings.HasPrefix(GetDataDir(), ws) {
		t.Errorf("GetDataDir() = %q still inside the support folder after unregistering", GetDataDir())
	}
}

// TestUserWorkspaceCodecTrustAcceptsThePrivateFolder: the downloaded H.264
// codec is only loaded from a path VerifyProgramDataPath accepts. In a support
// session that path is inside the private folder, which the session's own
// user owns, so the check accepts that owner there, and only there.
func TestUserWorkspaceCodecTrustAcceptsThePrivateFolder(t *testing.T) {
	const userSID = "S-1-5-21-1000-1000-1000-1001"
	const otherUser = "S-1-5-21-1000-1000-1000-1002"
	const builtinUsers = "S-1-5-32-545"
	machineDir, _ := plantInstalledAgentConfig(t)
	t.Cleanup(resetUserWorkspaceForTest)

	origOwner := workspaceOwnerSIDFn
	t.Cleanup(func() { workspaceOwnerSIDFn = origOwner })
	workspaceOwnerSIDFn = func() string { return userSID }

	ws := filepath.Join(t.TempDir(), "breeze-support-7629")
	if err := SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	data := filepath.Join(ws, "data")
	dll := filepath.Join(data, "openh264.dll")
	private := func(owner string) programDataPathSecurity {
		return programDataPathSecurity{
			Exists:      true,
			OwnerSID:    owner,
			DACLPresent: true,
			ACEs: []programDataACE{
				{Type: aceTypeAccessAllowed, Mask: testFullControl, SID: userSID},
				{Type: aceTypeAccessAllowed, Mask: testFullControl, SID: sidLocalSystem},
				{Type: aceTypeAccessAllowed, Mask: testFullControl, SID: sidAdministrators},
			},
		}
	}

	for _, tc := range []struct {
		name    string
		path    string
		mutate  func(map[string]programDataPathSecurity)
		wantErr string
	}{
		{name: "private folder owned by the session user", path: dll},
		{name: "owned by Administrators (elevated session)", path: dll, mutate: func(m map[string]programDataPathSecurity) {
			m[dll] = private(sidAdministrators)
		}},
		{name: "a component owned by another user", path: dll, wantErr: "owner", mutate: func(m map[string]programDataPathSecurity) {
			m[data] = private(otherUser)
		}},
		{name: "write granted to another user", path: dll, wantErr: "grants write", mutate: func(m map[string]programDataPathSecurity) {
			s := private(userSID)
			s.ACEs = append(s.ACEs, programDataACE{Type: aceTypeAccessAllowed, Mask: testFullControl, SID: builtinUsers})
			m[data] = s
		}},
		{name: "reparse point", path: dll, wantErr: "link", mutate: func(m map[string]programDataPathSecurity) {
			m[data] = programDataPathSecurity{Exists: true, Reparse: true, NameSurrogate: true}
		}},
		{name: "the machine dir is outside the private folder", path: filepath.Join(machineDir, "data", "openh264.dll"), wantErr: "not under"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := map[string]programDataPathSecurity{ws: private(userSID), data: private(userSID), dll: private(userSID)}
			if tc.mutate != nil {
				tc.mutate(m)
			}
			swapPathSecurityReader(t, m, nil)
			err := VerifyProgramDataPath(tc.path)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("VerifyProgramDataPath: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want a refusal containing %q", err, tc.wantErr)
			}
		})
	}

	// Outside a support session the session user is not a trusted owner.
	resetUserWorkspaceForTest()
	machineData := filepath.Join(machineDir, "data")
	machineDLL := filepath.Join(machineData, "openh264.dll")
	swapPathSecurityReader(t, map[string]programDataPathSecurity{
		machineDir: hardenedDirSecurity(), machineData: hardenedDirSecurity(), machineDLL: private(userSID),
	}, nil)
	if err := VerifyProgramDataPath(machineDLL); err == nil || !strings.Contains(err.Error(), "owner") {
		t.Fatalf("machine path owned by a user: err = %v, want an owner refusal", err)
	}
}
