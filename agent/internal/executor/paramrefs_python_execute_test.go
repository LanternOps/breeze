package executor

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

// pythonAtLeast312Dir returns a directory whose `python3` is Python 3.12 or
// newer, so a PEP 701 canary can be run through the executor (which always
// invokes plain `python3` from PATH). It returns "" when the current `python3`
// already qualifies, and reports ok=false when no such interpreter exists.
func pythonAtLeast312Dir() (dir string, ok bool) {
	supports := func(bin string) bool {
		cmd := exec.Command(bin, "-c", "import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)")
		return cmd.Run() == nil
	}
	if path, err := exec.LookPath("python3"); err == nil && supports(path) {
		return "", true
	}
	var candidates []string
	for _, name := range []string{"python3.14", "python3.13", "python3.12"} {
		path, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		candidates = append(candidates, filepath.Dir(path))
		// Homebrew puts the versioned name on PATH but the unversioned
		// `python3` only in the keg's own bin directory.
		if resolved, err := filepath.EvalSymlinks(path); err == nil {
			candidates = append(candidates, filepath.Dir(resolved))
		}
	}
	candidates = append(candidates,
		"/opt/homebrew/opt/python@3.14/bin",
		"/opt/homebrew/opt/python@3.13/bin",
		"/opt/homebrew/opt/python@3.12/bin",
	)
	for _, candidate := range candidates {
		bin := filepath.Join(candidate, "python3")
		if _, err := os.Stat(bin); err != nil {
			continue
		}
		if supports(bin) {
			return candidate, true
		}
	}
	return "", false
}

// TestExecutePythonFStringFieldCommentCanarySkipsWithoutPython312 is the
// Execute-level proof for the PEP 701 comment gap: in Python 3.12+ a `#`
// comment is legal inside a multi-line f-string replacement field, so the `}`
// in `f"""{ x # }` is comment text and the field is still open on the next
// line. The renderer used to treat what followed as string data and escape the
// value into that expression slot, which executed it.
//
// The test needs a Python 3.12+ interpreter and SKIPS when none is installed —
// the gap is not reproducible on 3.11 and older, where the comment is a syntax
// error.
func TestExecutePythonFStringFieldCommentCanarySkipsWithoutPython312(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("python3 not available on Windows")
	}
	dir, ok := pythonAtLeast312Dir()
	if !ok {
		t.Skip("no Python 3.12+ interpreter available; PEP 701 f-string comments need 3.12")
	}
	if dir != "" {
		t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	}

	canary := filepath.Join(t.TempDir(), "canary")
	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "pep701-field-comment",
		ScriptType: ScriptTypePython,
		Script:     "x=1\nprint(f\"\"\"{ x # }\n + {{i}} }\"\"\")\n",
		Parameters: map[string]string{"i": pythonChrPayload("touch " + canary)},
		Timeout:    20,
	})
	if err == nil {
		t.Fatalf("expected the render to fail closed; stdout %q", result.Stdout)
	}
	var pre *ParameterRenderError
	if !errors.As(err, &pre) {
		t.Fatalf("expected a *ParameterRenderError, got %T: %v", err, err)
	}
	canaryAbsent(t, canary)
}

// TestPythonAtLeast312DirFindsAnInterpreter is a control for the gate above: if
// the lookup silently failed everywhere, the canary would be a permanent skip.
func TestPythonAtLeast312DirFindsAnInterpreter(t *testing.T) {
	dir, ok := pythonAtLeast312Dir()
	if !ok {
		t.Skip("no Python 3.12+ interpreter on this machine")
	}
	bin := "python3"
	if dir != "" {
		bin = filepath.Join(dir, "python3")
	}
	out, err := exec.Command(bin, "-c", "import sys; print(sys.version_info >= (3,12))").Output()
	if err != nil {
		t.Fatalf("running %s: %v", bin, err)
	}
	if got := trimEOL(string(out)); got != "True" {
		t.Fatalf("%s reported %q, want True", bin, got)
	}
}
