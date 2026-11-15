package psscript

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// quotedValueHelpers escape a value for a PowerShell single-quoted literal.
var quotedValueHelpers = map[string]bool{
	"psscript.EscapeSingleQuoted":  true,
	"psscript.Quote":               true,
	"EscapeSingleQuoted":           true,
	"Quote":                        true,
	"escapePSString":               true, // internal/backup/hyperv, delegates here
	"escapePowerShellSingleQuoted": true, // internal/remote/tools, delegates here
}

// literalValueExceptions lists values written between single quotes in a
// generated script without an escaping helper, per file, each with the reason
// it cannot contain a quote. Keys are the Go expression as written.
var literalValueExceptions = map[string]map[string]string{
	"internal/updater/restart_windows.go": {
		"safeAgent":        "escaped where assigned",
		"safeAgentTarget":  "escaped where assigned",
		"safeHelper":       "escaped where assigned",
		"safeHelperTarget": "escaped where assigned",
		"safeBackup":       "escaped where assigned",
		"safeBackupTarget": "escaped where assigned",
		"serviceName":      "constant",
		"name":             "constant process names",
	},
	"internal/updater/rollback_detached_script.go": {
		"payload": "escaped by rollbackJournalPayload",
	},
	"internal/heartbeat/handlers_uninstall.go": {
		"strings.ReplaceAll(s, \"'\", `'\\''`)": "POSIX sh quoting in shQuote, not PowerShell",
		"reason":                                "constant messages in the macOS sh script",
	},
	"internal/userhelper/notify_windows.go": {
		"notifyAUMID": "constant",
	},
	"internal/oemupdates/bitlockerguard/guard.go": {
		"drive": "checked against mountPointPattern (a drive letter)",
	},
	"internal/security/recoverykeys.go": {
		"mount": "checked by validBitLockerMount",
		"id":    "checked by validProtectorID",
	},
	"internal/oemupdates/lane_hp_bios.go": {
		"manifest": "checked against hpScriptSafePath",
	},
	"internal/backup/hyperv/restore_identity.go": {
		"id": "checked by validVMID",
	},
	"internal/collectors/eventlogs_winquery.go": {
		"provider":                                       "checked by validApplicationProviderName; an XPath literal",
		"seed.UTC().Format(winEventTimeFormat)":          "formatted time",
		"bookmark.Time.UTC().Format(winEventTimeFormat)": "formatted time",
		"floor.UTC().Format(winEventTimeFormat)":         "formatted time",
	},
	"internal/collectors/boot_performance_windows.go": {
		"bootStr": "formatted time",
	},
	"internal/collectors/timesync/system_events_windows.go": {
		"since.UTC().Format(time.RFC3339Nano)": "formatted time",
		"until.UTC().Format(time.RFC3339Nano)": "formatted time",
	},
	"internal/security/local_admin_group_probe.go": {
		"localAdminResolveMarker": "constant",
	},
}

// buildsPowerShell reports whether a source file generates PowerShell.
func buildsPowerShell(rel string, src []byte) bool {
	lower := bytes.ToLower(src)
	return bytes.Contains(lower, []byte("powershell")) || bytes.Contains(lower, []byte("pwsh")) ||
		bytes.Contains(src, []byte(`"github.com/breeze-rmm/agent/internal/psscript"`)) ||
		strings.HasPrefix(rel, "internal/backup/hyperv/")
}

// singleQuoteStates scans text in which single-quoted regions begin and end
// at ASCII apostrophes and reports, for each byte offset, whether it is inside
// one. inside is the state at the start of text; the state at the end is
// returned too.
func singleQuoteStates(text string, inside bool) ([]bool, bool) {
	states := make([]bool, len(text)+1)
	for i := 0; i < len(text); i++ {
		states[i] = inside
		if text[i] == '\'' {
			if inside && i+1 < len(text) && text[i+1] == '\'' {
				states[i+1] = inside
				i++
				continue
			}
			inside = !inside
		}
	}
	states[len(text)] = inside
	return states, inside
}

// stringConstant returns the value of a string literal, or of a + chain of
// string literals.
func stringConstant(e ast.Expr) (string, bool) {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(v.Value)
		return s, err == nil
	case *ast.BinaryExpr:
		if v.Op != token.ADD {
			return "", false
		}
		l, ok := stringConstant(v.X)
		if !ok {
			return "", false
		}
		r, ok := stringConstant(v.Y)
		return l + r, ok
	case *ast.ParenExpr:
		return stringConstant(v.X)
	}
	return "", false
}

