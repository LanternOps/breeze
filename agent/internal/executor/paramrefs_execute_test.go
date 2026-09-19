package executor

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// pythonChrPayload builds an `os.system(<cmd>)` call out of chr() arithmetic
// only: no quote, backslash or brace, so the escaping the renderer applies to
// f-string string data leaves the payload executable. A canary test whose
// payload dies on a SyntaxError would pass for the wrong reason.
func pythonChrPayload(cmd string) string {
	parts := make([]string, 0, len(cmd))
	for i := 0; i < len(cmd); i++ {
		parts = append(parts, fmt.Sprintf("chr(%d)", cmd[i]))
	}
	return "__import__(chr(111)+chr(115)).system(" + strings.Join(parts, "+") + ")"
}

// trimEOL strips only the interpreter's trailing newline, so leading and
// trailing spaces inside a parameter value are still asserted.
func trimEOL(s string) string { return strings.TrimRight(s, "\r\n") }

func runOne(t *testing.T, scriptType, script string, params map[string]string) *ScriptResult {
	t.Helper()
	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "pos-" + t.Name(),
		ScriptType: scriptType,
		Script:     script,
		Parameters: params,
		Timeout:    20,
	})
	if err != nil {
		t.Fatalf("execute failed: %v (stderr: %s)", err, result.Stderr)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exit code %d, stderr: %s", result.ExitCode, result.Stderr)
	}
	return result
}

