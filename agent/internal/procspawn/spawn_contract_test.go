package procspawn

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/build/constraint"
	"go/parser"
	"go/token"
	"go/types"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The spawn contract (plan W2 Task 2, Review Focus 5): on Linux every child
// the agent starts must land in `<unit>/children` before exec, or a script or
// terminal inherits the management-plane permit. So, across agent/internal
// and agent/cmd (every OS, every build tag):
//
//  1. every process spawn goes through procspawn (Command, CommandContext,
//     Prepare, StartProcess), or carries `//procspawn:exempt <reason>` on its
//     own line or the line above;
//  2. in a file Linux can build, a function that assigns `.SysProcAttr`
//     (which would replace the cgroup placement) calls procspawn.Prepare
//     after that assignment.
//
// Exempt means "this child stays in the spawner's cgroup": only Breeze's own
// binaries that need the agent's permit, or code that is not running in the
// agent process at all.

const exemptMarker = "//procspawn:exempt"

type spawnAPI struct{ pkg, name string }

// spawners are the calls that create a process. syscall.Exec is not one: it
// replaces the image in place and keeps the caller's cgroup.
var spawners = map[spawnAPI]bool{
	{"os/exec", "Command"}:                      true,
	{"os/exec", "CommandContext"}:               true,
	{"os", "StartProcess"}:                      true,
	{"syscall", "ForkExec"}:                     true,
	{"syscall", "StartProcess"}:                 true,
	{"github.com/creack/pty", "Start"}:          true,
	{"github.com/creack/pty", "StartWithSize"}:  true,
	{"github.com/creack/pty", "StartWithAttrs"}: true,
}

const procspawnPath = "github.com/breeze-rmm/agent/internal/procspawn"

type violation struct {
	pos  token.Position
	what string
}

func (v violation) String() string {
	return fmt.Sprintf("%s:%d: %s", filepath.ToSlash(v.pos.Filename), v.pos.Line, v.what)
}

func TestEverySpawnIsPlacedOrExempt(t *testing.T) {
	var violations []violation
	files := 0
	for _, root := range []string{"../../internal", "../../cmd"} {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() {
				if filepath.Base(path) == "testdata" || filepath.Clean(path) == filepath.Clean("../../internal/procspawn") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			files++
			found, err := checkFile(path)
			if err != nil {
				return err
			}
			violations = append(violations, found...)
			return nil
		})
		if err != nil {
			t.Fatalf("walk %s: %v", root, err)
		}
	}
	if files < 500 {
		t.Fatalf("scanned only %d files; the walk roots are wrong", files)
	}
	sort.Slice(violations, func(i, j int) bool { return violations[i].String() < violations[j].String() })
	for _, v := range violations {
		t.Error(v)
	}
	if len(violations) > 0 {
		t.Logf("%d spawn-contract violations: use procspawn.Command/CommandContext/Prepare/StartProcess, or add `%s <reason>`", len(violations), exemptMarker)
	}
}

