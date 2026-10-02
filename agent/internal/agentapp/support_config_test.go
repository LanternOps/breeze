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
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/state"
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

// TestSupportSessionPathsStayInItsFolder enumerates, after the real
// registration (prepareSupportWorkDir), every path helper a support session
// derives a persisted file from: config dir, data dir (audit log, state
// stores, the downloaded H.264 codec), log dir, agent.state, and the default
// log file. Each must resolve inside the session's private folder and none
// under the machine-wide Breeze folder (#7629).
func TestSupportSessionPathsStayInItsFolder(t *testing.T) {
	machineDir := filepath.Join(t.TempDir(), "ProgramData-Breeze")
	t.Cleanup(config.SetConfigDirForTest(machineDir))
	workDir, err := prepareSupportWorkDir()
	t.Cleanup(config.ResetUserWorkspaceForTest)
	if err != nil {
		t.Fatalf("prepareSupportWorkDir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(workDir) })

	within := func(root, p string) bool {
		rel, err := filepath.Rel(root, p)
		return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	}
	machine := []string{
		machineDir,
		filepath.FromSlash("/Library/Application Support/Breeze"),
		filepath.FromSlash("/etc/breeze"),
		filepath.FromSlash("/var/lib/breeze"),
		filepath.FromSlash("/var/log/breeze"),
		filepath.Join(os.Getenv("ProgramData"), "Breeze"),
	}
	for name, p := range map[string]string{
		"config.ConfigDir()":       config.ConfigDir(),
		"config.GetDataDir()":      config.GetDataDir(),
		"config.LogDir()":          config.LogDir(),
		"agent.state":              state.PathInDir(config.ConfigDir()),
		"config.Default().LogFile": config.Default().LogFile,
	} {
		if !within(workDir, p) {
			t.Errorf("%s = %q, want inside the support folder %q", name, p, workDir)
		}
		for _, m := range machine {
			if m != "" && within(m, p) {
				t.Errorf("%s = %q resolves under the machine location %q", name, p, m)
			}
		}
	}
}

// TestSupportLogReleaseLetsTheFolderGo: the support log is opened twice
// (enrollment logging, then startAgent's), and on Windows an open file keeps
// its folder from being removed. releaseLogFiles closes both and discards
// logging from then on, so the folder can be removed and a later log line
// does not re-create support.log.
func TestSupportLogReleaseLetsTheFolderGo(t *testing.T) {
	t.Cleanup(func() { logging.Init("text", "info", os.Stdout); log = logging.L("main") })
	ws := filepath.Join(t.TempDir(), "breeze-support-4242")
	if err := os.MkdirAll(ws, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := config.Default()
	cfg.LogFile = filepath.Join(ws, "support.log")
	cfg.SupportMode = true
	initEnrollLogging(cfg, true)
	initLogging(cfg)
	log.Info("support session log line")
	if _, err := os.Stat(cfg.LogFile); err != nil {
		t.Fatalf("support.log was not written: %v", err)
	}

	releaseLogFiles()
	if err := os.RemoveAll(ws); err != nil {
		t.Fatalf("remove the support folder after releasing its log: %v", err)
	}
	log.Info("a line after the release")
	logging.L("heartbeat").Warn("another component's line after the release")
	if _, err := os.Stat(ws); !os.IsNotExist(err) {
		t.Fatalf("support folder exists again after logging (stat err %v): the log was re-opened", err)
	}
}

// TestRunSupportSessionTeardownOrder pins runSupportSession's teardown:
// the session's log is registered for release, the post-exit cleanup is
// started before the agent shuts down (a closed console window allows only
// a few seconds), and every early exit removes the folder through
// discardSupportWorkDir, which releases the log first.
func TestRunSupportSessionTeardownOrder(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "support.go", nil, 0)
	if err != nil {
		t.Fatalf("parse support.go: %v", err)
	}
	var body *ast.BlockStmt
	for _, d := range file.Decls {
		if f, ok := d.(*ast.FuncDecl); ok && f.Name.Name == "runSupportSession" {
			body = f.Body
		}
	}
	if body == nil {
		t.Fatal("runSupportSession not found")
	}
	var order []string
	ast.Inspect(body, func(n ast.Node) bool {
		c, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch fn := c.Fun.(type) {
		case *ast.Ident:
			order = append(order, fn.Name)
		case *ast.SelectorExpr:
			if x, ok := fn.X.(*ast.Ident); ok {
				order = append(order, x.Name+"."+fn.Sel.Name)
			} else {
				order = append(order, fn.Sel.Name)
			}
		}
		return true
	})
	index := func(name string) int {
		for i, n := range order {
			if n == name {
				return i
			}
		}
		return -1
	}
	release, schedule, shutdown, cleanup := index("SetSupportFileReleaser"), index("ScheduleSupportSelfCleanup"), index("shutdownAgent"), index("RunSupportCleanup")
	if release < 0 || schedule < 0 || shutdown < 0 || cleanup < 0 {
		t.Fatalf("teardown calls missing: release=%d schedule=%d shutdown=%d cleanup=%d (calls: %v)", release, schedule, shutdown, cleanup, order)
	}
	if release >= schedule || schedule >= shutdown || shutdown >= cleanup {
		t.Errorf("teardown order = release %d, schedule %d, shutdownAgent %d, RunSupportCleanup %d; want release < schedule < shutdownAgent < RunSupportCleanup", release, schedule, shutdown, cleanup)
	}
	if n := index("os.RemoveAll"); n >= 0 {
		t.Errorf("runSupportSession calls os.RemoveAll directly; use discardSupportWorkDir, which releases the open log first")
	}
	if index("discardSupportWorkDir") < 0 {
		t.Errorf("runSupportSession never calls discardSupportWorkDir")
	}
}
