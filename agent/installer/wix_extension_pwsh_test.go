package installer

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Install-WixUtilExtension runs on every MSI build, including the release
// pipeline's fresh runner. These tests run it with pwsh against a fake `wix`
// (a PowerShell function, which `& wix` resolves before the real executable),
// so the exit codes the real CLI returns are what the function sees.
//
// WiX v7 `wix extension list -g` exits 2 with no output when no global
// extension has been installed yet, which is the state of a fresh runner; the
// v0.122.0 release build failed on exactly that. Re-adding an installed
// extension exits 0.
const wixExtensionHarness = `
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:BREEZE_TEST_PS1, [ref]$null, [ref]$null)
$f = $ast.Find({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq 'Install-WixUtilExtension' }, $true)
if (-not $f) { throw "function Install-WixUtilExtension not found in build-msi.ps1" }
Invoke-Expression $f.Extent.Text
$case = $env:BREEZE_TEST_CASE | ConvertFrom-Json
$script:calls = @()
function wix {
  $script:calls += ($args -join ' ')
  if ($args[0] -eq 'extension' -and $args[1] -eq 'list') {
    foreach ($l in @($case.listOutput)) { if ($l) { $l } }
    $global:LASTEXITCODE = [int]$case.listExit
    return
  }
  if ($args[0] -eq 'extension' -and $args[1] -eq 'add') {
    $global:LASTEXITCODE = [int]$case.addExit
    return
  }
  throw "unexpected wix call: $($args -join ' ')"
}
try {
  Install-WixUtilExtension -WixVersion '7.0.0'
  $r = [pscustomobject]@{ threw = $false; message = ''; calls = @($script:calls) }
} catch {
  $r = [pscustomobject]@{ threw = $true; message = $_.Exception.Message; calls = @($script:calls) }
}
ConvertTo-Json -InputObject $r -Compress
`

type wixExtensionCase struct {
	ListOutput []string `json:"listOutput"`
	ListExit   int      `json:"listExit"`
	AddExit    int      `json:"addExit"`
}

type wixExtensionResult struct {
	Threw   bool     `json:"threw"`
	Message string   `json:"message"`
	Calls   []string `json:"calls"`
}

func runWixExtensionCase(t *testing.T, c wixExtensionCase) wixExtensionResult {
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
	payload, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(pwsh, "-NoProfile", "-NonInteractive", "-Command", wixExtensionHarness)
	cmd.Env = append(os.Environ(),
		"BREEZE_TEST_PS1="+abs,
		"BREEZE_TEST_CASE="+string(payload),
		"DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1",
		"POWERSHELL_TELEMETRY_OPTOUT=1",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("pwsh failed: %v\n%s", err, out)
	}
	var r wixExtensionResult
	if err := json.Unmarshal(out, &r); err != nil {
		t.Fatalf("cannot read the pwsh output: %v\n%s", err, out)
	}
	return r
}

func addCalls(calls []string) int {
	n := 0
	for _, c := range calls {
		if strings.HasPrefix(c, "extension add -g WixToolset.Util.wixext/7.0.0") {
			n++
		}
	}
	return n
}

func TestInstallWixUtilExtensionOnFreshGlobalCache(t *testing.T) {
	r := runWixExtensionCase(t, wixExtensionCase{ListExit: 2, AddExit: 0})
	if r.Threw {
		t.Fatalf("a fresh global extension cache (list exits 2) must not fail the build: %s", r.Message)
	}
	if addCalls(r.Calls) != 1 {
		t.Fatalf("expected one `wix extension add -g WixToolset.Util.wixext/7.0.0`, calls: %q", r.Calls)
	}
}

func TestInstallWixUtilExtensionSkipsAddWhenInstalled(t *testing.T) {
	r := runWixExtensionCase(t, wixExtensionCase{
		ListOutput: []string{"WixToolset.Util.wixext 7.0.0"},
		ListExit:   0,
		AddExit:    1,
	})
	if r.Threw {
		t.Fatalf("an installed matching extension must not fail the build: %s", r.Message)
	}
	if addCalls(r.Calls) != 0 {
		t.Fatalf("expected no add when the matching extension is listed, calls: %q", r.Calls)
	}
}

func TestInstallWixUtilExtensionAddsWhenOnlyAnotherVersionIsInstalled(t *testing.T) {
	r := runWixExtensionCase(t, wixExtensionCase{
		ListOutput: []string{"WixToolset.Util.wixext 4.0.5 (damaged)"},
		ListExit:   0,
		AddExit:    0,
	})
	if r.Threw {
		t.Fatalf("unexpected failure: %s", r.Message)
	}
	if addCalls(r.Calls) != 1 {
		t.Fatalf("expected the 7.0.0 extension to be added, calls: %q", r.Calls)
	}
}

func TestInstallWixUtilExtensionFailsWhenAddFails(t *testing.T) {
	r := runWixExtensionCase(t, wixExtensionCase{ListExit: 2, AddExit: 1})
	if !r.Threw {
		t.Fatalf("a failed `wix extension add` must fail the build, calls: %q", r.Calls)
	}
	if !strings.Contains(r.Message, "wix extension add WixToolset.Util.wixext/7.0.0 failed with exit code 1") {
		t.Fatalf("unexpected error message: %s", r.Message)
	}
}
