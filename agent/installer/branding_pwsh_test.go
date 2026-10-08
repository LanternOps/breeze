package installer

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
)

// These tests run the validation functions of build-msi.ps1 with pwsh instead
// of only reading the script text, so a check that is present but broken fails
// here. They are skipped when pwsh is not installed (the GitHub-hosted runners
// have it). They run on PowerShell 7; the script itself is used with Windows
// PowerShell 5.1 as well, and nothing here relies on a 7-only feature.

// pwshHarness extracts the two functions from the script with the PowerShell
// parser (so the script is not run), then applies them to a list of cases.
const pwshHarness = `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:BREEZE_TEST_PS1, [ref]$null, [ref]$null)
foreach ($n in ($env:BREEZE_TEST_FUNCS -split ',')) {
  $f = $ast.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true)
  if (-not $f) { throw "function $n not found in build-msi.ps1" }
  Invoke-Expression $f.Extent.Text
}
$cases = $env:BREEZE_TEST_CASES | ConvertFrom-Json
$out = foreach ($c in $cases) {
  try {
    if ($c.fn -eq 'assert') {
      Assert-BrandingValue -Name 'Field' -Value $c.value
      $r = $c.value
    } else {
      $r = Resolve-BrandingValue -Name 'Field' -Given $c.given -EnvName 'BREEZE_BRAND_X' -FromEnv $c.env
    }
    [pscustomobject]@{ refused = $false; result = [string]$r; message = '' }
  } catch {
    [pscustomobject]@{ refused = $true; result = ''; message = $_.Exception.Message }
  }
}
ConvertTo-Json -InputObject @($out) -Compress
`

type pwshCase struct {
	Fn    string `json:"fn"`
	Value string `json:"value,omitempty"`
	Given string `json:"given,omitempty"`
	Env   string `json:"env,omitempty"`
}

type pwshResult struct {
	Refused bool   `json:"refused"`
	Result  string `json:"result"`
	Message string `json:"message"`
}

// runPwsh loads the named functions from build-msi.ps1 and applies them to the cases.
func runPwsh(t *testing.T, funcs string, cases []pwshCase) []pwshResult {
	t.Helper()
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skip("pwsh is not installed")
	}
	path := os.Getenv("BREEZE_BUILD_MSI_PATH")
	if path == "" {
		path = "build-msi.ps1"
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatalf("abs %s: %v", path, err)
	}
	payload, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(pwsh, "-NoProfile", "-NonInteractive", "-Command", pwshHarness)
	cmd.Env = append(os.Environ(),
		"BREEZE_TEST_PS1="+abs,
		"BREEZE_TEST_FUNCS="+funcs,
		"BREEZE_TEST_CASES="+string(payload),
		"DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1",
		"POWERSHELL_TELEMETRY_OPTOUT=1",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("pwsh failed: %v\n%s", err, out)
	}
	var results []pwshResult
	if err := json.Unmarshal(out, &results); err != nil {
		t.Fatalf("cannot read the pwsh output: %v\n%s", err, out)
	}
	if len(results) != len(cases) {
		t.Fatalf("pwsh returned %d results for %d cases", len(results), len(cases))
	}
	return results
}