func checkFile(path string) ([]violation, error) {
	src, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, src, parser.ParseComments)
	if err != nil {
		return nil, err
	}
	var out []violation
	imports := map[string]string{} // local name -> import path
	for _, imp := range file.Imports {
		p, _ := strconv.Unquote(imp.Path.Value)
		name := p[strings.LastIndex(p, "/")+1:]
		if imp.Name != nil {
			name = imp.Name.Name
		}
		if name == "." {
			for api := range spawners {
				if api.pkg == p {
					out = append(out, violation{fset.Position(imp.Pos()), "dot import of " + p + " hides its spawns from this contract"})
					break
				}
			}
			continue
		}
		imports[name] = p
	}
	exempt, standalone, badMarkers := exemptLines(fset, file, src)
	for _, line := range badMarkers {
		out = append(out, violation{fset.Position(file.Pos()), fmt.Sprintf("line %d: %s needs a reason", line, exemptMarker)})
		out[len(out)-1].pos.Line = line
	}
	// A marker exempts its own line, or the next line when it stands alone:
	// a marker trailing unrelated code does not reach past it.
	isExempt := func(pos token.Pos) bool {
		line := fset.Position(pos).Line
		return exempt[line] || standalone[line-1]
	}
	selector := func(expr ast.Expr) (string, string, bool) {
		sel, ok := expr.(*ast.SelectorExpr)
		if !ok {
			return "", "", false
		}
		id, ok := sel.X.(*ast.Ident)
		if !ok || id.Obj != nil { // a local variable, not a package
			return "", "", false
		}
		pkg, ok := imports[id.Name]
		return pkg, sel.Sel.Name, ok
	}
	isPrepare := func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return false
		}
		pkg, name, ok := selector(call.Fun)
		return ok && pkg == procspawnPath && name == "Prepare"
	}

	// Rule 1: every spawn is a procspawn call or exempt.
	var stack []ast.Node
	ast.Inspect(file, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return true
		}
		parent := ast.Node(nil)
		if len(stack) > 0 {
			parent = stack[len(stack)-1]
		}
		stack = append(stack, n)
		wrapped := func() bool {
			if isPrepare(parent) {
				return true
			}
			// &exec.Cmd{...} as the argument of Prepare.
			if u, ok := parent.(*ast.UnaryExpr); ok && u.Op == token.AND && len(stack) >= 3 {
				return isPrepare(stack[len(stack)-3])
			}
			return false
		}
		switch node := n.(type) {
		case *ast.CallExpr:
			pkg, name, ok := selector(node.Fun)
			if ok && spawners[spawnAPI{pkg, name}] && !isExempt(node.Pos()) && !wrapped() {
				out = append(out, violation{fset.Position(node.Pos()), fmt.Sprintf("%s.%s spawns outside procspawn", pkg, name)})
			}
			if id, isIdent := node.Fun.(*ast.Ident); isIdent && id.Name == "new" && len(node.Args) == 1 {
				if p, n, ok := selector(node.Args[0]); ok && p == "os/exec" && n == "Cmd" && !isExempt(node.Pos()) {
					out = append(out, violation{fset.Position(node.Pos()), "new(exec.Cmd) spawns outside procspawn"})
				}
			}
		case *ast.SelectorExpr:
			// exec.Command taken as a function value (a test seam such as
			// `var run = exec.Command`) would spawn outside procspawn later.
			pkg, name, ok := selector(node)
			call, isCall := parent.(*ast.CallExpr)
			if ok && spawners[spawnAPI{pkg, name}] && (!isCall || call.Fun != ast.Expr(node)) && !isExempt(node.Pos()) {
				out = append(out, violation{fset.Position(node.Pos()), fmt.Sprintf("%s.%s used as a function value escapes procspawn", pkg, name)})
			}
		case *ast.ValueSpec, *ast.Field:
			// A value exec.Cmd (a variable or struct field) can be started
			// without ever passing through Command or Prepare.
			var typ ast.Expr
			if spec, ok := node.(*ast.ValueSpec); ok {
				typ = spec.Type
			} else {
				typ = node.(*ast.Field).Type
			}
			if pkg, name, ok := selector(typ); ok && pkg == "os/exec" && name == "Cmd" && !isExempt(typ.Pos()) {
				out = append(out, violation{fset.Position(typ.Pos()), "a value exec.Cmd escapes procspawn; use *exec.Cmd from procspawn.Command"})
			}
		case *ast.CompositeLit:
			if pkg, name, ok := selector(node.Type); ok && pkg == "os/exec" && name == "Cmd" && !isExempt(node.Pos()) && !wrapped() {
				out = append(out, violation{fset.Position(node.Pos()), "exec.Cmd literal spawns outside procspawn (wrap it in procspawn.Prepare)"})
			}
		}
		return true
	})

	// Rule 2: a SysProcAttr assignment is followed by procspawn.Prepare.
	if linuxCanBuild(path, file) {
		checkBody := func(body *ast.BlockStmt) {
			if body == nil {
				return
			}
			type site struct {
				pos    token.Pos
				target string // the command expression, e.g. "cmd" or "h.cmd"
			}
			var assigns, prepares []site
			ast.Inspect(body, func(n ast.Node) bool {
				if _, nested := n.(*ast.FuncLit); nested && n != ast.Node(body) {
					return false // a closure is checked on its own
				}
				switch node := n.(type) {
				case *ast.AssignStmt:
					for _, lhs := range node.Lhs {
						// `x.SysProcAttr = ...` and `*x.SysProcAttr = ...` both
						// replace the placement.
						for {
							if star, ok := lhs.(*ast.StarExpr); ok {
								lhs = star.X
							} else if paren, ok := lhs.(*ast.ParenExpr); ok {
								lhs = paren.X
							} else {
								break
							}
						}
						if sel, ok := lhs.(*ast.SelectorExpr); ok && sel.Sel.Name == "SysProcAttr" {
							assigns = append(assigns, site{node.Pos(), types.ExprString(sel.X)})
						}
					}
				case *ast.CallExpr:
					if isPrepare(node) && len(node.Args) == 1 {
						prepares = append(prepares, site{node.Pos(), types.ExprString(node.Args[0])})
					}
				}
				return true
			})
			for _, a := range assigns {
				ok := isExempt(a.pos)
				for _, p := range prepares {
					if p.pos > a.pos && p.target == a.target {
						ok = true
					}
				}
				if !ok {
					out = append(out, violation{fset.Position(a.pos), "SysProcAttr assignment replaces the cgroup placement; call procspawn.Prepare(" + a.target + ") after it"})
				}
			}
		}
		ast.Inspect(file, func(n ast.Node) bool {
			switch fn := n.(type) {
			case *ast.FuncDecl:
				checkBody(fn.Body)
			case *ast.FuncLit:
				checkBody(fn.Body)
			}
			return true
		})
	}
	return out, nil
}

