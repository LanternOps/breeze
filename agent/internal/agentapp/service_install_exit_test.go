package agentapp

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// The two platform install commands are build-tagged, so on any given host
// `go test` compiles only one of them and neither is reachable from a test at
// all (the RunE body needs root, /etc, and a live init system). They are
// parsed as SOURCE here instead, which works on every platform and covers both
// files from a single untagged test.
var installCommandSources = map[string]string{
	"linux":  "service_cmd_linux.go",
	"darwin": "service_cmd_darwin.go",
}

// TestServiceInstallReturnsTheStartError is the guard for the fail-closed half
// of #5252.
//
// The original command stopped the agent service, failed to leave anything
// running, and STILL exited 0 — so a provisioning script, a golden-image
// build, or an operator watching the shell all saw success while the host went
// offline. The fix is one line: the install RunE ends in `return startErr`
// rather than `return nil`. Nothing else in the suite can catch a refactor
// that reverts it, because nothing calls RunE.
func TestServiceInstallReturnsTheStartError(t *testing.T) {
	for platform, file := range installCommandSources {
		t.Run(platform, func(t *testing.T) {
			body := installRunEBody(t, file)
			if len(body.List) == 0 {
				t.Fatalf("%s: serviceInstallCmd RunE body is empty", file)
			}
			last, ok := body.List[len(body.List)-1].(*ast.ReturnStmt)
			if !ok {
				t.Fatalf("%s: serviceInstallCmd RunE does not end in a return statement", file)
			}
			if len(last.Results) != 1 {
				t.Fatalf("%s: serviceInstallCmd RunE returns %d values, want 1", file, len(last.Results))
			}
			ident, ok := last.Results[0].(*ast.Ident)
			if !ok || ident.Name != "startErr" {
				t.Errorf("%s: serviceInstallCmd RunE ends in `return %s`, want `return startErr`. "+
					"Returning nil makes an install that stopped the service and could not start it "+
					"again exit 0 — the silent success that stranded a remote host in #5252.",
					file, exprText(last.Results[0]))
			}
		})
	}
}

// installRunEBody parses file and returns the body of the RunE function
// literal on the serviceInstallCmd command value.
func installRunEBody(t *testing.T, file string) *ast.BlockStmt {
	t.Helper()
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		t.Fatalf("failed to parse %s: %v", file, err)
	}

	var body *ast.BlockStmt
	ast.Inspect(parsed, func(n ast.Node) bool {
		vs, ok := n.(*ast.ValueSpec)
		if !ok || len(vs.Names) == 0 || vs.Names[0].Name != "serviceInstallCmd" {
			return true
		}
		ast.Inspect(vs, func(inner ast.Node) bool {
			kv, ok := inner.(*ast.KeyValueExpr)
			if !ok {
				return true
			}
			if key, ok := kv.Key.(*ast.Ident); !ok || key.Name != "RunE" {
				return true
			}
			if fn, ok := kv.Value.(*ast.FuncLit); ok {
				body = fn.Body
			}
			return false
		})
		return false
	})

	if body == nil {
		t.Fatalf("%s: could not find the RunE function literal on serviceInstallCmd — "+
			"the command's shape changed, re-check this guard", file)
	}
	return body
}

func exprText(e ast.Expr) string {
	if ident, ok := e.(*ast.Ident); ok {
		return ident.Name
	}
	return "<non-identifier>"
}
