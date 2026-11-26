package backup

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The originals guard never touches the file system with a path the
// snapshot supplies (#12638, #12660): it reads every recorded path and the
// target lexically, so nothing a snapshot records can make it stat, open or
// resolve a location, and no answer the file system gives can turn a path
// it could not read into a pass. Its only file access is the second pass it
// is handed (originalSource: the restore's own verified manifest file).
//
// This test holds that by source: it walks every function the guard's file
// declares and every same-package function they name (called or used as a
// value), and fails on any reference to another package that is not on the
// reviewed list below (os, io/fs, syscall, golang.org/x/sys,
// filepath.EvalSymlinks/Abs/Walk/Glob are deliberately absent) and on any
// same-package function or variable outside the guard file that is not on
// the reviewed helper list. A new callee is not wrong, but it must be read
// and added here on purpose. Other packages' functions on the list are
// trusted, not walked; methods are matched by name (see inspect).
func TestOriginalsGuard_NoFileSystemAccess(t *testing.T) {
	// References to other packages the guard (or a helper it calls) may
	// make. Each is lexical. securefs.CleanRelative is filepath.Clean plus,
	// on Windows, a per-component name check (ValidateWindowsComponents):
	// neither reads the file system.
	allowedExternal := map[string]bool{
		"errors.New": true, "errors.AsType": true,
		"fmt.Sprintf": true, "fmt.Errorf": true,
		"log/slog.Warn":                      true,
		"path/filepath.Join":                 true,
		"path/filepath.VolumeName":           true,
		"runtime.GOOS":                       true,
		"unicode/utf8.RuneCountInString":     true,
		"golang.org/x/text/unicode/norm.NFC": true,
		"golang.org/x/text/cases.Fold":       true,
		"github.com/breeze-rmm/agent/internal/securefs.CleanRelative": true,
	}
	allowedExternalPackages := map[string]bool{"strings": true}
	// Same-package helpers outside the guard file that it reaches, each read
	// and found lexical; they are walked too.
	reviewedHelpers := map[string]bool{
		"restoreRelativePath":             true,
		"stripVolumeAndLeadingSeparators": true,
		"restoreSourcePath":               true,
		"journalEntryKey":                 true,
		"foldObjectKey":                   true,
		"SnapshotJunction.restorePath":    true,
	}
	// Same-package variables holding functions the guard calls, and the
	// only value each may hold.
	reviewedFuncVars := map[string]string{"volumeName": "filepath.VolumeName"}

	const guardFile = "restore_overwrite_guard.go"
	pkg := parseBackupPackage(t)

	var violations []string
	visited := map[*ast.FuncDecl]bool{}
	var queue []*ast.FuncDecl
	enqueue := func(fd *ast.FuncDecl) {
		if !visited[fd] {
			visited[fd] = true
			queue = append(queue, fd)
		}
	}
	// inspect checks one guard-reached node: every reference to another
	// package, and every same-package function, method or variable it
	// names, called or used as a value.
	inspect := func(file *parsedGoFile, where string, node ast.Node, locals map[string]bool) {
		if _, ok := file.imports["."]; ok {
			violations = append(violations, where+" is in a file with a dot import, which this walk cannot resolve")
		}
		var visit func(ast.Node) bool
		visit = func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.SelectorExpr:
				if id, ok := n.X.(*ast.Ident); ok {
					if path, isImport := file.imports[id.Name]; isImport && !locals[id.Name] {
						if !allowedExternal[path+"."+n.Sel.Name] && !allowedExternalPackages[path] {
							violations = append(violations, where+" references "+path+"."+n.Sel.Name)
						}
						return false
					}
				}
				// x.Name: a field, or a method of x's type, called or used
				// as a value. Without type information it is resolved by
				// name: every same-package method so named that the guard
				// file declares or that is reviewed is walked, and a name
				// only unreviewed methods carry fails. Known limit: a call
				// that reaches an unreviewed method sharing its name with a
				// guard or reviewed one (String, Error, check, …) is not
				// told apart from it. A name no method here carries is a
				// field, or a method of another package's type.
				candidates := pkg.methods[n.Sel.Name]
				reached := false
				for _, fd := range candidates {
					if pkg.file[fd] == guardFile || reviewedHelpers[funcKey(fd)] {
						enqueue(fd)
						reached = true
					}
				}
				if len(candidates) > 0 && !reached {
					violations = append(violations, where+" may call "+n.Sel.Name+", a method only unreviewed types here declare")
				}
				ast.Inspect(n.X, visit)
				return false
			case *ast.KeyValueExpr:
				if _, ok := n.Key.(*ast.Ident); ok {
					ast.Inspect(n.Value, visit) // a struct field name as key
					return false
				}
			case *ast.Ident:
				if locals[n.Name] {
					return true
				}
				if fds, ok := pkg.funcs[n.Name]; ok {
					for _, fd := range fds {
						if pkg.file[fd] != guardFile && !reviewedHelpers[n.Name] {
							violations = append(violations, where+" uses "+n.Name+" ("+pkg.file[fd]+"), not a reviewed helper")
						}
						enqueue(fd)
					}
				} else if _, ok := pkg.vars[n.Name]; ok && pkg.varFile[n.Name] != guardFile {
					if want, reviewed := reviewedFuncVars[n.Name]; !reviewed || pkg.vars[n.Name] != want {
						violations = append(violations, where+" uses the package variable "+n.Name+" ("+pkg.varFile[n.Name]+" = "+pkg.vars[n.Name]+"), not a reviewed one")
					}
				}
			}
			return true
		}
		ast.Inspect(node, visit)
	}

	guard := pkg.files[guardFile]
	if guard == nil {
		t.Fatalf("%s not found in the package", guardFile)
	}
	for _, decl := range guard.ast.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			enqueue(d)
		case *ast.GenDecl:
			inspect(guard, guardFile+" declarations", d, nil)
		}
	}
	walked := map[string]bool{}
	for len(queue) > 0 {
		fd := queue[0]
		queue = queue[1:]
		name := funcKey(fd)
		walked[name] = true
		locals := localNames(fd)
		for local := range locals {
			if _, isFunc := pkg.funcs[local]; isFunc {
				violations = append(violations, name+" declares "+local+", shadowing a package function the walk would then miss")
			} else if _, isVar := pkg.vars[local]; isVar {
				violations = append(violations, name+" declares "+local+", shadowing a package variable the walk would then miss")
			}
		}
		if fd.Body != nil {
			inspect(pkg.files[pkg.file[fd]], name, fd.Body, locals)
		}
	}
	// The walk must reach the guard's entry points and the helpers, or it
	// proves nothing.
	for _, want := range []string{"originalsGuard.check", "originalsGuard.observing", "refuseRestoreOverOriginals", "restoreRelativePath", "foldObjectKey"} {
		if !walked[want] {
			t.Errorf("the walk did not reach %s", want)
		}
	}
	sort.Strings(violations)
	for _, v := range violations {
		t.Errorf("originals guard: %s", v)
	}
}