// exemptLines returns the lines carrying a reasoned exempt marker, the subset
// where the marker is alone on its line, and the lines whose marker has no
// reason.
func exemptLines(fset *token.FileSet, file *ast.File, src []byte) (map[int]bool, map[int]bool, []int) {
	lines := map[int]bool{}
	standalone := map[int]bool{}
	var bad []int
	for _, group := range file.Comments {
		for _, c := range group.List {
			if !strings.HasPrefix(c.Text, exemptMarker) {
				continue
			}
			line := fset.Position(c.Pos()).Line
			if strings.TrimSpace(strings.TrimPrefix(c.Text, exemptMarker)) == "" {
				bad = append(bad, line)
				continue
			}
			lines[line] = true
			offset := fset.Position(c.Pos()).Offset
			start := bytes.LastIndexByte(src[:offset], '\n') + 1
			if len(bytes.TrimSpace(src[start:offset])) == 0 {
				standalone[line] = true
			}
		}
	}
	return lines, standalone, bad
}

var knownOS = map[string]bool{
	"aix": true, "android": true, "darwin": true, "dragonfly": true, "freebsd": true, "hurd": true,
	"illumos": true, "ios": true, "js": true, "linux": true, "nacl": true, "netbsd": true, "openbsd": true,
	"plan9": true, "solaris": true, "wasip1": true, "windows": true, "zos": true,
}

// linuxCanBuild reports whether some GOARCH/tag combination builds this file
// for GOOS=linux.
func linuxCanBuild(path string, file *ast.File) bool {
	base := strings.TrimSuffix(filepath.Base(path), ".go")
	parts := strings.Split(base, "_")
	for i := len(parts) - 1; i >= 1 && i >= len(parts)-2; i-- {
		if knownOS[parts[i]] && parts[i] != "linux" {
			return false
		}
	}
	var expr constraint.Expr
	for _, group := range file.Comments {
		if group.Pos() >= file.Package {
			break
		}
		for _, c := range group.List {
			if constraint.IsGoBuild(c.Text) {
				expr, _ = constraint.Parse(c.Text)
			}
		}
	}
	if expr == nil {
		return true
	}
	var free []string
	seen := map[string]bool{}
	var collect func(constraint.Expr)
	collect = func(e constraint.Expr) {
		switch x := e.(type) {
		case *constraint.TagExpr:
			if !knownOS[x.Tag] && x.Tag != "unix" && x.Tag != "ignore" && !seen[x.Tag] {
				seen[x.Tag] = true
				free = append(free, x.Tag)
			}
		case *constraint.NotExpr:
			collect(x.X)
		case *constraint.AndExpr:
			collect(x.X)
			collect(x.Y)
		case *constraint.OrExpr:
			collect(x.X)
			collect(x.Y)
		}
	}
	collect(expr)
	if len(free) > 12 {
		return true // treat as buildable rather than enumerate
	}
	for mask := 0; mask < 1<<len(free); mask++ {
		set := map[string]bool{}
		for i, tag := range free {
			set[tag] = mask&(1<<i) != 0
		}
		if expr.Eval(func(tag string) bool {
			switch {
			case tag == "linux" || tag == "unix":
				return true
			case knownOS[tag] || tag == "ignore":
				return false
			default:
				return set[tag]
			}
		}) {
			return true
		}
	}
	return false
}

