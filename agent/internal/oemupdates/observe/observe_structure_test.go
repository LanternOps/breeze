package observe

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"
)

const modulePrefix = "github.com/breeze-rmm/agent/internal/"

// rootPackage is the oemupdates root: fetch, install, runner, marker and lock.
// Matched exactly: bitlockerguard and observe share its prefix.
const rootPackage = modulePrefix + "oemupdates"

// forbiddenDirect may not be imported by this package at all.
var forbiddenDirect = []string{
	rootPackage,
	modulePrefix + "flashguard",
	modulePrefix + "rollback",
	modulePrefix + "safemode",
	modulePrefix + "updater",
	modulePrefix + "selfuninstall",
	modulePrefix + "procspawn",
	modulePrefix + "psscript",
	"os/exec",
}

// goList runs `go list` for this package as the Windows agent is built.
func goList(t *testing.T, args ...string) []string {
	t.Helper()
	cmd := exec.Command("go", append([]string{"list"}, append(args, ".")...)...)
	cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("go list %v: %v\n%s", args, err, out)
	}
	return strings.Fields(strings.NewReplacer("[", " ", "]", " ").Replace(string(out)))
}

// TestObserveImportsNoInstallPath (amendment §1.2, O3). The root oemupdates
// package must not be reachable at all, directly or transitively. The rest of
// the forbidden list must not be a direct import.
//
// Accepted transitive reach, all through readers the amendment directs observe
// to reuse: internal/patching (the Windows Update driver search, Surface filter
// and pending-reboot read) imports flashguard, procspawn and psscript;
// bitlockerguard (the read-only Preflight) and internal/security (BitLocker
// state and recovery-protector reads) also reach flashguard, safemode, updater,
// procspawn and psscript. None of their write paths is called from here: the
// source check below bans those names in this package.
func TestObserveImportsNoInstallPath(t *testing.T) {
	deps := goList(t, "-deps")
	direct := goList(t, "-f", "{{.Imports}}")
	if len(deps) < 10 || len(direct) < 3 {
		t.Fatalf("go list returned too little to trust: %d deps, %d imports", len(deps), len(direct))
	}
	for _, d := range deps {
		if d == rootPackage {
			t.Fatalf("%s is reachable from observe", rootPackage)
		}
	}
	for _, d := range direct {
		if bad := forbiddenImport(d); bad != "" {
			t.Errorf("observe imports %s directly", bad)
		}
	}
	// Positive control: the checks see what they are for.
	if forbiddenImport(rootPackage) == "" || forbiddenImport(modulePrefix+"patching/reboot") == "" || forbiddenImport("os/exec") == "" {
		t.Fatal("forbiddenImport does not catch the forbidden list")
	}
	if forbiddenImport(rootPackage+"/bitlockerguard") != "" || forbiddenImport(rootPackage+"/observe") != "" {
		t.Fatal("forbiddenImport matches by prefix; it must match the root exactly")
	}
	sawPatching := false
	for _, d := range deps {
		sawPatching = sawPatching || d == modulePrefix+"patching"
	}
	if !sawPatching {
		t.Fatal("deps do not include internal/patching; the list is not this package's")
	}
}

func forbiddenImport(path string) string {
	if slices.Contains(forbiddenDirect, path) {
		return path
	}
	if strings.HasPrefix(path, modulePrefix) && strings.Contains(strings.ToLower(path[len(modulePrefix):]), "reboot") {
		return path
	}
	return ""
}

var (
	// A selector naming an install or a download anywhere: catches method values
	// such as provider.InstallDriverUpdates, which a package-qualified check misses.
	installSelector = regexp.MustCompile(`(?i)install|download`)

	// forbiddenSelectors are package-qualified names this package must not use.
	forbiddenSelectors = map[string]map[string]bool{
		"bitlockerguard": setOf("Suspend", "Resume", "MarkInstalling", "ResumeOnStart", "SystemDeps", "RebootOwed", "Held"),
		"os":             setOf("WriteFile", "Create", "CreateTemp", "Mkdir", "MkdirAll", "MkdirTemp", "Remove", "RemoveAll", "Rename", "OpenFile", "Chmod", "Chown", "Chtimes", "Symlink", "Link", "Truncate", "StartProcess"),
		"exec":           nil, // any use
		"procspawn":      nil,
		"psscript":       nil,
		"syscall":        setOf("StartProcess", "ForkExec", "Exec", "CreateProcess"),
		"windows":        setOf("CreateProcess", "CreateProcessAsUser", "ShellExecute", "WinExec", "CreateFile", "DeleteFile", "MoveFile", "MoveFileEx", "WriteFile", "InitiateSystemShutdownEx", "ExitWindowsEx"),
		"http":           setOf("MethodPost", "MethodPut", "MethodDelete", "MethodPatch", "Post", "PostForm"),
	}
	// writeMethods are method names that write wherever they are called.
	writeMethods = setOf("SetStringValue", "SetDWordValue", "SetQWordValue", "SetBinaryValue", "SetExpandStringValue",
		"SetStringsValue", "DeleteKey", "DeleteValue", "CreateKey", "WriteFile", "WriteString")
)