type parsedGoFile struct {
	ast     *ast.File
	imports map[string]string // local name → import path
}

type parsedBackupPackage struct {
	files   map[string]*parsedGoFile
	file    map[*ast.FuncDecl]string   // declaration → file name
	funcs   map[string][]*ast.FuncDecl // package-level functions (one per build variant)
	methods map[string][]*ast.FuncDecl
	vars    map[string]string // package-level variable → its initializer, as written
	varFile map[string]string // package-level variable → file name
}

// parseBackupPackage parses every non-test file of this package, whatever
// its build constraints, so a Windows-only helper is walked on any host.
func parseBackupPackage(t *testing.T) *parsedBackupPackage {
	t.Helper()
	names, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	pkg := &parsedBackupPackage{
		files: map[string]*parsedGoFile{}, file: map[*ast.FuncDecl]string{},
		funcs: map[string][]*ast.FuncDecl{}, methods: map[string][]*ast.FuncDecl{}, vars: map[string]string{}, varFile: map[string]string{},
	}
	for _, name := range names {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		f, err := parser.ParseFile(fset, name, src, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		pf := &parsedGoFile{ast: f, imports: map[string]string{}}
		for _, imp := range f.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			local := path[strings.LastIndex(path, "/")+1:]
			if imp.Name != nil {
				local = imp.Name.Name
			}
			pf.imports[local] = path
		}
		pkg.files[name] = pf
		for _, decl := range f.Decls {
			switch d := decl.(type) {
			case *ast.FuncDecl:
				pkg.file[d] = name
				if d.Recv == nil {
					pkg.funcs[d.Name.Name] = append(pkg.funcs[d.Name.Name], d)
				} else {
					pkg.methods[d.Name.Name] = append(pkg.methods[d.Name.Name], d)
				}
			case *ast.GenDecl:
				if d.Tok != token.VAR {
					continue
				}
				for _, spec := range d.Specs {
					vs := spec.(*ast.ValueSpec)
					for i, id := range vs.Names {
						pkg.varFile[id.Name] = name
						if i < len(vs.Values) {
							pkg.vars[id.Name] = string(src[fset.Position(vs.Values[i].Pos()).Offset:fset.Position(vs.Values[i].End()).Offset])
						} else {
							pkg.vars[id.Name] = ""
						}
					}
				}
			}
		}
	}
	return pkg
}

// localNames is every name fd declares anywhere in it (receiver,
// parameters, results, := and var declarations, closures' parameters):
// such a name in fd's body is not a package-level one. Per function rather
// than per scope, so a package-level name fd also declares locally would
// not be walked in fd: the test fails on any such name.
func localNames(fd *ast.FuncDecl) map[string]bool {
	locals := map[string]bool{}
	add := func(ids ...*ast.Ident) {
		for _, id := range ids {
			locals[id.Name] = true
		}
	}
	ast.Inspect(fd, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.Field:
			add(n.Names...)
		case *ast.ValueSpec:
			add(n.Names...)
		case *ast.AssignStmt:
			if n.Tok == token.DEFINE {
				for _, lhs := range n.Lhs {
					if id, ok := lhs.(*ast.Ident); ok {
						add(id)
					}
				}
			}
		case *ast.RangeStmt:
			if n.Tok == token.DEFINE {
				for _, e := range []ast.Expr{n.Key, n.Value} {
					if id, ok := e.(*ast.Ident); ok {
						add(id)
					}
				}
			}
		}
		return true
	})
	return locals
}

func receiverName(fd *ast.FuncDecl) string {
	if fd.Recv == nil || len(fd.Recv.List) == 0 {
		return ""
	}
	expr := fd.Recv.List[0].Type
	if star, ok := expr.(*ast.StarExpr); ok {
		expr = star.X
	}
	if id, ok := expr.(*ast.Ident); ok {
		return id.Name
	}
	return ""
}

func funcKey(fd *ast.FuncDecl) string {
	if r := receiverName(fd); r != "" {
		return r + "." + fd.Name.Name
	}
	return fd.Name.Name
}
