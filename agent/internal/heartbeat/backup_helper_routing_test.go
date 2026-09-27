package heartbeat

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strconv"
	"testing"
)

// helperCommandsNotRoutedByAgent lists command types the backup helper
// implements but the agent does not forward yet. Each entry is a known gap,
// not a design choice: the agent answers these as unknown commands. Remove an
// entry when its route lands. The test below fails if an entry becomes routed
// or disappears from the helper, so this list cannot go stale silently.
//
// vault_*: the API dispatches vault_sync (routes/backup/vault.ts), but the
// helper only reaches execVaultSync when it has an agent.yaml backup manager,
// and nothing dispatches vault_configure, so routing it alone would not make
// a manual vault sync work.
var helperCommandsNotRoutedByAgent = map[string]bool{
	"vault_sync":      true,
	"vault_status":    true,
	"vault_configure": true,
}

// helperCommandTypes returns every string literal used as a case label in the
// backup helper's executeCommand (cmd/breeze-backup/main.go). That switch is
// the helper's command set, and the agent's handlerRegistry is the only way a
// server command reaches it.
func helperCommandTypes(t *testing.T) []string {
	t.Helper()
	path := filepath.Join("..", "..", "cmd", "breeze-backup", "main.go")
	file, err := parser.ParseFile(token.NewFileSet(), path, nil, 0)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}

	var fn *ast.FuncDecl
	for _, decl := range file.Decls {
		if d, ok := decl.(*ast.FuncDecl); ok && d.Recv == nil && d.Name.Name == "executeCommand" {
			fn = d
			break
		}
	}
	if fn == nil {
		t.Fatalf("executeCommand not found in %s", path)
	}

	seen := map[string]bool{}
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		clause, ok := n.(*ast.CaseClause)
		if !ok {
			return true
		}
		for _, expr := range clause.List {
			lit, ok := expr.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				continue
			}
			v, err := strconv.Unquote(lit.Value)
			if err != nil {
				t.Fatalf("unquote %s: %v", lit.Value, err)
			}
			seen[v] = true
		}
		return true
	})

	out := make([]string, 0, len(seen))
	for v := range seen {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// TestEveryHelperCommandIsRoutedByAgent guards the agent/helper boundary: a
// command type the helper implements but the agent never registers is dead on
// arrival, because the agent rejects it as unknown before it reaches IPC.
// vm_instant_boot shipped that way.
func TestEveryHelperCommandIsRoutedByAgent(t *testing.T) {
	types := helperCommandTypes(t)
	if len(types) < 20 {
		t.Fatalf("found only %d helper command types (%v); the parser is not reading the dispatch switch", len(types), types)
	}

	inHelper := map[string]bool{}
	for _, cmdType := range types {
		inHelper[cmdType] = true
		_, routed := handlerRegistry[cmdType]
		switch {
		case helperCommandsNotRoutedByAgent[cmdType] && routed:
			t.Errorf("%q is now routed by the agent; remove it from helperCommandsNotRoutedByAgent", cmdType)
		case !helperCommandsNotRoutedByAgent[cmdType] && !routed:
			t.Errorf("backup helper implements %q but the agent has no handler for it, so every agent answers it as an unknown command", cmdType)
		}
	}
	for cmdType := range helperCommandsNotRoutedByAgent {
		if !inHelper[cmdType] {
			t.Errorf("helperCommandsNotRoutedByAgent lists %q, which the backup helper no longer implements", cmdType)
		}
	}
}
