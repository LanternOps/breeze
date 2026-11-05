package sessionbroker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// handleConnection is entered only after a real IPC handshake (peer
// credentials, binary hash), which no unit test can stand up, so pin the
// TCC rule's wiring structurally: the broker decides the flag with
// agentHandlesTCCNoticeFor, sends it in the accepted AuthResponse, and
// records the same value on the session the status handler reads.
func TestHandleConnectionWiresTheTCCNoticeFlag(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "broker.go", nil, 0)
	if err != nil {
		t.Fatalf("parse broker.go: %v", err)
	}
	fn := findFuncDecl(file, "handleConnection")
	if fn == nil {
		t.Fatal("handleConnection not found in broker.go; update this guard")
	}
	var decided, sent, stored string
	ast.Inspect(fn, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.AssignStmt:
			if len(x.Lhs) == 1 && len(x.Rhs) == 1 {
				if call, ok := x.Rhs[0].(*ast.CallExpr); ok {
					if sel, ok := call.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "agentHandlesTCCNoticeFor" {
						if id, ok := x.Lhs[0].(*ast.Ident); ok {
							decided = id.Name
						}
					}
				}
			}
		case *ast.KeyValueExpr:
			if k, ok := x.Key.(*ast.Ident); ok && k.Name == "AgentHandlesTCCNotice" {
				if v, ok := x.Value.(*ast.Ident); ok {
					sent = v.Name
				}
			}
		case *ast.CallExpr:
			if sel, ok := x.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Store" {
				if inner, ok := sel.X.(*ast.SelectorExpr); ok && inner.Sel.Name == "agentHandlesTCCNotice" && len(x.Args) == 1 {
					if v, ok := x.Args[0].(*ast.Ident); ok {
						stored = v.Name
					}
				}
			}
		}
		return true
	})
	if decided == "" {
		t.Fatal("handleConnection no longer decides the TCC flag with agentHandlesTCCNoticeFor")
	}
	if sent != decided {
		t.Fatalf("the accepted AuthResponse does not carry the decided flag (AgentHandlesTCCNotice: %q, decided %q)", sent, decided)
	}
	if stored != decided {
		t.Fatalf("the session does not record the decided flag (stored %q, decided %q): the agent would build nothing", stored, decided)
	}
}
