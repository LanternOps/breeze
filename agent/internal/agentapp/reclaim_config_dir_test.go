package agentapp

import (
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// callOrder lists, in source order, the calls made in funcName's body in
// main.go: bare identifiers, and pkg.Func selectors as "pkg.Func".
func callOrder(t *testing.T, funcName string) []string {
	t.Helper()
	return callOrderIn(t, "main.go", funcName)
}

// callOrderIn is callOrder for funcName in fileName; funcName "" lists the
// calls in the whole file (for code in a closure, such as a cobra RunE).
func callOrderIn(t *testing.T, fileName, funcName string) []string {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), fileName, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", fileName, err)
	}
	var body ast.Node = file
	if funcName != "" {
		body = nil
		for _, d := range file.Decls {
			if f, ok := d.(*ast.FuncDecl); ok && f.Recv == nil && f.Name.Name == funcName {
				body = f.Body
			}
		}
		if body == nil {
			t.Fatalf("%s not found in %s", funcName, fileName)
		}
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
			}
		}
		return true
	})
	return order
}

func indexOf(order []string, name string) int {
	for i, n := range order {
		if n == name {
			return i
		}
	}
	return -1
}

// TestAgentStartReclaimsConfigDirBeforeReadingIt pins where runAgent takes
// the config folder back: the Windows service registers with the service
// manager first (runAsService; it takes the folder back itself, retrying,
// in prepareServiceStart), and the console path takes it back before the
// instance guard (which hardens the folder and so would hide that another
// account had it, and holds it open, which would keep a replaced folder from
// being set aside) and before config.Load.
func TestAgentStartReclaimsConfigDirBeforeReadingIt(t *testing.T) {
	order := callOrder(t, "runAgent")
	guard, reclaim := indexOf(order, "acquireMainAgentGuardFn"), indexOf(order, "reclaimConfigDirFn")
	service, load := indexOf(order, "runAsService"), indexOf(order, "config.Load")
	if guard < 0 || reclaim < 0 || service < 0 || load < 0 {
		t.Fatalf("calls missing: guard=%d reclaim=%d runAsService=%d config.Load=%d", guard, reclaim, service, load)
	}
	if service >= reclaim || reclaim >= guard || reclaim >= load {
		t.Errorf("order runAsService=%d reclaim=%d guard=%d config.Load=%d; want the service to register first, then the reclaim before the guard and the load", service, reclaim, guard, load)
	}
	prep := callOrderIn(t, "service_start.go", "prepareServiceStart")
	if r, g := indexOf(prep, "reclaimConfigDirFn"), indexOf(prep, "acquireMainAgentGuardFn"); r < 0 || g < 0 || r > g {
		t.Errorf("prepareServiceStart: reclaim at %d, guard at %d; want the reclaim first", r, g)
	}
	exec := callOrderIn(t, "service_windows.go", "")
	if p, l := indexOf(exec, "s.prepare"), indexOf(exec, "config.Load"); p < 0 || l < 0 || p > l {
		t.Errorf("service Execute: prepare at %d, config.Load at %d; want prepare first", p, l)
	}
}

// TestEnrollReclaimsConfigDirBeforeReadingIt: enrollDevice takes the folder
// back, removing config files another account could have written, before it
// loads the existing config.
func TestEnrollReclaimsConfigDirBeforeReadingIt(t *testing.T) {
	order := callOrder(t, "enrollDevice")
	reclaim, load := indexOf(order, "reclaimConfigDirFn"), indexOf(order, "config.Load")
	if reclaim < 0 || load < 0 || reclaim > load {
		t.Errorf("enrollDevice: reclaim at %d, config.Load at %d; want the reclaim first", reclaim, load)
	}
}

// TestInstallerStepsReclaimConfigDirBeforeReadingIt: the installer's
// bootstrap enrollment and `service install` take the config folder back
// before they read the existing config, so a config another account planted
// can neither make them skip enrollment as "already enrolled" nor be
// reported as an enrolled host.
func TestInstallerStepsReclaimConfigDirBeforeReadingIt(t *testing.T) {
	for _, tc := range []struct{ file, fn string }{
		{"bootstrap.go", "runBootstrap"},
		{"service_cmd_windows.go", ""},
	} {
		order := callOrderIn(t, tc.file, tc.fn)
		reclaim, load := indexOf(order, "reclaimConfigDirFn"), indexOf(order, "config.Load")
		if reclaim < 0 || load < 0 || reclaim > load {
			t.Errorf("%s %s: reclaim at %d, config.Load at %d; want the reclaim first", tc.file, tc.fn, reclaim, load)
		}
	}
}

func TestConfigFileInMachineDir(t *testing.T) {
	machine := config.ConfigDir()
	for _, tc := range []struct {
		cfgFile string
		want    bool
	}{
		{"", true},
		{filepath.Join(machine, "agent.yaml"), true},
		{filepath.Join(t.TempDir(), "agent.yaml"), false},
		{filepath.Join(machine, "sub", "agent.yaml"), false},
	} {
		if got := configFileInMachineDir(tc.cfgFile); got != tc.want {
			t.Errorf("configFileInMachineDir(%q) = %v, want %v", tc.cfgFile, got, tc.want)
		}
	}
}

type nopGuard struct{}

func (nopGuard) Close() error { return nil }

// TestRunAgentStopsWhenTheConfigFolderCannotBeTrusted: a config folder the
// agent cannot take back (a link, an owner it cannot replace) stops the agent
// before it reads config or starts anything.
func TestRunAgentStopsWhenTheConfigFolderCannotBeTrusted(t *testing.T) {
	origAcquire, origExit, origReclaim := acquireMainAgentGuardFn, mainAgentExitFn, reclaimConfigDirFn
	origReconcile, origStart, origMarker := reconcileServiceUnitIfNeededFn, startAgentFn, writeInstanceGuardMarkerFn
	t.Cleanup(func() {
		acquireMainAgentGuardFn, mainAgentExitFn, reclaimConfigDirFn = origAcquire, origExit, origReclaim
		reconcileServiceUnitIfNeededFn, startAgentFn, writeInstanceGuardMarkerFn = origReconcile, origStart, origMarker
	})
	var marked error
	writeInstanceGuardMarkerFn = func(_ ProcessStartup, err error) { marked = err }
	guarded := false
	acquireMainAgentGuardFn = func(ProcessStartup) (mainAgentGuard, error) { guarded = true; return nopGuard{}, nil }
	var forEnrollArg []bool
	reclaimConfigDirFn = func(forEnroll bool) error {
		forEnrollArg = append(forEnrollArg, forEnroll)
		return fmt.Errorf("%w: planted link", config.ErrConfigDirUntrusted)
	}
	exitCode, reconciled, started := 0, false, false
	mainAgentExitFn = func(code int) { exitCode = code }
	reconcileServiceUnitIfNeededFn = func() { reconciled = true }
	startAgentFn = func(*config.Config) (*agentComponents, error) { started = true; return nil, nil }

	runAgent()

	if exitCode != exitConfigDirUntrusted || reconciled || started || guarded {
		t.Fatalf("exit=%d reconciled=%v started=%v guarded=%v, want exit %d and nothing else", exitCode, reconciled, started, guarded, exitConfigDirUntrusted)
	}
	if !errors.Is(marked, config.ErrConfigDirUntrusted) {
		t.Errorf("startup marker = %v, want the config folder error recorded", marked)
	}
	if len(forEnrollArg) != 1 || forEnrollArg[0] {
		t.Errorf("reclaim called with forEnroll=%v, want one call with false (start, not enroll)", forEnrollArg)
	}
}
