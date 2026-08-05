package sessionbroker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// TestHandleConnectionRoutesDisconnectThroughFinishHelperSession pins the one
// wire the rest of backup_death_test.go cannot reach.
//
// Broker.handleConnection is only entered after a full IPC handshake (peer
// credential check, HMAC session key, binary hash allowlist), which no unit
// test can stand up, so every behavioral test drives the session through the
// same RecvLoop-then-finishHelperSession pair by hand. That leaves exactly one
// uncovered edge: if handleConnection stopped calling finishHelperSession, the
// backup-helper death report (#2998) would silently stop firing in production
// while the whole suite stayed green — the original bug, reintroduced.
//
// So assert it structurally: after handleConnection's RecvLoop call, the
// function must hand off to finishHelperSession. A deferred call counts.
func TestHandleConnectionRoutesDisconnectThroughFinishHelperSession(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "broker.go", nil, 0)
	if err != nil {
		t.Fatalf("parse broker.go: %v", err)
	}

	fn := findFuncDecl(file, "handleConnection")
	if fn == nil {
		t.Fatal("handleConnection not found in broker.go — update this guard if it was renamed")
	}

	var callsRecvLoop, callsFinish bool
	ast.Inspect(fn, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		switch sel.Sel.Name {
		case "RecvLoop":
			callsRecvLoop = true
		case "finishHelperSession":
			callsFinish = true
		}
		return true
	})

	if !callsRecvLoop {
		t.Error("handleConnection no longer calls RecvLoop — this guard is stale, revisit it")
	}
	if !callsFinish {
		t.Fatal("handleConnection does not call finishHelperSession: a dying backup helper " +
			"would stop reporting its in-flight runs and the job would sit `running` until " +
			"the 15-minute stale reaper (regression of #2998)")
	}

	// finishHelperSession is only worth reaching if it still reports the death.
	finish := findFuncDecl(file, "finishHelperSession")
	if finish == nil {
		t.Fatal("finishHelperSession not found in broker.go")
	}
	var reports bool
	ast.Inspect(finish, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok && sel.Sel.Name == "reportBackupHelperDeath" {
			reports = true
		}
		return true
	})
	if !reports {
		t.Fatal("finishHelperSession no longer calls reportBackupHelperDeath (regression of #2998)")
	}
}

func findFuncDecl(file *ast.File, name string) *ast.FuncDecl {
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if ok && fn.Name.Name == name {
			return fn
		}
	}
	return nil
}