// forbiddenRefs reports every forbidden import and selector in the files.
func forbiddenRefs(fset *token.FileSet, files []*ast.File) []string {
	var out []string
	for _, f := range files {
		for _, imp := range f.Imports {
			path := strings.Trim(imp.Path.Value, `"`)
			if bad := forbiddenImport(path); bad != "" {
				out = append(out, fset.Position(imp.Pos()).String()+": imports "+bad)
			}
		}
		ast.Inspect(f, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			name := sel.Sel.Name
			where := fset.Position(sel.Pos()).String()
			if installSelector.MatchString(name) {
				out = append(out, where+": names "+name)
			}
			if writeMethods[name] {
				out = append(out, where+": calls "+name)
			}
			if x, ok := sel.X.(*ast.Ident); ok {
				if names, listed := forbiddenSelectors[x.Name]; listed && (names == nil || names[name]) {
					out = append(out, where+": uses "+x.Name+"."+name)
				}
			}
			return true
		})
	}
	return out
}

// TestObserveSourceHasNoWritePath parses every non-test .go file of this
// package, whatever its build tag, so the Windows readers are checked on any OS.
func TestObserveSourceHasNoWritePath(t *testing.T) {
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var files []*ast.File
	sawWindows := false
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, p, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, f)
		sawWindows = sawWindows || strings.HasSuffix(p, "_windows.go")
	}
	if len(files) < 5 || !sawWindows {
		t.Fatalf("parsed %d files (windows readers included: %v); expected the whole package", len(files), sawWindows)
	}
	if refs := forbiddenRefs(fset, files); len(refs) > 0 {
		sort.Strings(refs)
		t.Fatalf("observe source reaches a write or run path:\n%s", strings.Join(refs, "\n"))
	}
}

// TestForbiddenRefsCatchesWhatItIsFor is the source check's positive control:
// each line below is a slip the check must catch.
func TestForbiddenRefsCatchesWhatItIsFor(t *testing.T) {
	src := `package observe
import (
	"os"
	"os/exec"
	"github.com/breeze-rmm/agent/internal/oemupdates"
	"github.com/breeze-rmm/agent/internal/procspawn"
)
func slips(p *provider, k key) {
	_ = p.InstallDriverUpdates
	_ = patching.DownloadDriverUpdates
	_, _ = bitlockerguard.Suspend(nil, 3, bitlockerguard.SystemDeps(nil, nil, nil))
	_ = bitlockerguard.ResumeOnStart
	_ = bitlockerguard.MarkInstalling
	_ = os.WriteFile("x", nil, 0)
	_, _ = os.Create("x")
	_ = os.MkdirAll("x", 0)
	_ = os.Remove("x")
	_ = exec.Command("x")
	_ = procspawn.CommandContext
	_ = psscript.Run
	_ = k.SetDWordValue("x", 1)
	_ = http.MethodPost
	_ = oemupdates.Run
}`
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "slips.go", src, parser.SkipObjectResolution)
	if err != nil {
		t.Fatal(err)
	}
	refs := strings.Join(forbiddenRefs(fset, []*ast.File{f}), "\n")
	for _, want := range []string{
		"imports os/exec", "imports " + rootPackage, "imports " + modulePrefix + "procspawn",
		"names InstallDriverUpdates", "names DownloadDriverUpdates", "uses bitlockerguard.Suspend",
		"uses bitlockerguard.SystemDeps", "uses bitlockerguard.ResumeOnStart", "names MarkInstalling",
		"uses os.WriteFile", "uses os.Create", "uses os.MkdirAll", "uses os.Remove", "uses exec.Command",
		"uses procspawn.CommandContext", "uses psscript.Run", "calls SetDWordValue", "uses http.MethodPost",
	} {
		if !strings.Contains(refs, want) {
			t.Errorf("the source check missed %q; it reported:\n%s", want, refs)
		}
	}
}