// TestExecuteBashParameterValuesSurviveIntact covers the documented parameter
// examples plus the value shapes that shell quoting usually mangles.
func TestExecuteBashParameterValuesSurviveIntact(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	tests := []struct {
		name   string
		script string
		params map[string]string
		want   string
	}{
		{
			name:   "documented threshold example",
			script: `echo "Threshold is {{threshold}}"`,
			params: map[string]string{"threshold": "42 percent (ok)"},
			want:   "Threshold is 42 percent (ok)",
		},
		{
			name:   "documented find example",
			script: `echo "find /tmp -mtime +{{days}}"`,
			params: map[string]string{"days": "7"},
			want:   "find /tmp -mtime +7",
		},
		{
			name:   "single-quoted literal",
			script: `echo 'v={{v}}'`,
			params: map[string]string{"v": `hello "world" $HOME`},
			want:   `v=hello "world" $HOME`,
		},
		{
			name:   "windows-style path with a space",
			script: `echo {{p}}`,
			params: map[string]string{"p": `C:\Users\x y`},
			want:   `C:\Users\x y`,
		},
		{
			name:   "unicode",
			script: `echo "{{p}}"`,
			params: map[string]string{"p": "café ☕ naïve"},
			want:   "café ☕ naïve",
		},
		{
			name:   "leading and trailing spaces",
			script: `echo "[{{p}}]"`,
			params: map[string]string{"p": "  two  spaces  "},
			want:   "[  two  spaces  ]",
		},
		{
			name:   "unquoted value is one word, not split or globbed",
			script: `printf '%s\n' {{p}}`,
			params: map[string]string{"p": "* a b"},
			want:   "* a b",
		},
		{
			// An unquoted expansion splits and globs its result, so the default
			// word has to carry the value as one quoted word.
			name:   `unquoted default-value expansion is one word, not split or globbed`,
			script: `printf '%s\n' ${u:-{{p}}}`,
			params: map[string]string{"p": "* a b"},
			want:   "* a b",
		},
		{
			name:   `unquoted alternate-value expansion is one word, not split or globbed`,
			script: `u=1; printf '%s\n' ${u:+{{p}}}`,
			params: map[string]string{"p": "* a b"},
			want:   "* a b",
		},
		{
			name:   `double-quoted default-value expansion keeps the value intact`,
			script: `printf '%s\n' "${u:-{{p}}}"`,
			params: map[string]string{"p": "* a b"},
			want:   "* a b",
		},
		{
			name:   `nested default-value expansion is one word, not split or globbed`,
			script: `printf '%s\n' ${u:-${v:-{{p}}}}`,
			params: map[string]string{"p": "* a b"},
			want:   "* a b",
		},
		{
			// An empty value still occupies its own word: the bare form used to
			// vanish entirely, shifting every argument after it.
			name:   `an empty value occupies its own word`,
			script: `printf '[%s]' x ${u:-{{p}}} y`,
			params: map[string]string{"p": ""},
			want:   "[x][][y]",
		},
		{
			// `${u:=word}` assigns the quoted word, so the VARIABLE receives the
			// value intact. The word count of the expansion itself is
			// bash-version-dependent there (see paramWordForm), so only the
			// assigned value is asserted.
			name:   `assign-default expansion assigns the value intact`,
			script: `: ${u:={{p}}}; printf '[%s]' "$u"`,
			params: map[string]string{"p": "* a b"},
			want:   "[* a b]",
		},
		{
			// A pattern position gets the value as a LITERAL, not a glob: the
			// bare form would let `a*` match and strip the leading `a`.
			name:   `prefix removal matches the value literally`,
			script: `w=ab.txt; printf '%s\n' ${w#{{p}}}`,
			params: map[string]string{"p": "a*"},
			want:   "ab.txt",
		},
		{
			// Documented residual: the replacement half puts the value into the
			// VARIABLE's value, which the author's unquoted expansion then
			// splits — identically with no placeholder present. Pinned so a
			// change in that behaviour is deliberate.
			name:   `replacement half still splits the surrounding expansion`,
			script: `v=zaz; printf '[%s]' ${v/a/{{p}}}`,
			params: map[string]string{"p": "a b"},
			want:   "[za][bz]",
		},
		{
			name:   "heredoc body",
			script: "cat <<EOF\nv={{p}}\nEOF\n",
			params: map[string]string{"p": "$(id) & echo no"},
			want:   "v=$(id) & echo no",
		},
		{
			name:   "integer in an arithmetic expression",
			script: `echo $(( {{n}} * 2 ))`,
			params: map[string]string{"n": "21"},
			want:   "42",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := runOne(t, ScriptTypeBash, tt.script, tt.params)
			if got := trimEOL(result.Stdout); got != tt.want {
				t.Fatalf("stdout %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExecutePowerShellParameterValuesSurviveIntact(t *testing.T) {
	if _, err := exec.LookPath("pwsh"); err != nil {
		t.Skip("pwsh not available")
	}
	value := "he said \"hi\" $x `tick` 100%"
	tests := []struct {
		name   string
		script string
		params map[string]string
		want   string
	}{
		{
			name:   "single-quoted literal is rewritten but prints the value",
			script: `Write-Output 'p={{p}}'`,
			params: map[string]string{"p": value},
			want:   "p=" + value,
		},
		{
			name:   "double-quoted literal",
			script: `Write-Output "p={{p}}"`,
			params: map[string]string{"p": value},
			want:   "p=" + value,
		},
		{
			name:   "numeric passthrough stays arithmetic",
			script: `Write-Output ({{n}} * 2)`,
			params: map[string]string{"n": "21"},
			want:   "42",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := runOne(t, ScriptTypePowerShell, tt.script, tt.params)
			if got := trimEOL(result.Stdout); got != tt.want {
				t.Fatalf("stdout %q, want %q", got, tt.want)
			}
		})
	}
}

func TestExecutePythonParameterValuesSurviveIntact(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	// On Windows, Python encodes stdout with the console code page unless told
	// otherwise, so a non-ASCII value round-trips as mojibake (café → cafΘ).
	// The executor's env lands in os.Environ() for the child, so pin UTF-8 here.
	t.Setenv("PYTHONIOENCODING", "utf-8")
	tests := []struct {
		name   string
		script string
		params map[string]string
		want   string
	}{
		{
			name:   "double-quoted literal with backslashes",
			script: `print("{{p}}")`,
			params: map[string]string{"p": `C:\Users\x y`},
			want:   `C:\Users\x y`,
		},
		{
			name:   "f-string literal with braces and quotes",
			script: `print(f"v={{p}}")`,
			params: map[string]string{"p": `{braces} and "quotes"`},
			want:   `v={braces} and "quotes"`,
		},
		{
			name:   "raw literal with a plain value",
			script: `print(r"v={{p}}")`,
			params: map[string]string{"p": "plain value"},
			want:   "v=plain value",
		},
		{
			name:   "code context reads the environment",
			script: `p = {{p}}` + "\nprint(p)\n",
			params: map[string]string{"p": `unicode café & "quotes"`},
			want:   `unicode café & "quotes"`,
		},
		{
			name:   "numeric passthrough stays arithmetic",
			script: `print({{n}} * 2)`,
			params: map[string]string{"n": "21"},
			want:   "42",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := runOne(t, ScriptTypePython, tt.script, tt.params)
			if got := trimEOL(result.Stdout); got != tt.want {
				t.Fatalf("stdout %q, want %q", got, tt.want)
			}
		})
	}
}

// TestExecuteRejectsUnrenderableParameterContext proves Execute fails the run
// instead of executing a script it could not render safely.
func TestExecuteRejectsUnrenderableParameterContext(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	canary := filepath.Join(t.TempDir(), "canary_unrenderable")
	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "reject-arith",
		ScriptType: ScriptTypeBash,
		Script:     "touch " + canary + "\necho $(( {{n}} ))\n",
		Parameters: map[string]string{"n": "a[$(id)]"},
		Timeout:    10,
	})
	if err == nil {
		t.Fatal("expected an error for an unrenderable arithmetic context")
	}
	if !strings.Contains(result.Error, "script parameter substitution failed") {
		t.Fatalf("result.Error should explain the failure, got %q", result.Error)
	}
	canaryAbsent(t, canary)
}

