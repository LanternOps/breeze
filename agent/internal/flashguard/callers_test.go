package flashguard

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The mechanical guard against a new power path. Code review cannot be trusted
// to notice one: this scans the agent's source, every build tag included, for
// anything that can take the machine or the agent down, and fails on a site it
// has not been told about. If it failed on your change, wire the path through
// AdmitPowerAction (or WaitForPowerAction) and add it to powerSites. A site that
// genuinely cannot interrupt a firmware update goes in notPowerSites, with why.

// powerSymbols are identifiers that replace or restart the agent, plus OS APIs
// that power the machine off. Only a selector or a bare reference counts, so a
// comment naming one does not.
var powerSymbols = []string{
	"UpdateFromURL", "UpdateFrom", "UpdateTo", "UpdateToWithOptions",
	"RestartSelf", "RestartAfterRollback", "RestartWithHelper", "RestartAgentService", "runAgentRestartNow",
	"ExitWindowsEx", "InitiateSystemShutdown", "InitiateSystemShutdownEx", "InitiateShutdown", "NtShutdownSystem",
}

// powerLiterals are string literals that name a power command.
var powerLiterals = []string{"shutdown", "shutdown.exe", "reboot", "poweroff", "halt", "Restart-Computer", "Stop-Computer"}

// powerBuilders build the argv of a real shutdown, so every function calling one
// is a power path even though the literal lives elsewhere.
var powerBuilders = []string{"buildShutdownCommand", "ForceRebootArgv", "execOSReboot", "runShutdownCommand"}

// argvOnly are builders that only compute an argv. A function may call one before
// it asks the guard, so long as nothing runs until it has.
var argvOnly = []string{"ForceRebootArgv"}

type site struct {
	file   string // relative to the agent module root, with forward slashes
	fn     string // enclosing function, or packageLevel
	symbol string
}

const packageLevel = "(package)"

type admission struct {
	file string
	fn   string
}

// powerSites is every known site, and the function holding the admission for it.
var powerSites = map[site]admission{
	// Scheduled reboots. The OS invocation is one function per platform and they
	// all run under runOSReboot.
	{"internal/patching/reboot_os_darwin.go", "execOSReboot", "shutdown"}:                 {"internal/patching/reboot_manager.go", "runOSReboot"},
	{"internal/patching/reboot_os_linux.go", "execOSReboot", "shutdown"}:                  {"internal/patching/reboot_manager.go", "runOSReboot"},
	{"internal/patching/reboot_os_windows.go", "execOSReboot", "shutdown"}:                {"internal/patching/reboot_manager.go", "runOSReboot"},
	{"internal/patching/reboot_manager.go", "runOSReboot", "execOSReboot"}:                {"internal/patching/reboot_manager.go", "runOSReboot"},
	{"internal/patching/reboot_manager.go", "NewRebootManagerWithPrompt", "execOSReboot"}: {"internal/patching/reboot_manager.go", "runOSReboot"},
	{"internal/patching/reboot_manager.go", packageLevel, "execOSReboot"}:                 {"internal/patching/reboot_manager.go", "runOSReboot"},
	{"internal/patching/reboot_surface.go", "NewRebootManagerWithSeams", "execOSReboot"}:  {"internal/patching/reboot_manager.go", "runOSReboot"},

	// Remote reboot, shutdown, force reboot and safe mode.
	{"internal/remote/tools/system.go", "shutdownArgv", "shutdown"}:                                  {"internal/remote/tools/system.go", "Reboot"},
	{"internal/remote/tools/system.go", "Reboot", "buildShutdownCommand"}:                            {"internal/remote/tools/system.go", "Reboot"},
	{"internal/remote/tools/system.go", "Shutdown", "buildShutdownCommand"}:                          {"internal/remote/tools/system.go", "Shutdown"},
	{"internal/remote/tools/system.go", packageLevel, "runShutdownCommand"}:                          {"internal/remote/tools/system.go", "Reboot"},
	{"internal/remote/tools/system.go", "Reboot", "runShutdownCommand"}:                              {"internal/remote/tools/system.go", "Reboot"},
	{"internal/remote/tools/system.go", "Shutdown", "runShutdownCommand"}:                            {"internal/remote/tools/system.go", "Shutdown"},
	{"internal/remote/tools/system.go", "ForceReboot", "runShutdownCommand"}:                         {"internal/remote/tools/system.go", "ForceReboot"},
	{"internal/remote/tools/system.go", "ForceReboot", "ForceRebootArgv"}:                            {"internal/remote/tools/system.go", "ForceReboot"},
	{"internal/remote/tools/system_safemode_windows.go", "RebootToSafeMode", "buildShutdownCommand"}: {"internal/remote/tools/system_safemode_windows.go", "RebootToSafeMode"},

	// Agent replacement and restart.
	{"internal/heartbeat/heartbeat.go", "doUpgradeAttempt", "UpdateToWithOptions"}:              {"internal/heartbeat/heartbeat.go", "doUpgradeAttempt"},
	{"internal/heartbeat/handlers_devupdate.go", "handleDevUpdateAgent", "UpdateFromURL"}:       {"internal/heartbeat/handlers_devupdate.go", "handleDevUpdateAgent"},
	{"internal/heartbeat/handlers_rollback_backend.go", "Restart", "RestartAfterRollback"}:      {"internal/heartbeat/handlers_rollback_backend.go", "Swap"},
	{"internal/heartbeat/identity_sync.go", packageLevel, "RestartSelf"}:                        {"internal/heartbeat/identity_sync.go", "restartForIdentity"},
	{"internal/remote/tools/services.go", "RestartService", "RestartAgentService"}:              {"internal/remote/tools/agent_restart.go", "RestartAgentService"},
	{"internal/remote/tools/agent_restart.go", "RunDelayedRestartHelper", "runAgentRestartNow"}: {"internal/remote/tools/agent_restart.go", "RestartAgentService"},
	{"cmd/breeze-watchdog/main.go", "doUpdateAgent", "UpdateTo"}:                                {"cmd/breeze-watchdog/main.go", "doUpdateAgent"},
}