func flattenAdd(e ast.Expr, out []ast.Expr) []ast.Expr {
	if b, ok := e.(*ast.BinaryExpr); ok && b.Op == token.ADD {
		return flattenAdd(b.Y, flattenAdd(b.X, out))
	}
	return append(out, e)
}

func exprString(fset *token.FileSet, e ast.Expr) string {
	var b bytes.Buffer
	_ = printer.Fprint(&b, fset, e)
	return b.String()
}

// quotedValueIsSafe reports whether value, written between single quotes,
// is escaped by a helper or listed as an exception for the file.
func quotedValueIsSafe(fset *token.FileSet, rel string, value ast.Expr) bool {
	if call, ok := value.(*ast.CallExpr); ok && quotedValueHelpers[exprString(fset, call.Fun)] {
		return true
	}
	_, listed := literalValueExceptions[rel][exprString(fset, value)]
	return listed
}

// TestPowerShellLiteralValuesAreEscaped finds values placed between single
// quotes in generated PowerShell, by fmt.Sprintf/Fprintf verbs or by string
// concatenation, and requires each to go through an escaping helper or to be
// listed, with its reason, in literalValueExceptions.
func TestPowerShellLiteralValuesAreEscaped(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	self, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	tsql := filepath.Join(root, "internal", "backup", "mssql")
	var offenders []string
	used := map[string]map[string]bool{}
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && (path == self || path == tsql || name == "vendor" || name == "testdata" || strings.HasPrefix(name, ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		rel = filepath.ToSlash(rel)
		if !buildsPowerShell(rel, src) {
			return nil
		}
		fset := token.NewFileSet()
		file, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			return err
		}
		report := func(value ast.Expr) {
			text := exprString(fset, value)
			if quotedValueIsSafe(fset, rel, value) {
				if used[rel] == nil {
					used[rel] = map[string]bool{}
				}
				used[rel][text] = true
				return
			}
			offenders = append(offenders, fset.Position(value.Pos()).String()+": "+text)
		}
		seen := map[ast.Expr]bool{}
		ast.Inspect(file, func(n ast.Node) bool {
			switch v := n.(type) {
			case *ast.CallExpr:
				fun := exprString(fset, v.Fun)
				formatArg := -1
				switch fun {
				case "fmt.Sprintf":
					formatArg = 0
				case "fmt.Fprintf":
					formatArg = 1
				}
				if formatArg < 0 || len(v.Args) <= formatArg {
					return true
				}
				format, ok := stringConstant(v.Args[formatArg])
				if !ok {
					return true
				}
				states, _ := singleQuoteStates(format, false)
				arg := formatArg + 1
				for i := 0; i < len(format); i++ {
					if format[i] != '%' {
						continue
					}
					if i+1 < len(format) && format[i+1] == '%' {
						i++
						continue
					}
					j := i + 1
					for j < len(format) && strings.ContainsRune("+-# 0123456789.", rune(format[j])) {
						j++
					}
					if j >= len(format) {
						break
					}
					if strings.ContainsRune("sqv", rune(format[j])) && states[i] && arg < len(v.Args) {
						report(v.Args[arg])
					}
					arg++
					i = j
				}
			case *ast.BinaryExpr:
				if v.Op != token.ADD || seen[v] {
					return true
				}
				parts := flattenAdd(v, nil)
				ast.Inspect(v, func(m ast.Node) bool {
					if b, ok := m.(*ast.BinaryExpr); ok {
						seen[b] = true
					}
					return true
				})
				inside := false
				for _, part := range parts {
					if s, ok := stringConstant(part); ok {
						_, inside = singleQuoteStates(s, inside)
						continue
					}
					if inside {
						report(part)
					}
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(offenders)
	if len(offenders) > 0 {
		t.Errorf("values written between single quotes in generated PowerShell must use psscript.EscapeSingleQuoted / psscript.Quote:\n%s",
			strings.Join(offenders, "\n"))
	}
	for rel, exprs := range literalValueExceptions {
		for expr := range exprs {
			if !used[rel][expr] {
				t.Errorf("literalValueExceptions[%q][%q] no longer matches anything; remove it", rel, expr)
			}
		}
	}
}
