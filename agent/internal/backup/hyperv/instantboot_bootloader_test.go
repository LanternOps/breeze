package hyperv

import (
	"errors"
	"go/ast"
	"strings"
	"testing"
)

// exitCodeError stands in for *exec.ExitError: bcdboot ran and exited non-zero.
type exitCodeError struct{ code int }

func (e exitCodeError) Error() string { return "exit status" }
func (e exitCodeError) ExitCode() int { return e.code }

// #7494: a failed bcdboot is reported with its exit code and its own output,
// so the restore job's error tells the operator why the VM has no boot files.
func TestBcdbootFailure_ReportsExitCodeAndOutput(t *testing.T) {
	out := []byte("Failure when attempting to copy boot files.\r\n")
	err := bcdbootFailure(`C:\Windows\System32\bcdboot.exe`, out, exitCodeError{193})
	if err == nil {
		t.Fatal("bcdbootFailure returned nil")
	}
	msg := err.Error()
	for _, want := range []string{"bcdboot", "exited with code 193", "Failure when attempting to copy boot files."} {
		if !strings.Contains(msg, want) {
			t.Errorf("error %q does not contain %q", msg, want)
		}
	}
	if strings.ContainsAny(msg, "\r\n") {
		t.Errorf("error %q keeps line breaks from bcdboot's output", msg)
	}
}

// bcdboot could not be started at all: there is no exit code, so the
// underlying error is kept.
func TestBcdbootFailure_StartErrorKeepsCause(t *testing.T) {
	cause := errors.New("file does not exist")
	err := bcdbootFailure(`C:\Windows\System32\bcdboot.exe`, nil, cause)
	if !errors.Is(err, cause) {
		t.Fatalf("error %v does not wrap %v", err, cause)
	}
	if strings.HasSuffix(err.Error(), ": ") {
		t.Errorf("error %q ends with an empty output section", err.Error())
	}
}

// The output lands in restore_jobs (jsonb, which rejects \u0000) and is
// checked against the server's result limits: NULs (UTF-16 console output)
// are dropped and the text is bounded.
func TestBcdbootFailure_SanitizesAndBoundsOutput(t *testing.T) {
	utf16ish := []byte("B\x00C\x00D\x00B\x00o\x00o\x00t\x00")
	if msg := bcdbootFailure("bcdboot.exe", utf16ish, exitCodeError{1}).Error(); strings.Contains(msg, "\x00") || !strings.Contains(msg, "BCDBoot") {
		t.Errorf("error %q: want NULs dropped and the text kept", msg)
	}
	huge := []byte(strings.Repeat("x", 50_000))
	if msg := bcdbootFailure("bcdboot.exe", huge, exitCodeError{1}).Error(); len(msg) > 2*maxReportedText {
		t.Errorf("error is %d bytes, want it bounded near %d", len(msg), maxReportedText)
	}
}

// #7494: InstantBoot only compiles on Windows and needs a live Hyper-V host,
// so this is checked on the source: when configureBootLoader fails, InstantBoot
// returns an error (result.Status stays "failed", which also lets the deferred
// cleanup remove the restore directory) after dismounting the base VHDX and
// recording the reason in result.Error. It must never log and carry on to
// "VM booted".
func TestInstantBoot_FailsWhenBootLoaderConfigurationFails(t *testing.T) {
	_, files := parsePackage(t)
	var body *ast.BlockStmt
	for _, decl := range files["instantboot.go"].Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Name.Name == "InstantBoot" {
			body = fn.Body
		}
	}
	if body == nil {
		t.Fatal("instantboot.go: InstantBoot not found")
	}
	var guard *ast.IfStmt
	ast.Inspect(body, func(n ast.Node) bool {
		ifs, ok := n.(*ast.IfStmt)
		if !ok || guard != nil {
			return guard == nil
		}
		if as, ok := ifs.Init.(*ast.AssignStmt); ok && len(as.Rhs) == 1 && isCallTo(as.Rhs[0], "configureBootLoader") {
			guard = ifs
			return false
		}
		return true
	})
	if guard == nil {
		t.Fatal("InstantBoot: no `if err := configureBootLoader(...); err != nil` block")
	}
	var dismounts, setsError bool
	var ret *ast.ReturnStmt
	for _, stmt := range guard.Body.List {
		switch s := stmt.(type) {
		case *ast.ExprStmt:
			if isCallTo(s.X, "dismountVHDX") {
				dismounts = true
			}
		case *ast.AssignStmt:
			if len(s.Lhs) == 1 && isSelector(s.Lhs[0], "result", "Error") {
				setsError = true
			}
		case *ast.ReturnStmt:
			ret = s
		}
	}
	if ret == nil {
		t.Fatal("InstantBoot: a configureBootLoader failure does not return — the VM would be reported booted without boot files")
	}
	if len(ret.Results) != 2 || isIdent(ret.Results[1], "nil") {
		t.Error("InstantBoot: a configureBootLoader failure must return a non-nil error")
	}
	if !dismounts {
		t.Error("InstantBoot: a configureBootLoader failure must dismount the base VHDX before returning")
	}
	if !setsError {
		t.Error("InstantBoot: a configureBootLoader failure must record the reason in result.Error")
	}
}