// TestExecuteBashSyntaxGateFailsClosed proves the `bash -n` gate stops a script
// whose RENDERED text is broken, before bash executes its first line. The
// corruption is injected through the test hook because the renderer is not
// supposed to be able to produce it.
func TestExecuteBashSyntaxGateFailsClosed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	canary := filepath.Join(t.TempDir(), "canary_gate")
	renderedScriptHookForTests = func(string) string {
		return "touch " + canary + "\nif [ ; then\n"
	}
	t.Cleanup(func() { renderedScriptHookForTests = nil })

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "gate-broken-render",
		ScriptType: ScriptTypeBash,
		Script:     `echo "{{p}}"`,
		Parameters: map[string]string{"p": "v"},
		Timeout:    10,
	})
	if err == nil {
		t.Fatal("expected the syntax gate to fail the execution")
	}
	if !strings.Contains(err.Error(), "not valid after parameter substitution") {
		t.Fatalf("expected the gate's error, got %v", err)
	}
	if result.ExitCode != -1 {
		t.Fatalf("expected exit code -1, got %d", result.ExitCode)
	}
	canaryAbsent(t, canary)
}

// TestExecuteBashSyntaxGatePassesValidRenders makes sure the gate is not a
// blanket refusal: the same hook returning valid bash still runs.
func TestExecuteBashSyntaxGatePassesValidRenders(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	renderedScriptHookForTests = func(s string) string { return s + "\necho tail\n" }
	t.Cleanup(func() { renderedScriptHookForTests = nil })

	result := runOne(t, ScriptTypeBash, `echo "{{p}}"`, map[string]string{"p": "v"})
	if got := trimEOL(result.Stdout); got != "v\ntail" {
		t.Fatalf("stdout %q", got)
	}
}

// TestExecuteCMDDelayedExpansionCanary is the Windows-only end-to-end check
// that a cmd parameter value carrying cmd metacharacters is data.
func TestExecuteCMDDelayedExpansionCanary(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("cmd only available on Windows")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_cmd_meta")
	value := "a & echo pwned > " + canary + " | %PATH% ^ 100%"

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "cmd-canary",
		ScriptType: ScriptTypeCMD,
		Script:     "@echo off\r\necho v={{p}}\r\n",
		Parameters: map[string]string{"p": value},
		Timeout:    20,
	})
	if err != nil {
		t.Fatalf("execute failed: %v (stderr: %s)", err, result.Stderr)
	}
	canaryAbsent(t, canary)
	if got := trimEOL(result.Stdout); got != "v="+value {
		t.Fatalf("stdout %q, want %q", got, "v="+value)
	}
	if _, statErr := os.Stat(canary); statErr == nil {
		t.Fatalf("canary created: %s", canary)
	}
}

