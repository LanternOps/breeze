package hpwarrantyobserve

import (
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// Observe is read-only by construction (amendment §2, O3). These tests read
// the package's own source and the script it runs.

// sources returns every non-test .go file in the package, keyed by name.
func sources(t *testing.T) map[string]string {
	t.Helper()
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		out[f] = string(b)
	}
	if len(out) < 4 {
		t.Fatalf("found only %d source files; the scan is not reading the package", len(out))
	}
	return out
}

// scriptCmdlets are the only Verb-Noun names the script may contain: three
// readers (Get-CimInstance, Get-CimClass and the pipeline helpers), the JSON
// writer, and the script's own three functions.
var scriptCmdlets = []string{
	"Get-CimInstance", "Get-CimClass", "ForEach-Object", "Select-Object", "Where-Object",
	"Sort-Object", "ConvertTo-Json", "Get-Code", "Get-Children", "Get-Val",
}

var cmdletRe = regexp.MustCompile(`\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b`)

func TestObserveNeverInvokesGetHPWarrantyInfo(t *testing.T) {
	script := wmiScript()
	// Only allowlisted commands appear. Get-HPWarrantyInfo, Import-Module,
	// Install-Module and every Set-/New-/Remove-/Invoke- are absent by this.
	for _, name := range cmdletRe.FindAllString(script, -1) {
		if !slices.Contains(scriptCmdlets, name) {
			t.Errorf("script names %q, which is not on the read-only list", name)
		}
	}
	lower := strings.ToLower(script)
	for _, banned := range []string{"hpcmsl", "get-hp", "import-module", "add-type", "invoke-", "set-", "new-", "remove-", "&", "iex", "start-process", ".dll", "http"} {
		if strings.Contains(lower, banned) {
			t.Errorf("script contains %q", banned)
		}
	}
	// No source file names the CMSL warranty cmdlet at all.
	for name, src := range sources(t) {
		if strings.Contains(strings.ToLower(src), "get-hpwarrantyinfo") {
			t.Errorf("%s names Get-HPWarrantyInfo", name)
		}
	}
	// A run never reaches anything but the fixed argv: the seam carries no
	// argument, and the argv is constants only.
	args := powershellArgs()
	if len(args) != 5 || args[3] != "-Command" || args[4] != script {
		t.Fatalf("argv = %q", args[:4])
	}
}

func TestObserveNeverRunsWinget(t *testing.T) {
	if strings.Contains(strings.ToLower(wmiScript()), "winget") {
		t.Fatal("the script mentions winget")
	}
	// winget.exe appears only as a file name to stat, never as a program.
	for name, src := range sources(t) {
		for _, line := range strings.Split(src, "\n") {
			if strings.Contains(strings.ToLower(line), "winget.exe") && !strings.Contains(line, "RegularFile") && !strings.HasPrefix(strings.TrimSpace(line), "//") {
				t.Errorf("%s: winget.exe used outside a file check: %s", name, strings.TrimSpace(line))
			}
		}
	}
}

// TestOneProcessRunner: os/exec is imported nowhere and procspawn only by
// host_windows.go, which calls it once, for the System32 PowerShell.
func TestOneProcessRunner(t *testing.T) {
	fset := token.NewFileSet()
	for name, src := range sources(t) {
		f, err := parser.ParseFile(fset, name, src, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range f.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			switch {
			case path == "os/exec", path == "syscall", strings.HasSuffix(path, "/oemupdates"), strings.HasSuffix(path, "/updater"),
				strings.HasSuffix(path, "/flashguard"), strings.HasSuffix(path, "/patching"):
				t.Errorf("%s imports %s", name, path)
			case strings.HasSuffix(path, "/procspawn") && name != "host_windows.go":
				t.Errorf("%s imports procspawn; only host_windows.go may run a process", name)
			}
		}
	}
	src := sources(t)["host_windows.go"]
	if n := strings.Count(src, "procspawn.CommandContext("); n != 1 {
		t.Fatalf("host_windows.go starts %d processes, want exactly 1", n)
	}
	if !strings.Contains(src, "!slices.Equal(args, powershellArgs())") || !strings.Contains(src, "strings.EqualFold(path, systemPowerShell)") {
		t.Fatal("the runner must refuse any program but System32 PowerShell and any argv but powershellArgs()")
	}
	// Registry access is read-only and limited to the named keys.
	if !strings.Contains(src, "registry.QUERY_VALUE|registry.WOW64_64KEY") || strings.Contains(src, "SET_VALUE") ||
		strings.Contains(src, "CreateKey") || strings.Contains(src, "DeleteKey") || strings.Contains(src, "SetDWordValue") {
		t.Fatal("registry access must be QUERY_VALUE only")
	}
}
