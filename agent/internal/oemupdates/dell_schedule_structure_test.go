package oemupdates

import (
	"bytes"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

// codeOnly is a Go file's source with every comment dropped.
func codeOnly(t *testing.T, name string, src []byte) string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, name, src, 0) // no parser.ParseComments
	if err != nil {
		t.Fatal(err)
	}
	var b bytes.Buffer
	if err := printer.Fprint(&b, fset, f); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

// The schedule-mode read must stay read-only and process-free (#12267): any
// dcu-cli call wakes the vendor service, which rewrites its scheduler file.
func TestDellScheduleReadIsReadOnlyAndSpawnsNothing(t *testing.T) {
	for _, name := range []string{"dell_schedule.go", "dell_schedule_windows.go", "dell_schedule_other.go"} {
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		f, err := parser.ParseFile(token.NewFileSet(), name, src, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range f.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			switch {
			case path == "os/exec", path == "syscall", strings.HasSuffix(path, "/procspawn"):
				t.Errorf("%s imports %s", name, path)
			}
		}
		text := codeOnly(t, name, src)
		for _, banned := range []string{
			"SET_VALUE", "ALL_ACCESS", "WRITE", "CREATE_SUB_KEY", "CreateKey", "DeleteKey", "DeleteValue",
			"SetStringValue", "SetDWordValue", "SetQWordValue", "SetBinaryValue", "SetExpandStringValue",
			"SetStringsValue", "Exec", ".Run(", "dcu-cli",
		} {
			if strings.Contains(text, banned) {
				t.Errorf("%s contains %q", name, banned)
			}
		}
	}
	src, err := os.ReadFile("dell_schedule_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	text := codeOnly(t, "dell_schedule_windows.go", src)
	if n := strings.Count(text, "registry.OpenKey("); n != 1 {
		t.Fatalf("dell_schedule_windows.go opens keys in %d places, want 1", n)
	}
	if !strings.Contains(text, "registry.QUERY_VALUE|registry.WOW64_64KEY") {
		t.Fatal("the key must be opened with QUERY_VALUE in the 64-bit view only")
	}
	if !strings.Contains(text, "slices.Contains(dellRegistryKeys, key)") {
		t.Fatal("the reader must refuse a key that is not on the read list")
	}
}