// notPowerSites cannot interrupt a firmware update, each for the reason given.
var notPowerSites = map[site]string{
	{"internal/patching/reboot_os_linux.go", "abortOSReboot", "shutdown"}:   "cancels a countdown",
	{"internal/patching/reboot_os_windows.go", "abortOSReboot", "shutdown"}: "cancels a countdown",

	{"cmd/breeze-watchdog/main.go", "doUpdateWatchdog", "UpdateTo"}: "replaces the watchdog; the agent keeps running",

	{"internal/remote/tools/types.go", packageLevel, "reboot"}:   "the command's wire name",
	{"internal/remote/tools/types.go", packageLevel, "shutdown"}: "the command's wire name",

	{"internal/tunnel/manager.go", "*", "shutdown"}:        "a reason string for closing screen sharing",
	{"internal/userhelper/supervisor.go", "*", "shutdown"}: "a stop reason for the helper supervisor",

	{"internal/recoveryconsole/console.go", "*", "reboot"}:          "runs in WinPE during bare-metal recovery, where no agent or flash exists",
	{"internal/recoveryconsole/console.go", "*", "poweroff"}:        "runs in WinPE during bare-metal recovery, where no agent or flash exists",
	{"cmd/breeze-backup/recovery_console_host.go", "*", "reboot"}:   "runs in WinPE during bare-metal recovery, where no agent or flash exists",
	{"cmd/breeze-backup/recovery_console_host.go", "*", "poweroff"}: "runs in WinPE during bare-metal recovery, where no agent or flash exists",
	{"cmd/breeze-backup/recovery_console_host.go", "*", "shutdown"}: "runs in WinPE during bare-metal recovery, where no agent or flash exists",
}

func moduleRoot() string { return filepath.Join("..", "..") }

// scanSource returns the power sites in one parsed file. Text matched against
// log output (strings.Contains and friends) is not a site.
func scanSource(rel string, file *ast.File) []site {
	var sites []site
	add := func(fn, symbol string) { sites = append(sites, site{rel, fn, symbol}) }

	var visit func(fn string, node ast.Node)
	visit = func(fn string, node ast.Node) {
		ast.Inspect(node, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.FuncDecl:
				if x.Body != nil && x != node {
					visit(x.Name.Name, x.Body)
				}
				return false
			case *ast.CallExpr:
				if sel, ok := x.Fun.(*ast.SelectorExpr); ok {
					if pkg, ok := sel.X.(*ast.Ident); ok && pkg.Name == "strings" {
						return false
					}
				}
			case *ast.BasicLit:
				if x.Kind == token.STRING {
					if value, err := strconv.Unquote(x.Value); err == nil && slices.Contains(powerLiterals, value) {
						add(fn, value)
					}
				}
			case *ast.SelectorExpr:
				if slices.Contains(powerSymbols, x.Sel.Name) {
					add(fn, x.Sel.Name)
				}
			case *ast.Ident:
				if slices.Contains(powerBuilders, x.Name) || slices.Contains(powerSymbols, x.Name) {
					add(fn, x.Name)
				}
			}
			return true
		})
	}
	for _, decl := range file.Decls {
		if f, ok := decl.(*ast.FuncDecl); ok {
			if f.Body != nil {
				visit(f.Name.Name, f.Body)
			}
			continue
		}
		visit(packageLevel, decl)
	}
	return sites
}