// TestConfigureRunAsPreservesBreezeEnvNames: sudo strips the environment, and
// the rendered script now REFERENCES BREEZE_PARAM_* instead of embedding the
// values, so losing them would silently hand the script empty parameters.
func TestConfigureRunAsPreservesBreezeEnvNames(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix-only test")
	}
	env := []string{
		"PATH=/usr/bin",
		"BREEZE_SCRIPT_ID=script-1",
		"BREEZE_PARAM_NAME=value",
		"BREEZE_EXECUTION_ID=exec-1",
		"HOME=/root",
	}
	wantPreserve := "--preserve-env=BREEZE_EXECUTION_ID,BREEZE_PARAM_NAME,BREEZE_SCRIPT_ID"

	e := newTestExecutor()

	t.Run("named user", func(t *testing.T) {
		cmd := exec.Command("/bin/bash", "/tmp/script.sh")
		cmd.Env = env
		if err := e.configureRunAs(cmd, "testuser"); err != nil {
			t.Fatalf("configureRunAs: %v", err)
		}
		want := []string{"sudo", "-n", wantPreserve, "-u", "testuser", "/bin/bash", "/tmp/script.sh"}
		if !reflect.DeepEqual(cmd.Args, want) {
			t.Fatalf("argv\n got: %v\nwant: %v", cmd.Args, want)
		}
	})

	t.Run("root", func(t *testing.T) {
		cmd := exec.Command("/bin/bash", "/tmp/script.sh")
		cmd.Env = env
		if err := e.configureRunAs(cmd, "root"); err != nil {
			t.Fatalf("configureRunAs: %v", err)
		}
		want := []string{"sudo", "-n", wantPreserve, "/bin/bash", "/tmp/script.sh"}
		if !reflect.DeepEqual(cmd.Args, want) {
			t.Fatalf("argv\n got: %v\nwant: %v", cmd.Args, want)
		}
	})

	t.Run("deterministic ordering", func(t *testing.T) {
		shuffled := []string{
			"BREEZE_PARAM_NAME=value",
			"BREEZE_EXECUTION_ID=exec-1",
			"BREEZE_VAR_SECRET=s",
			"BREEZE_SCRIPT_ID=script-1",
		}
		first := preserveEnvArg(shuffled)
		second := preserveEnvArg([]string{
			"BREEZE_SCRIPT_ID=script-1",
			"BREEZE_VAR_SECRET=s",
			"BREEZE_PARAM_NAME=value",
			"BREEZE_EXECUTION_ID=exec-1",
		})
		if first != second {
			t.Fatalf("argument is not order-independent: %q vs %q", first, second)
		}
		want := "--preserve-env=BREEZE_EXECUTION_ID,BREEZE_PARAM_NAME,BREEZE_SCRIPT_ID,BREEZE_VAR_SECRET"
		if first != want {
			t.Fatalf("got %q, want %q", first, want)
		}
	})

	t.Run("no breeze variables means no flag", func(t *testing.T) {
		cmd := exec.Command("/bin/bash", "/tmp/script.sh")
		cmd.Env = []string{"PATH=/usr/bin"}
		if err := e.configureRunAs(cmd, "testuser"); err != nil {
			t.Fatalf("configureRunAs: %v", err)
		}
		want := []string{"sudo", "-n", "-u", "testuser", "/bin/bash", "/tmp/script.sh"}
		if !reflect.DeepEqual(cmd.Args, want) {
			t.Fatalf("argv\n got: %v\nwant: %v", cmd.Args, want)
		}
	})
}