// The checker itself must catch what it claims to.
func TestContractCheckerCatchesViolations(t *testing.T) {
	dir := t.TempDir()
	write := func(name, src string) string {
		path := filepath.Join(dir, name)
		if err := writeFile(path, src); err != nil {
			t.Fatal(err)
		}
		return path
	}
	cases := []struct {
		name, file, src string
		want            int
	}{
		{"bare exec.Command", "a.go", `package a
import "os/exec"
func f() { _ = exec.Command("x") }`, 1},
		{"aliased exec", "b.go", `package a
import osexec "os/exec"
func f() { _ = osexec.CommandContext(nil, "x") }`, 1},
		{"exempt with reason", "c.go", `package a
import "os/exec"
func f() {
	//procspawn:exempt re-exec of the agent itself
	_ = exec.Command("x")
}`, 0},
		{"exempt without reason", "d.go", `package a
import "os/exec"
func f() {
	//procspawn:exempt
	_ = exec.Command("x")
}`, 2},
		{"procspawn call", "e.go", `package a
import "github.com/breeze-rmm/agent/internal/procspawn"
func f() { _ = procspawn.Command("x") }`, 0},
		{"wrapped literal", "f.go", `package a
import ("os/exec"; "github.com/breeze-rmm/agent/internal/procspawn")
func f() { _ = procspawn.Prepare(&exec.Cmd{Path: "x"}) }`, 0},
		{"bare literal", "g.go", `package a
import "os/exec"
func f() { _ = &exec.Cmd{Path: "x"} }`, 1},
		{"SysProcAttr clobber", "h.go", `package a
import ("syscall"; "github.com/breeze-rmm/agent/internal/procspawn")
func f() { c := procspawn.Command("x"); c.SysProcAttr = &syscall.SysProcAttr{} }`, 1},
		{"SysProcAttr then Prepare", "i.go", `package a
import ("syscall"; "github.com/breeze-rmm/agent/internal/procspawn")
func f() { c := procspawn.Command("x"); c.SysProcAttr = &syscall.SysProcAttr{}; procspawn.Prepare(c) }`, 0},
		{"SysProcAttr in a windows file", "j_windows.go", `package a
import "syscall"
func f(c interface{}) { var x struct{ SysProcAttr *syscall.SysProcAttr }; x.SysProcAttr = nil }`, 0},
		{"SysProcAttr under a darwin tag", "k.go", `//go:build darwin

package a
import "syscall"
func f() { var x struct{ SysProcAttr *syscall.SysProcAttr }; x.SysProcAttr = nil }`, 0},
		{"SysProcAttr under !cgo", "l.go", `//go:build !cgo

package a
import "syscall"
func f() { var x struct{ SysProcAttr *syscall.SysProcAttr }; x.SysProcAttr = nil }`, 1},
		{"ForkExec", "m.go", `package a
import "syscall"
func f() { _, _ = syscall.ForkExec("x", nil, nil) }`, 1},
		{"syscall.Exec is not a spawn", "n.go", `package a
import "syscall"
func f() { _ = syscall.Exec("x", nil, nil) }`, 0},
		{"zero-value exec.Cmd variable", "q.go", `package a
import "os/exec"
func f() { var c exec.Cmd; c.Path = "x"; _ = c.Start() }`, 1},
		{"exec.Cmd struct field", "r.go", `package a
import "os/exec"
type runner struct{ cmd exec.Cmd }`, 1},
		{"pointer to exec.Cmd is fine", "s.go", `package a
import "os/exec"
type runner struct{ cmd *exec.Cmd }
func f(c *exec.Cmd) {}`, 0},
		{"Prepare on another command", "t.go", `package a
import ("syscall"; "github.com/breeze-rmm/agent/internal/procspawn")
func f() { a := procspawn.Command("x"); b := procspawn.Command("y"); a.SysProcAttr = &syscall.SysProcAttr{}; procspawn.Prepare(b) }`, 1},
		{"deref SysProcAttr clobber", "u.go", `package a
import ("syscall"; "github.com/breeze-rmm/agent/internal/procspawn")
func f() { c := procspawn.Command("x"); *c.SysProcAttr = syscall.SysProcAttr{} }`, 1},
		{"dot import of os/exec", "v.go", `package a
import . "os/exec"
func f() { _ = Command("x") }`, 1},
		{"trailing marker does not exempt the next line", "w.go", `package a
import "os/exec"
func f() {
	_ = 1 //procspawn:exempt unrelated
	_ = exec.Command("x")
}`, 1},
		{"function value seam", "p.go", `package a
import "os/exec"
var run = exec.Command`, 1},
		{"local variable named exec", "o.go", `package a
type runner struct{}
func (runner) Command(string) {}
func f() { exec := runner{}; exec.Command("x") }`, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := checkFile(write(tc.file, tc.src))
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != tc.want {
				t.Fatalf("got %d violations %v, want %d", len(got), got, tc.want)
			}
		})
	}
}