func TestAssertBrandingValueExecutes(t *testing.T) {
	accepted := []string{
		"Example MSP Agent",
		"Acme-IT & Co.",
		"Ação Ltda",
		strings.Repeat("a", 256),
	}
	// Refused by both the Go rules and build-msi.ps1.
	refusedEverywhere := []string{`Acme "Pro"`, "Acme's", `Acme\Pro`, "100% Co", "a\nb", strings.Repeat("a", 257)}
	// Refused only by build-msi.ps1: the MSI expands these in ServiceInstall
	// (Formatted columns) or the WiX preprocessor does.
	refusedByTheMsiOnly := []string{"Acme [IT]", "Acme ]", "Acme {x}", "Acme }", "Acme $(var.X)", "Acme !(loc.X)"}

	var cases []pwshCase
	for _, v := range accepted {
		cases = append(cases, pwshCase{Fn: "assert", Value: v})
	}
	for _, v := range refusedEverywhere {
		cases = append(cases, pwshCase{Fn: "assert", Value: v})
	}
	for _, v := range refusedByTheMsiOnly {
		cases = append(cases, pwshCase{Fn: "assert", Value: v})
	}
	results := runPwsh(t, "Assert-BrandingValue", cases)
	for i, c := range cases {
		wantRefused := i >= len(accepted)
		r := results[i]
		if r.Refused != wantRefused {
			t.Errorf("Assert-BrandingValue(%q): refused = %v, want %v (message %q)", c.Value, r.Refused, wantRefused, r.Message)
		}
		if r.Refused && strings.Contains(r.Message, c.Value) {
			t.Errorf("Assert-BrandingValue(%q) echoed the value in its message %q", c.Value, r.Message)
		}
	}
	for _, v := range refusedByTheMsiOnly {
		if !branding.Valid(v) {
			t.Errorf("%q is expected to be accepted by the Go rules (only the MSI refuses it)", v)
		}
	}
}

func TestResolveBrandingValue(t *testing.T) {
	cases := []struct {
		name        string
		given, env  string
		want        string
		wantRefused bool
	}{
		{"nothing set", "", "", "", false},
		{"only the parameter", "Example MSP Agent", "", "Example MSP Agent", false},
		{"only the variable", "", "Example MSP Agent", "Example MSP Agent", false},
		{"both and equal", "Example MSP Agent", "Example MSP Agent", "Example MSP Agent", false},
		{"both and different", "Other Name", "Example MSP Agent", "", true},
		// Stricter than before: a difference in case or in surrounding spaces is a
		// difference too, because the display names must match exactly.
		{"differs only in case", "example msp agent", "Example MSP Agent", "", true},
		{"differs only in trailing space", "Example MSP Agent ", "Example MSP Agent", "", true},
	}
	var in []pwshCase
	for _, tc := range cases {
		in = append(in, pwshCase{Fn: "resolve", Given: tc.given, Env: tc.env})
	}
	results := runPwsh(t, "Resolve-BrandingValue", in)
	for i, tc := range cases {
		r := results[i]
		if r.Refused != tc.wantRefused {
			t.Errorf("%s: refused = %v, want %v (message %q)", tc.name, r.Refused, tc.wantRefused, r.Message)
			continue
		}
		if tc.wantRefused {
			if !strings.Contains(r.Message, "must carry the same brand") {
				t.Errorf("%s: message %q does not explain the drift", tc.name, r.Message)
			}
			continue
		}
		if r.Result != tc.want {
			t.Errorf("%s: result = %q, want %q", tc.name, r.Result, tc.want)
		}
	}
}

// The validation rules exist twice, in Go (internal/branding) and in
// build-msi.ps1. They are allowed to differ only in one direction: the script
// may refuse more, so a bad value fails the build loudly. This test keeps the
// two from drifting apart unnoticed: whatever Go refuses the script refuses
// too, and what only the script refuses is exactly [ ] { } (plus the two
// preprocessor sequences, covered above).
func TestMsiValidationNeverAcceptsWhatGoRefuses(t *testing.T) {
	var cases []pwshCase
	var chars []rune
	for c := rune(0); c < 128; c++ {
		chars = append(chars, c)
		cases = append(cases, pwshCase{Fn: "assert", Value: "Acme" + string(c) + "Co"})
	}
	results := runPwsh(t, "Assert-BrandingValue", cases)

	onlyTheMsiRefuses := map[rune]bool{'[': true, ']': true, '{': true, '}': true}
	for i, c := range chars {
		value := "Acme" + string(c) + "Co"
		goRefuses := !branding.Valid(value)
		psRefuses := results[i].Refused
		switch {
		case goRefuses && !psRefuses:
			t.Errorf("U+%04X: Go refuses it but build-msi.ps1 accepts it", c)
		case psRefuses && !goRefuses && !onlyTheMsiRefuses[c]:
			t.Errorf("U+%04X (%s): build-msi.ps1 refuses it but Go accepts it; if that is intended, document it in the comment above Assert-BrandingValue and list it here", c, fmt.Sprintf("%q", c))
		}
	}
}
