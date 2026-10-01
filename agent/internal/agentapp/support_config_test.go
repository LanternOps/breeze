package agentapp

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/spf13/viper"
)

// TestSupportSessionRotationLeavesInstalledAgentConfigUntouched pins the #7629
// wiring: after enrolling, the support session binds its workspace agent.yaml
// as the process's active config, so the heartbeat's mid-session persists
// (StagePendingCredentials / PromotePendingCredentials on a token rotation,
// SaveTo(h.config, config.ActiveConfigFile()) on an mTLS renewal) land in the
// workspace. An installed agent's config at the default path is left
// byte-for-byte as it was.
//
// Before the fix the active config was never bound, so these calls resolved
// to config.ConfigDir(): for an elevated administrator, the installed agent's
// own agent.yaml and secrets.yaml.
func TestSupportSessionRotationLeavesInstalledAgentConfigUntouched(t *testing.T) {
	installedDir := filepath.Join(t.TempDir(), "ProgramData-Breeze")
	if err := os.MkdirAll(installedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	installed := map[string]string{
		"agent.yaml":   "agent_id: installed-agent-id\nserver_url: https://installed.example.test\n",
		"secrets.yaml": "auth_token: brz_installed_agent\nwatchdog_auth_token: brz_installed_watchdog\nhelper_auth_token: brz_installed_helper\n",
	}
	for name, body := range installed {
		if err := os.WriteFile(filepath.Join(installedDir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(config.SetConfigDirForTest(installedDir))
	viper.Reset()
	t.Cleanup(viper.Reset)

	workDir, err := prepareSupportWorkDir()
	t.Cleanup(config.ResetUserWorkspaceForTest)
	if err != nil {
		t.Fatalf("prepareSupportWorkDir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(workDir) })
	supportCfgFile := filepath.Join(workDir, "agent.yaml")

	// Stand in for the enroll round-trip; keep its one side effect that
	// matters here, the SaveEnrollment into the workspace.
	origEnroll := enrollWithConfigFn
	t.Cleanup(func() { enrollWithConfigFn = origEnroll })
	enrollWithConfigFn = func(cfg *config.Config, cfgFile, _, _ string) error {
		cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
		cfg.AuthToken = "brz_support_agent"
		cfg.WatchdogAuthToken = "brz_support_watchdog"
		cfg.HelperAuthToken = "brz_support_helper"
		return config.SaveEnrollment(cfg, cfgFile)
	}

	cfg := config.Default()
	cfg.ServerURL = "https://api.example.test"
	cfg.SupportMode = true
	cfg.SupportWorkDir = workDir
	if err := enrollSupportSession(cfg, supportCfgFile, "key", "secret"); err != nil {
		t.Fatalf("enrollSupportSession: %v", err)
	}

	active := config.ActiveConfigFile()
	same := active == supportCfgFile
	if runtime.GOOS == "windows" {
		same = strings.EqualFold(active, supportCfgFile)
	}
	if !same {
		t.Fatalf("ActiveConfigFile() = %q after enrollment, want the workspace %q", active, supportCfgFile)
	}

	// What the heartbeat does mid-session.
	if err := config.StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("token rotation, stage: %v", err)
	}
	if err := config.PromotePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("token rotation, promote: %v", err)
	}
	cfg.MtlsCertPEM = "renewed-cert"
	if err := config.SaveTo(cfg, config.ActiveConfigFile()); err != nil {
		t.Fatalf("mTLS renewal save: %v", err)
	}

	creds, err := config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if creds.AuthToken != "brz_new_agent" {
		t.Errorf("workspace auth token = %q, want the rotated brz_new_agent", creds.AuthToken)
	}

	entries, err := os.ReadDir(installedDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(installed) {
		var names []string
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Errorf("installed agent config dir now holds %v, want only the planted files", names)
	}
	for name, want := range installed {
		got, err := os.ReadFile(filepath.Join(installedDir, name))
		if err != nil || string(got) != want {
			t.Errorf("installed agent's %s changed: %q (err %v), want %q", name, got, err, want)
		}
	}
}

// TestRunSupportSessionEnrollsThroughEnrollSupportSession pins the call site:
// the test above drives enrollSupportSession directly, so it would stay green
// if runSupportSession went back to calling enrollWithConfig and skipped the
// bind. runSupportSession needs a live server, so this checks its source.
func TestRunSupportSessionEnrollsThroughEnrollSupportSession(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "support.go", nil, 0)
	if err != nil {
		t.Fatalf("parse support.go: %v", err)
	}
	var fn *ast.FuncDecl
	for _, d := range file.Decls {
		if f, ok := d.(*ast.FuncDecl); ok && f.Name.Name == "runSupportSession" {
			fn = f
		}
	}
	if fn == nil {
		t.Fatal("runSupportSession not found in support.go")
	}
	calls := map[string]int{}
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		if c, ok := n.(*ast.CallExpr); ok {
			if id, ok := c.Fun.(*ast.Ident); ok {
				calls[id.Name]++
			}
		}
		return true
	})
	if calls["enrollSupportSession"] != 1 {
		t.Errorf("runSupportSession calls enrollSupportSession %d times, want 1", calls["enrollSupportSession"])
	}
	for _, direct := range []string{"enrollWithConfig", "enrollWithConfigFn"} {
		if calls[direct] != 0 {
			t.Errorf("runSupportSession calls %s directly, skipping the workspace config bind (#7629)", direct)
		}
	}
}
