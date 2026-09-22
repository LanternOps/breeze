package executor

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// These tests demonstrate script-parameter injection: SubstituteParameters
// (shell.go) does a raw strings.ReplaceAll of {{key}}/${{key}} placeholders
// with attacker/tenant-supplied parameter values, with no shell-quoting or
// escaping. A parameter value that breaks out of the placeholder's quoting
// context can run arbitrary commands in whatever interpreter the script
// declares. Each test plants a canary file path and asserts it is NOT
// created by Execute. They were written as the RED step of the fix and all
// failed against SubstituteParameters; they pass against
// RenderParameterReferences (paramrefs.go), which delivers parameter values
// as environment data instead of splicing them into the script text.

// canaryAbsent fails the test if the canary path exists on disk.
func canaryAbsent(t *testing.T, canary string) {
	t.Helper()
	if _, err := os.Stat(canary); err == nil {
		t.Fatalf("VULNERABLE: canary file was created via parameter injection: %s", canary)
	} else if !os.IsNotExist(err) {
		t.Fatalf("unexpected error checking canary: %v", err)
	}
}

func TestParameterInjection_Bash_Unquoted(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_unquoted")
	value := "x; touch " + canary

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "inj-bash-unquoted",
		ScriptType: ScriptTypeBash,
		Script:     "echo {{name}}",
		Parameters: map[string]string{"name": value},
		Timeout:    10,
	})
	if err != nil {
		t.Logf("execute returned error (may be expected): %v", err)
	}
	canaryAbsent(t, canary)
	if got := strings.TrimSpace(result.Stdout); got != value {
		t.Fatalf("expected stdout to equal literal parameter value %q, got %q", value, got)
	}
}

func TestParameterInjection_Bash_DoubleQuoted(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_dquoted")
	value := "$(touch " + canary + ")"
	want := "Threshold is " + value

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "inj-bash-dquoted",
		ScriptType: ScriptTypeBash,
		Script:     `echo "Threshold is {{threshold}}"`,
		Parameters: map[string]string{"threshold": value},
		Timeout:    10,
	})
	if err != nil {
		t.Logf("execute returned error (may be expected): %v", err)
	}
	canaryAbsent(t, canary)
	if got := strings.TrimSpace(result.Stdout); got != want {
		t.Fatalf("expected stdout %q, got %q", want, got)
	}
}

func TestParameterInjection_Bash_SingleQuoted(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_squoted")
	value := "'; touch " + canary + "; echo '"
	want := "v=" + value

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "inj-bash-squoted",
		ScriptType: ScriptTypeBash,
		Script:     `echo 'v={{v}}'`,
		Parameters: map[string]string{"v": value},
		Timeout:    10,
	})
	if err != nil {
		t.Logf("execute returned error (may be expected): %v", err)
	}
	canaryAbsent(t, canary)
	if got := strings.TrimSpace(result.Stdout); got != want {
		t.Fatalf("expected stdout %q, got %q", want, got)
	}
}

func TestParameterInjection_Bash_ArithmeticContext(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash not available on Windows")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_arith")
	value := "a[$(touch " + canary + ")]"

	e := newTestExecutor()
	// Execution may fail (non-zero exit / parse error) — that is acceptable.
	// Only the canary-absence assertion matters for this case.
	_, _ = e.Execute(ScriptExecution{
		ID:         "inj-bash-arith",
		ScriptType: ScriptTypeBash,
		Script:     `if [[ 1 -eq {{n}} ]]; then echo eq; else echo ne; fi`,
		Parameters: map[string]string{"n": value},
		Timeout:    10,
	})
	canaryAbsent(t, canary)
}

func TestParameterInjection_PowerShell_DoubleQuoted(t *testing.T) {
	if _, err := exec.LookPath("pwsh"); err != nil {
		t.Skip("pwsh not available")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_ps_dq")
	value := "$(New-Item -ItemType File -Path '" + canary + "')"
	want := "name=" + value

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "inj-ps-dquoted",
		ScriptType: ScriptTypePowerShell,
		Script:     `Write-Output "name={{name}}"`,
		Parameters: map[string]string{"name": value},
		Timeout:    10,
	})
	if err != nil {
		t.Logf("execute returned error (may be expected): %v", err)
	}
	canaryAbsent(t, canary)
	if got := strings.TrimSpace(result.Stdout); got != want {
		t.Fatalf("expected stdout %q, got %q", want, got)
	}
}