type sourceFile struct {
	rel  string
	file *ast.File
	fset *token.FileSet
}

func parseAgentSource(t *testing.T) []sourceFile {
	t.Helper()
	root := moduleRoot()
	var files []sourceFile
	for _, top := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, top), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if d.Name() == "testdata" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			fset := token.NewFileSet()
			parsed, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			// The implementation of the replace and restart primitives, which
			// every caller goes through and is what the table is about.
			if strings.HasPrefix(rel, "internal/updater/") || strings.HasPrefix(rel, "internal/flashguard/") {
				return nil
			}
			files = append(files, sourceFile{rel, parsed, fset})
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", top, err)
		}
	}
	return files
}

func isKnownNotPower(s site) bool {
	if _, ok := notPowerSites[s]; ok {
		return true
	}
	_, ok := notPowerSites[site{s.file, "*", s.symbol}]
	return ok
}

// A scanner that finds nothing would pass everything, so prove it can see.
func TestScannerFindsPowerSites(t *testing.T) {
	const src = `package demo

import (
	"os/exec"
	"strings"
)

var restart = updater.RestartSelf

func reboots() { exec.Command("shutdown", "/r").Run() }

func replaces(u *updater.Updater) { _ = u.UpdateTo("1.0.0") }

func builds() { _, _ = buildShutdownCommand(true, 0) }

func reads(msg string) bool { return strings.Contains(msg, "shutdown") }

// shutdown and UpdateTo in a comment are not sites.
func quiet() {}
`
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "demo.go", src, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	got := scanSource("demo.go", file)
	want := []site{
		{"demo.go", packageLevel, "RestartSelf"},
		{"demo.go", "reboots", "shutdown"},
		{"demo.go", "replaces", "UpdateTo"},
		{"demo.go", "builds", "buildShutdownCommand"},
	}
	for _, w := range want {
		if !slices.Contains(got, w) {
			t.Errorf("scanner missed %+v; found %+v", w, got)
		}
	}
	for _, g := range got {
		if g.fn == "reads" || g.fn == "quiet" {
			t.Errorf("scanner reported %+v, which is not a power site", g)
		}
	}
}

func TestEveryPowerSiteHoldsAnAdmission(t *testing.T) {
	files := parseAgentSource(t)
	found := map[site]bool{}
	var unknown []string
	for _, f := range files {
		for _, s := range scanSource(f.rel, f.file) {
			found[s] = true
			if _, ok := powerSites[s]; ok || isKnownNotPower(s) {
				continue
			}
			unknown = append(unknown, s.file+": "+s.fn+": "+s.symbol)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		t.Errorf("power sites the flash guard does not know about; wire them through AdmitPowerAction and add them to powerSites:\n  %s",
			strings.Join(slices.Compact(unknown), "\n  "))
	}

	// A stale entry would let a removed path's replacement go unnoticed.
	for s := range powerSites {
		if !found[s] {
			t.Errorf("powerSites lists %+v, which no longer exists", s)
		}
	}
	for s := range notPowerSites {
		if s.fn == "*" {
			any := false
			for f := range found {
				if f.file == s.file && f.symbol == s.symbol {
					any = true
				}
			}
			if !any {
				t.Errorf("notPowerSites lists %+v, which no longer exists", s)
			}
			continue
		}
		if !found[s] {
			t.Errorf("notPowerSites lists %+v, which no longer exists", s)
		}
	}

	// Each named holder really calls the guard.
	holders := map[admission]bool{}
	for _, a := range powerSites {
		holders[a] = false
	}
	for _, f := range files {
		for _, decl := range f.file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			a := admission{f.rel, fn.Name.Name}
			if _, wanted := holders[a]; wanted && callsGuard(fn) {
				holders[a] = true
			}
		}
	}
	for a, ok := range holders {
		if !ok {
			t.Errorf("%s: %s is named as holding the admission but does not call AdmitPowerAction or WaitForPowerAction", a.file, a.fn)
		}
	}

	// Where the holder is the function with the power call itself, it must ask
	// first: a check after the shutdown guards nothing.
	funcs := map[admission]*ast.FuncDecl{}
	for _, f := range files {
		for _, decl := range f.file.Decls {
			if fn, ok := decl.(*ast.FuncDecl); ok && fn.Body != nil {
				funcs[admission{f.rel, fn.Name.Name}] = fn
			}
		}
	}
	for s, a := range powerSites {
		if a.file != s.file || a.fn != s.fn || slices.Contains(argvOnly, s.symbol) {
			continue
		}
		fn := funcs[a]
		if fn == nil {
			continue
		}
		guard, use := firstGuardCall(fn), firstUse(fn, s.symbol)
		if guard == token.NoPos || use == token.NoPos || use < guard {
			t.Errorf("%s: %s uses %s before it asks the flash guard", s.file, s.fn, s.symbol)
		}
	}
}

