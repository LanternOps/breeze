package biosconfig

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The observe stage writes nothing (amendment §4 O2). No firmware write class
// or method, and no WMI or CIM write verb, may appear in this package's or the
// Surface collector's source, executed or not. The banned words are built from
// parts so this file does not contain them either.
var bannedWriteWords = []string{
	"Set" + "BIOSSetting",
	"Set" + "BiosSetting",
	"Save" + "BiosSettings",
	"Set" + "BiosPassword",
	"Set" + "BIOSPassword",
	"Lenovo_" + "Set",
	"Lenovo_" + "Save",
	"Lenovo_" + "WmiOpcode",
	"Lenovo_" + "DiscardBiosSettings",
	"Lenovo_" + "LoadDefault",
	"Invoke-" + "WmiMethod",
	"Set-" + "CimInstance",
	"New-" + "CimInstance",
	"Remove-" + "CimInstance",
	"Set-" + "WmiInstance",
	"Remove-" + "WmiObject",
	"ExecMethod",
	".Put" + "(",
	// Other ways to call a WMI method than the one pinned Invoke-CimMethod.
	"Invoke" + "Method",
	"[wmi" + "class]",
	"[wmi" + "]",
	"Get-" + "WmiObject",
	"gwmi" + " ",
	"Install-" + "Module",
	"Restart-" + "Computer",
	"shutdown" + ".exe",
}

func observeSources(t *testing.T) map[string]string {
	t.Helper()
	files := map[string]string{}
	add := func(glob string) {
		matches, err := filepath.Glob(glob)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range matches {
			if strings.HasSuffix(m, "_test.go") {
				continue
			}
			b, err := os.ReadFile(m)
			if err != nil {
				t.Fatal(err)
			}
			files[m] = string(b)
		}
	}
	add("*.go")
	add(filepath.Join("..", "wakeconfig", "surface*.go"))
	if len(files) < 4 {
		t.Fatalf("scan found only %d files: %v", len(files), files)
	}
	return files
}

func TestNoWriteMethodReachable(t *testing.T) {
	for path, src := range observeSources(t) {
		for _, word := range bannedWriteWords {
			if strings.Contains(src, word) {
				t.Errorf("%s contains %q", path, word)
			}
		}
	}
}

// The one method the observe stage calls is the read-only
// GetBiosSelections, in exactly one script; no other CIM method is invoked.
var invokeRe = regexp.MustCompile(`Invoke-CimMethod[^\n;]*`)

func TestOnlyReadMethodInvoked(t *testing.T) {
	total := 0
	for path, src := range observeSources(t) {
		for _, m := range invokeRe.FindAllString(src, -1) {
			total++
			if !strings.Contains(m, "-MethodName GetBiosSelections") {
				t.Errorf("%s invokes %q", path, m)
			}
		}
	}
	if total != 1 {
		t.Fatalf("%d Invoke-CimMethod calls, want exactly 1", total)
	}
	if !strings.Contains(lenovoSelectionsScript, "Invoke-CimMethod") {
		t.Fatal("the selections script no longer carries the one method call")
	}
	for _, s := range []string{hpReadScript, lenovoReadScript} {
		if strings.Contains(s, "Invoke-CimMethod") {
			t.Fatal("a read script invokes a method")
		}
	}
}

// Every script reads nothing from the server: no Go value is interpolated,
// so the scripts are compile-time constants (the psscript literal guard
// covers interpolation; this pins that there is none to cover).
func TestScriptsAreConstantAndReadOnly(t *testing.T) {
	for name, s := range map[string]string{"hp": hpReadScript, "lenovo": lenovoReadScript, "selections": lenovoSelectionsScript, "dell": dellReadScript} {
		if v := WriteVerbIn(s); v != "" {
			t.Errorf("%s script contains %q", name, v)
		}
	}
}

// Stdin is pure ASCII JSON, so the script decodes a setting name the same
// whatever the console input code page.
func TestSelectionsStdinIsASCII(t *testing.T) {
	f := newFakeRunner()
	f.out[lenovoReadScript] = mustJSON(t, map[string]any{
		"settings": []string{"WakeOnLAN\u00e9\u20ac,Enable", "WakeOnLAN,ACOnly"}, "passwordState": 0,
		"classes": []string{"Lenovo_GetBiosSelections"}, "error": nil,
	})
	f.out[lenovoSelectionsScript] = selectionsReply(t, map[string]string{})
	observer(t, DetectWith("LENOVO", "20U9CTO1WW", VendorLenovo, f.run)).Observe(context.Background())
	for _, c := range f.Calls() {
		if c.script != lenovoSelectionsScript {
			continue
		}
		for _, b := range c.stdin {
			if b > 0x7e {
				t.Fatalf("stdin has a non-ASCII byte: %q", c.stdin)
			}
		}
		if !strings.Contains(string(c.stdin), `\u00e9\u20ac`) {
			t.Fatalf("non-ASCII name not escaped: %q", c.stdin)
		}
		return
	}
	t.Fatal("selections did not run")
}
