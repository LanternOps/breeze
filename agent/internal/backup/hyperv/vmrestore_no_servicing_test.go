package hyperv

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// These tests read this package's own source. RestoreAsVM and InstantBoot
// only compile on Windows and need a live Hyper-V host end to end, so the
// rules below are checked on the code itself, on every OS. Build tags do not
// matter to the parser, so the Windows-only files and any new file are all
// covered. Only this package is scanned.

// imageServicingCommand matches offline Windows image-servicing commands:
// DISM and its API (a word on its own, so Dismount-VHD is not a match), the
// PowerShell *-Windows<Image|Driver|Package|...> cmdlets, provisioned-package
// cmdlets, /Image: switches, pnputil, and offline hive loads. RestoreAsVM and
// instant boot never service the restored image.
var imageServicingCommand = regexp.MustCompile(`(?i)\bdism(\.exe|api)?\b|add-driver|-windows(image|driver|package|optionalfeature|capability|edition|unattend|productkey)\b|appxprovisionedpackage|/image[:=]|pnputil|\breg(\.exe)?\s+load\b`)

// bcdbootCommandLine matches bcdboot written out as a command line — the
// name (optionally quoted, as in `& "…\bcdboot.exe" …`) followed by an
// argument. bcdboot runs only as the argv bcdbootCommand builds, so no
// string spells it out; error text ("bcdboot: …", "bcdboot (…)") is fine.
var bcdbootCommandLine = regexp.MustCompile(`(?i)\bbcdboot(\.exe)?["']?\s+[^\s(]`)

func parsePackage(t *testing.T) (*token.FileSet, map[string]*ast.File) {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	fset := token.NewFileSet()
	files := map[string]*ast.File{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		files[name] = f
	}
	// The restore entry points must have been read, or the scan proves
	// nothing.
	for _, must := range []string{"vmrestore.go", "instantboot.go", "bootloader.go", "discovery.go", "ps_context.go"} {
		if files[must] == nil {
			t.Fatalf("%s was not scanned", must)
		}
	}
	return fset, files
}

// foldString returns the value of a string literal, or of a +-chain made
// only of string literals ("di" + "sm"), so a split name is still seen.
func foldString(e ast.Expr) (string, bool) {
	switch x := e.(type) {
	case *ast.BasicLit:
		if x.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(x.Value)
		if err != nil {
			return x.Value, true
		}
		return s, true
	case *ast.ParenExpr:
		return foldString(x.X)
	case *ast.BinaryExpr:
		if x.Op != token.ADD {
			return "", false
		}
		l, ok := foldString(x.X)
		if !ok {
			return "", false
		}
		r, ok := foldString(x.Y)
		if !ok {
			return "", false
		}
		return l + r, true
	}
	return "", false
}

type stringLiteral struct {
	file, pos, value string
	plain            bool // a single literal, not a folded +-chain
}

// packageStrings returns every string literal (and every literal-only
// +-chain, folded) in every non-test source file of this package.
func packageStrings(t *testing.T) []stringLiteral {
	t.Helper()
	fset, files := parsePackage(t)
	var out []stringLiteral
	for name, f := range files {
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.BinaryExpr:
				if s, ok := foldString(x); ok {
					out = append(out, stringLiteral{name, fset.Position(x.Pos()).String(), s, false})
					return false
				}
			case *ast.BasicLit:
				if s, ok := foldString(x); ok {
					out = append(out, stringLiteral{name, fset.Position(x.Pos()).String(), s, true})
				}
			}
			return true
		})
	}
	return out
}

func TestHyperVRestores_NeverServiceTheRestoredImage(t *testing.T) {
	for _, lit := range packageStrings(t) {
		if m := imageServicingCommand.FindString(lit.value); m != "" {
			t.Errorf("%s: string runs %q — restored images are never serviced offline", lit.pos, m)
		}
	}
}

// Instant boot's bcdboot is the host's own binary by absolute path
// (bcdbootCommand): no string spells bcdboot out as a command line, and the
// tool name appears only as hosttool.SystemTool's argument in bootloader.go.
func TestHyperVRestores_RunBcdbootOnlyByAbsolutePath(t *testing.T) {
	fset, files := parsePackage(t)
	allowed := map[string]bool{} // source positions of the permitted literal
	ast.Inspect(files["bootloader.go"], func(n ast.Node) bool {
		if call, ok := n.(*ast.CallExpr); ok && isSelector(call.Fun, "hosttool", "SystemTool") && len(call.Args) == 1 {
			if lit, ok := call.Args[0].(*ast.BasicLit); ok {
				allowed[fset.Position(lit.Pos()).String()] = true
			}
		}
		return true
	})
	if len(allowed) != 1 {
		t.Fatalf("bootloader.go: want exactly one hosttool.SystemTool(\"bcdboot.exe\") call, found %d", len(allowed))
	}
	for _, lit := range packageStrings(t) {
		if bcdbootCommandLine.MatchString(lit.value) {
			t.Errorf("%s: %q runs bcdboot by name — use bcdbootCommand", lit.pos, lit.value)
		}
		if strings.Contains(strings.ToLower(lit.value), "bcdboot.exe") && (!lit.plain || !allowed[lit.pos]) {
			t.Errorf("%s: %q names bcdboot.exe outside bcdbootCommand's hosttool.SystemTool call", lit.pos, lit.value)
		}
	}
}