func TestParameterInjection_PowerShell_SingleQuoted(t *testing.T) {
	if _, err := exec.LookPath("pwsh"); err != nil {
		t.Skip("pwsh not available")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_ps_sq")
	value := "'; New-Item -ItemType File -Path '" + canary + "'; Write-Output '"

	e := newTestExecutor()
	_, err := e.Execute(ScriptExecution{
		ID:         "inj-ps-squoted",
		ScriptType: ScriptTypePowerShell,
		Script:     `Write-Output 'name={{name}}'`,
		Parameters: map[string]string{"name": value},
		Timeout:    10,
	})
	if err != nil {
		t.Logf("execute returned error (may be expected): %v", err)
	}
	canaryAbsent(t, canary)
}

func TestParameterInjection_PowerShell_Unquoted(t *testing.T) {
	if _, err := exec.LookPath("pwsh"); err != nil {
		t.Skip("pwsh not available")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_ps_unquoted")
	value := "hello; [IO.File]::WriteAllText('" + canary + "','x')"

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "inj-ps-unquoted",
		ScriptType: ScriptTypePowerShell,
		Script:     `Write-Output {{name}}`,
		Parameters: map[string]string{"name": value},
		Timeout:    10,
	})
	if err != nil {
		t.Logf("execute returned error (may be expected): %v", err)
	}
	canaryAbsent(t, canary)
	if got := strings.TrimSpace(result.Stdout); got != value {
		t.Fatalf("expected stdout to equal literal parameter value %q, got %q", value, got)
	}
}

func TestParameterInjection_Python_DoubleQuoted(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_py_dq")
	value := `"); open("` + canary + `","w").close(); print("`

	e := newTestExecutor()
	result, err := e.Execute(ScriptExecution{
		ID:         "inj-py-dquoted",
		ScriptType: ScriptTypePython,
		Script:     `print("{{name}}")`,
		Parameters: map[string]string{"name": value},
		Timeout:    10,
	})
	if err != nil {
		t.Logf("execute returned error (may be expected): %v", err)
	}
	canaryAbsent(t, canary)
	if got := strings.TrimSpace(result.Stdout); got != value {
		t.Fatalf("expected stdout to equal literal parameter value %q, got %q", value, got)
	}
}

func TestParameterInjection_Python_SingleQuoted(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not available")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_py_sq")
	value := `'); open('` + canary + `','w').close(); print('`

	e := newTestExecutor()
	_, err := e.Execute(ScriptExecution{
		ID:         "inj-py-squoted",
		ScriptType: ScriptTypePython,
		Script:     `print('{{name}}')`,
		Parameters: map[string]string{"name": value},
		Timeout:    10,
	})
	if err != nil {
		t.Logf("execute returned error (may be expected): %v", err)
	}
	canaryAbsent(t, canary)
}

func TestParameterInjection_CMD_Unquoted(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("cmd only available on Windows")
	}
	scratch := t.TempDir()
	canary := filepath.Join(scratch, "canary_cmd")
	value := "x & echo pwned > " + canary

	e := newTestExecutor()
	_, err := e.Execute(ScriptExecution{
		ID:         "inj-cmd-unquoted",
		ScriptType: ScriptTypeCMD,
		Script:     "echo {{name}}",
		Parameters: map[string]string{"name": value},
		Timeout:    10,
	})
	if err != nil {
		t.Logf("execute returned error (may be expected): %v", err)
	}
	canaryAbsent(t, canary)
}

// TestParameterInjection_PositiveControl_BenignValuesPassThrough is the
// control: with no shell metacharacters in the parameter value, substitution
// must still just work, both before and after any injection fix. If this
// test ever fails, the harness itself (not the vulnerability) is broken.
func TestParameterInjection_PositiveControl_BenignValuesPassThrough(t *testing.T) {
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
			name:   "double-brace placeholder",
			script: `echo "Threshold is {{threshold}}"`,
			params: map[string]string{"threshold": "42 percent (ok)"},
			want:   "Threshold is 42 percent (ok)",
		},
		{
			// The `${{key}}` form is consumed in full, including the leading
			// `$`. The old substituter replaced `{{key}}` first (a substring of
			// `${{key}}`), leaving a stray literal `$` in front of the value,
			// which bash then read as its own expansion — `$42 percent` became
			// positional parameter `$4` (empty) plus "2 percent". The shared
			// placeholder grammar in paramrefs.go matches the optional `$` as
			// part of the placeholder, so the value now passes through intact.
			name:   "dollar-double-brace placeholder",
			script: `echo "Threshold is ${{threshold}}"`,
			params: map[string]string{"threshold": "42 percent (ok)"},
			want:   "Threshold is 42 percent (ok)",
		},
		{
			name:   "hyphenated key",
			script: `echo "{{site-name}}"`,
			params: map[string]string{"site-name": "head quarters"},
			want:   "head quarters",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newTestExecutor()
			result, err := e.Execute(ScriptExecution{
				ID:         "inj-control-" + tt.name,
				ScriptType: ScriptTypeBash,
				Script:     tt.script,
				Parameters: tt.params,
				Timeout:    10,
			})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if result.ExitCode != 0 {
				t.Fatalf("exit code %d, stderr: %s", result.ExitCode, result.Stderr)
			}
			if got := strings.TrimSpace(result.Stdout); got != tt.want {
				t.Fatalf("expected stdout %q, got %q", tt.want, got)
			}
		})
	}
}