// TestExecuteRendererBypassCanaries walks the three contexts an adversarial
// review executed a payload through: a bash array-initializer subscript, an
// arithmetic expansion inside an unquoted heredoc, and an f-string replacement
// field. Each must fail the run before the interpreter starts, so the canary
// the payload would create stays absent.
func TestExecuteRendererBypassCanaries(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash and python3 not available on Windows")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	tests := []struct {
		name       string
		scriptType string
		// script takes the canary path so the payload can name it.
		script func(canary string) string
		value  func(canary string) string
	}{
		{
			name:       "bash array initializer subscript",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "arr=([{{i}}]=1)\n" },
			value:      func(c string) string { return "a[$(touch " + c + ")]" },
		},
		{
			name:       "bash arithmetic inside an unquoted heredoc",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "cat <<EOF\n$(( {{i}} ))\nEOF\n" },
			value:      func(c string) string { return "a[$(touch " + c + ")]" },
		},
		{
			name:       "bash subscript inside an unquoted heredoc",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "arr=(0)\ncat <<EOF\n${arr[{{i}}]}\nEOF\n" },
			value:      func(c string) string { return "a[$(touch " + c + ")]" },
		},
		{
			name:       "python f-string replacement field",
			scriptType: ScriptTypePython,
			script:     func(string) string { return "print(f\"{ {{i}} }\")\n" },
			value: func(c string) string {
				return `__import__(chr(111)+chr(115)).system("touch ` + c + `")`
			},
		},
		{
			name:       "bash backtick inside an unquoted heredoc",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "cat <<EOF\n`eval {{i}}`\nEOF\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			name:       "bash backtick eval with a quoted argument in a heredoc",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "cat <<EOF\n`eval \"{{i}}\"`\nEOF\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			name:       "bash backtick subscript inside an unquoted heredoc",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "cat <<EOF\n`a[{{i}}]=1`\nEOF\n" },
			value:      func(c string) string { return "z[$(touch " + c + ")]" },
		},
		{
			name:       "bash backtick declare -i inside an unquoted heredoc",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "cat <<EOF\n`declare -i q={{i}}`\nEOF\n" },
			value:      func(c string) string { return "z[$(touch " + c + ")]" },
		},
		{
			name:       "bash backtick inside a conditional expression",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "if [[ -n `eval {{i}}` ]]; then :; fi\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			name:       "bash backtick subscript inside a conditional expression",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "[[ -n `a[{{i}}]=1` ]]\n" },
			value:      func(c string) string { return "z[$(touch " + c + ")]" },
		},
		// The word body of a `${name<op>word}` expansion is a word-ish context:
		// bash performs command substitution, arithmetic and nested expansion
		// in it, so every one of these executed while the renderer copied the
		// remainder of the expansion through raw.
		{
			name:       "bash param expansion default value backtick eval",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "echo ${u:-`eval {{i}}`}\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			name:       "bash param expansion default value command substitution eval",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "echo ${u:-$(eval {{i}})}\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			name:       "bash param expansion assign-default command substitution eval",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "echo ${u:=$(eval {{i}})}\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			name:       "bash param expansion alternate value command substitution eval",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "u=1\necho ${u:+$(eval {{i}})}\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			name:       "bash param expansion pattern replacement backtick eval",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "v=aa\necho ${v/a/`eval {{i}}`}\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			name:       "bash param expansion default value arithmetic",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "echo ${u:-$(( {{i}} ))}\n" },
			value:      func(c string) string { return "z[$(touch " + c + ")]" },
		},
		{
			name:       "bash param expansion default value nested offset",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "y=abcdefgh\necho ${u:-${y:{{i}}}}\n" },
			value:      func(c string) string { return "z[$(touch " + c + ")]" },
		},
		{
			name:       "bash param expansion default value nested subscript",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "declare -a arr=(1 2)\necho ${u:-${arr[{{i}}]}}\n" },
			value:      func(c string) string { return "z[$(touch " + c + ")]" },
		},
		{
			name:       "bash param expansion backtick eval inside double quotes",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "echo \"${u:-`eval {{i}}`}\"\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			name:       "bash param expansion backtick eval inside an unquoted heredoc",
			scriptType: ScriptTypeBash,
			script:     func(string) string { return "cat <<EOF\n${u:-`eval {{i}}`}\nEOF\n" },
			value:      func(c string) string { return "touch " + c },
		},
		{
			// The nested `'}'` string is field data to Python, so the field is
			// still open where the placeholder lands. The payload is built from
			// chr() arithmetic so that the escaping the renderer applies to
			// string data leaves it executable — the canary is only absent
			// because the render refuses.
			name:       "python f-string field hidden behind a nested string",
			scriptType: ScriptTypePython,
			script:     func(string) string { return "d={'}':1}\nprint(f\"{d['}'] and {{i}}}\")\n" },
			value:      func(c string) string { return pythonChrPayload("touch " + c) },
		},
		{
			name:       "python f-string field with a nested string in a tuple",
			scriptType: ScriptTypePython,
			script:     func(string) string { return "print(f\"{ ('}' , {{i}}) }\")\n" },
			value:      func(c string) string { return pythonChrPayload("touch " + c) },
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			canary := filepath.Join(t.TempDir(), "canary")
			e := newTestExecutor()
			result, err := e.Execute(ScriptExecution{
				ID:         "bypass-" + t.Name(),
				ScriptType: tt.scriptType,
				Script:     tt.script(canary),
				Parameters: map[string]string{"i": tt.value(canary)},
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
		})
	}
}