// Every process this package starts is a host System32 binary by absolute
// path: powershell.exe via powerShellExe(), and bcdboot via bcdbootCommand.
// Each process-start call site is on this allowlist, so a new
// exec.Command("…") — by bare name, or on the restored volume — fails here.
func TestHyperVRestores_StartProcessesOnlyFromHostSystem32(t *testing.T) {
	fset, files := parsePackage(t)
	processStart := map[[2]string]int{ // pkg.Func -> index of the program argument
		{"exec", "Command"}:          0,
		{"exec", "CommandContext"}:   1,
		{"os", "StartProcess"}:       0,
		{"syscall", "StartProcess"}:  0,
		{"windows", "CreateProcess"}: 1,
		{"windows", "ShellExecute"}:  2,
	}
	sites := 0
	for name, f := range files {
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				pos := fset.Position(call.Pos()).String()
				// runCmdContext is only ever handed powershell.exe.
				if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "runCmdContext" {
					if len(call.Args) < 3 || !isCallTo(call.Args[2], "powerShellExe") {
						t.Errorf("%s: runCmdContext must be given powerShellExe()", pos)
					}
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				pkg, ok := sel.X.(*ast.Ident)
				if !ok {
					return true
				}
				idx, isStart := processStart[[2]string{pkg.Name, sel.Sel.Name}]
				if !isStart {
					return true
				}
				sites++
				if idx >= len(call.Args) {
					t.Errorf("%s: %s.%s with too few arguments", pos, pkg.Name, sel.Sel.Name)
					return true
				}
				prog := call.Args[idx]
				switch {
				case isCallTo(prog, "powerShellExe"):
				case name == "ps_context.go" && fn.Name.Name == "runCmdContext" && isIdent(prog, "name"):
				case name == "instantboot.go" && fn.Name.Name == "configureBootLoader" && isIdent(prog, "exe") && assignsFrom(fn.Body, "exe", "bcdbootCommand"):
				default:
					t.Errorf("%s: %s.%s starts a program not resolved from the host's System32 — use powerShellExe() or bcdbootCommand", pos, pkg.Name, sel.Sel.Name)
				}
				return true
			})
		}
	}
	if sites < 3 {
		t.Fatalf("found only %d process-start sites; the scan is not seeing the package", sites)
	}
}

func isSelector(e ast.Expr, pkg, name string) bool {
	sel, ok := e.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == pkg && sel.Sel.Name == name
}

func isIdent(e ast.Expr, name string) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == name
}

func isCallTo(e ast.Expr, fn string) bool {
	call, ok := e.(*ast.CallExpr)
	return ok && isIdent(call.Fun, fn)
}

// assignsFrom reports whether body assigns ident (first on the left) from a
// call to fn, e.g. `exe, args, err := bcdbootCommand(driveLetter)`.
func assignsFrom(body *ast.BlockStmt, ident, fn string) bool {
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if ok && len(as.Lhs) > 0 && len(as.Rhs) == 1 && isIdent(as.Lhs[0], ident) && isCallTo(as.Rhs[0], fn) {
			found = true
		}
		return !found
	})
	return found
}

// The patterns must still recognise the commands they exist for, and must
// not trip on VHD teardown, the tool name itself, or error text.
func TestRestoreCommandPatterns(t *testing.T) {
	for _, s := range []string{
		`dism /Image:E: /Add-Driver /Driver:C:\x`,
		`DISM.exe /image:E:\ /get-drivers`,
		`dismapi.dll`,
		`Add-WindowsDriver -Path E:\ -Driver C:\d`,
		`Get-WindowsDriver -Path E:\`,
		`Add-WindowsPackage -Path E:\ -PackagePath x.cab`,
		`Enable-WindowsOptionalFeature -Path E:\ -FeatureName x`,
		`Use-WindowsUnattend -Path E:\ -UnattendPath u.xml`,
		`Mount-WindowsImage -ImagePath x.wim`,
		`Add-AppxProvisionedPackage -Path E:\`,
		`pnputil.exe`,
		`reg load HKLM\X E:\Windows\System32\config\SYSTEM`,
	} {
		if !imageServicingCommand.MatchString(s) {
			t.Errorf("servicing pattern misses %q", s)
		}
	}
	for _, s := range []string{`Dismount-VHD -Path 'x'`, "dismounting_vhdx", `bcdboot.exe`, `Get-VM -Id 'x'`, `Mount-VHD -Path 'x' -PassThru`} {
		if imageServicingCommand.MatchString(s) {
			t.Errorf("servicing pattern false-positives on %q", s)
		}
	}
	for _, s := range []string{
		`bcdboot %s:\Windows /s %s: /f UEFI`,
		`BCDBOOT.EXE E:\Windows /s E:`,
		`bcdboot E:\Windows /f UEFI /s E:`,
		`& "E:\Windows\System32\bcdboot.exe" E:\Windows /s E:`,
	} {
		if !bcdbootCommandLine.MatchString(s) {
			t.Errorf("bcdboot pattern misses %q", s)
		}
	}
	for _, s := range []string{`bcdboot.exe`, "bcdboot: %w", "bcdboot (%s): %w: %s"} {
		if bcdbootCommandLine.MatchString(s) {
			t.Errorf("bcdboot pattern false-positives on %q", s)
		}
	}
	if s, ok := foldString(&ast.BinaryExpr{Op: token.ADD,
		X: &ast.BasicLit{Kind: token.STRING, Value: `"di"`},
		Y: &ast.BasicLit{Kind: token.STRING, Value: `"sm /Image:E:"`}}); !ok || !imageServicingCommand.MatchString(s) {
		t.Errorf("a literal-only +-chain is not folded: %q %v", s, ok)
	}
}
