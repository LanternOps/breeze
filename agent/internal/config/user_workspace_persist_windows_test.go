//go:build windows

package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

// TestUserWorkspaceStandardUserRotationPersistsToWorkspace is the #7629
// standard-user case, the normal way Quick Support is run. As a standard
// user, after enrolling into the workspace and binding it, a full token
// rotation (stage, promote, clear) and an mTLS-renewal SaveTo all succeed and
// land in the workspace, and the files keep the user-private DACL. Unbound,
// each of these resolved to ProgramData\Breeze, which a standard user may
// not write, so the rotation failed and the session lost its credentials.
func TestUserWorkspaceStandardUserRotationPersistsToWorkspace(t *testing.T) {
	installedDir, installed := plantInstalledAgentConfig(t)
	t.Cleanup(resetUserWorkspaceForTest)
	viper.Reset()
	t.Cleanup(viper.Reset)
	user := currentUserSID(t)
	ws := filepath.Join(t.TempDir(), "breeze-support-7629")
	cfgPath := filepath.Join(ws, "agent.yaml")

	asStandardUser(t, func() {
		if err := SecureUserWorkspace(ws); err != nil {
			t.Fatalf("SecureUserWorkspace: %v", err)
		}
		cfg := Default()
		cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
		cfg.ServerURL = "https://api.example.test"
		cfg.AuthToken = "brz_support_agent"
		cfg.WatchdogAuthToken = "brz_support_watchdog"
		cfg.HelperAuthToken = "brz_support_helper"
		if err := SaveEnrollment(cfg, cfgPath); err != nil {
			t.Fatalf("SaveEnrollment: %v", err)
		}
		if err := BindConfigFile(cfgPath); err != nil {
			t.Fatalf("BindConfigFile as a standard user: %v", err)
		}
		if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
			t.Fatalf("StagePendingCredentials as a standard user: %v", err)
		}
		if err := PromotePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
			t.Fatalf("PromotePendingCredentials as a standard user: %v", err)
		}
		if err := StagePendingCredentials("brz_next_agent", "brz_next_watchdog", "brz_next_helper"); err != nil {
			t.Fatalf("StagePendingCredentials (second) as a standard user: %v", err)
		}
		if err := ClearPendingCredentials(); err != nil {
			t.Fatalf("ClearPendingCredentials as a standard user: %v", err)
		}
		cfg.MtlsCertPEM = "renewed-cert"
		if err := SaveTo(cfg, ActiveConfigFile()); err != nil {
			t.Fatalf("mTLS renewal SaveTo as a standard user: %v", err)
		}
		creds := readCreds(t, cfgPath)
		if creds.AuthToken != "brz_new_agent" || creds.PendingAuthToken != "" {
			t.Errorf("workspace creds = current %q pending %q, want brz_new_agent and none pending", creds.AuthToken, creds.PendingAuthToken)
		}
	})

	assertUserPrivate(t, cfgPath, user, nil, userWorkspaceFileSDDLFormat)
	assertUserPrivate(t, filepath.Join(ws, "secrets.yaml"), user, nil, userWorkspaceFileSDDLFormat)
	assertInstalledConfigUntouched(t, installedDir, installed)
}

// TestUserWorkspaceCodecTrustRealFolderAsStandardUser: with real ACLs, a file
// a standard user's support session writes into its data dir (where the
// H.264 codec is downloaded) passes VerifyProgramDataPath, so the codec can
// load. The same folder made writable by BUILTIN\Users is refused.
func TestUserWorkspaceCodecTrustRealFolderAsStandardUser(t *testing.T) {
	plantInstalledAgentConfig(t)
	t.Cleanup(resetUserWorkspaceForTest)
	ws := filepath.Join(t.TempDir(), "breeze-support-7629")
	var dll string
	asStandardUser(t, func() {
		if err := SecureUserWorkspace(ws); err != nil {
			t.Fatalf("SecureUserWorkspace: %v", err)
		}
		if err := os.MkdirAll(GetDataDir(), 0o700); err != nil {
			t.Fatalf("create the data dir: %v", err)
		}
		dll = filepath.Join(GetDataDir(), "openh264-2.4.1-win64.dll")
		if err := os.WriteFile(dll, []byte("codec"), 0o600); err != nil {
			t.Fatalf("write the codec: %v", err)
		}
		if err := VerifyProgramDataPath(dll); err != nil {
			t.Fatalf("VerifyProgramDataPath on the support folder's codec: %v", err)
		}
	})

	if out, err := exec.Command("icacls", GetDataDir(), "/grant", "*S-1-5-32-545:(M)").CombinedOutput(); err != nil {
		t.Fatalf("icacls grant Users modify: %v: %s", err, out)
	}
	asStandardUser(t, func() {
		if err := VerifyProgramDataPath(dll); err == nil || !strings.Contains(err.Error(), "grants write") {
			t.Fatalf("data dir writable by Users: err = %v, want a write refusal", err)
		}
	})
}

// TestUserWorkspaceCodecTrustRefusesAnElevatedSession: in a session running
// with Administrators enabled, the session user is not an accepted owner or
// writer. A non-elevated process of the same user can write the folder (the
// DACL grants that user), so trusting it would let that process swap the
// codec between its hash check and the elevated LoadLibrary. The codec is
// refused instead and the session falls back to the WebSocket desktop.
func TestUserWorkspaceCodecTrustRefusesAnElevatedSession(t *testing.T) {
	if !isAdminEnabled(t) {
		t.Skip("needs an elevated runner token (Administrators enabled)")
	}
	plantInstalledAgentConfig(t)
	t.Cleanup(resetUserWorkspaceForTest)
	ws := filepath.Join(t.TempDir(), "breeze-support-7629")
	if err := SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	if err := os.MkdirAll(GetDataDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	dll := filepath.Join(GetDataDir(), "openh264-2.4.1-win64.dll")
	if err := os.WriteFile(dll, []byte("codec"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := VerifyProgramDataPath(dll); err == nil {
		t.Fatal("VerifyProgramDataPath accepted a user-writable codec in an elevated session")
	}
}