func firstGuardCall(fn *ast.FuncDecl) token.Pos {
	pos := token.NoPos
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok && pos == token.NoPos &&
			(sel.Sel.Name == "AdmitPowerAction" || sel.Sel.Name == "WaitForPowerAction") {
			pos = sel.Pos()
		}
		return pos == token.NoPos
	})
	return pos
}

// firstUse finds the first reference to symbol in fn: a selector, a bare
// identifier, or a string literal, whichever the scan matched it as.
func firstUse(fn *ast.FuncDecl, symbol string) token.Pos {
	pos := token.NoPos
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		if pos != token.NoPos {
			return false
		}
		switch x := n.(type) {
		case *ast.SelectorExpr:
			if x.Sel.Name == symbol {
				pos = x.Pos()
			}
		case *ast.Ident:
			if x.Name == symbol {
				pos = x.Pos()
			}
		case *ast.BasicLit:
			if value, err := strconv.Unquote(x.Value); err == nil && value == symbol {
				pos = x.Pos()
			}
		}
		return pos == token.NoPos
	})
	return pos
}

func callsGuard(fn *ast.FuncDecl) bool {
	found := false
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok && (sel.Sel.Name == "AdmitPowerAction" || sel.Sel.Name == "WaitForPowerAction") {
			found = true
		}
		return true
	})
	return found
}

// Safe mode's order matters and its code only compiles on Windows: a refused
// reboot must not have set the BCD flag already, or the next boot, whatever
// triggers it, lands in Safe Mode. Checked from source so it holds in every CI job.
func TestSafeModeAdmitsBeforeSettingTheBootFlag(t *testing.T) {
	for _, f := range parseAgentSource(t) {
		if f.rel != "internal/remote/tools/system_safemode_windows.go" {
			continue
		}
		var admit, setFlag token.Pos
		ast.Inspect(f.file, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok {
				// The first of each: any flag set ahead of the first admission is
				// the bug, wherever a later one sits.
				switch {
				case sel.Sel.Name == "AdmitPowerAction" && admit == token.NoPos:
					admit = sel.Pos()
				case sel.Sel.Name == "SetSafeBootNetwork" && setFlag == token.NoPos:
					setFlag = sel.Pos()
				}
			}
			return true
		})
		if admit == token.NoPos || setFlag == token.NoPos {
			t.Fatalf("expected both calls, admit=%v setFlag=%v", admit, setFlag)
		}
		if admit > setFlag {
			t.Fatal("RebootToSafeMode sets the BCD flag before asking the flash guard")
		}
		return
	}
	t.Fatal("system_safemode_windows.go not found")
}

// Enter's countdown check only sees the reboot manager if this call is in place.
func TestTheRebootManagerCountdownIsWiredToTheGuard(t *testing.T) {
	for _, f := range parseAgentSource(t) {
		if f.rel != "internal/heartbeat/heartbeat.go" {
			continue
		}
		wired := false
		ast.Inspect(f.file, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok && sel.Sel.Name == "SetCountdownProbe" {
				wired = true
			}
			return true
		})
		if !wired {
			t.Fatal("heartbeat.go no longer registers the reboot manager's countdown probe")
		}
		return
	}
	t.Fatal("heartbeat.go not found")
}
