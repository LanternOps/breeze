//go:build windows

package updater

import (
	"strings"
	"testing"
)

// TestBuildRestartScript_AgentOnly is the pre-#816 baseline: when the caller
// passes empty user-helper paths the generated script must not reference the
// user-helper at all (backward-compatible with releases that don't yet ship
// the breeze-user-helper artifact and with non-Windows release histories).
func TestBuildRestartScript_AgentOnly(t *testing.T) {
	got := buildRestartScript(restartScriptOptions{
		AgentTempPath:   `C:\Windows\Temp\breeze-agent-1234.exe`,
		AgentTargetPath: `C:\Program Files\Breeze\breeze-agent.exe`,
	})

	if !strings.Contains(got, `Copy-Item -Path 'C:\Windows\Temp\breeze-agent-1234.exe' -Destination 'C:\Program Files\Breeze\breeze-agent.exe' -Force`) {
		t.Fatalf("expected agent Copy-Item line; script was:\n%s", got)
	}
	if strings.Contains(got, "breeze-user-helper") {
		t.Fatalf("agent-only script should not mention user-helper; script was:\n%s", got)
	}
	if !strings.Contains(got, "Start-Service -Name 'BreezeAgent'") {
		t.Fatalf("expected Start-Service line; script was:\n%s", got)
	}
}

// TestBuildRestartScript_ErrorActionPreference asserts the generated script
// makes Copy-Item failures terminating. Without this, a Copy-Item failure
// during the swap would not propagate into the try/catch and the script
// would silently regress to the pre-#816 partial-success state.
func TestBuildRestartScript_ErrorActionPreference(t *testing.T) {
	got := buildRestartScript(restartScriptOptions{
		AgentTempPath:   `C:\tmp\agent.exe`,
		AgentTargetPath: `C:\Program Files\Breeze\breeze-agent.exe`,
	})
	if !strings.Contains(got, "$ErrorActionPreference = 'Stop'") {
		t.Fatalf("expected $ErrorActionPreference = 'Stop'; script was:\n%s", got)
	}
}

// TestBuildRestartScript_TryCatchWrapsSwap asserts the swap block (Copy-Item
// calls etc.) is wrapped in a single try { … } catch { … } so a failed Copy
// produces a structured failure log instead of a silent agent-only outcome.
func TestBuildRestartScript_TryCatchWrapsSwap(t *testing.T) {
	got := buildRestartScript(restartScriptOptions{
		AgentTempPath:        `C:\tmp\agent.exe`,
		AgentTargetPath:      `C:\Program Files\Breeze\breeze-agent.exe`,
		UserHelperTempPath:   `C:\tmp\helper.exe`,
		UserHelperTargetPath: `C:\Program Files\Breeze\breeze-user-helper.exe`,
	})

	tryIdx := strings.Index(got, "try {")
	catchIdx := strings.Index(got, "} catch {")
	if tryIdx < 0 {
		t.Fatalf("expected `try {` opener; script was:\n%s", got)
	}
	if catchIdx <= tryIdx {
		t.Fatalf("expected `} catch {` after `try {`; script was:\n%s", got)
	}

	// Both Copy-Item calls must live inside the try block (i.e. between the
	// `try {` opener and the `} catch {` line).
	agentCopy := `Copy-Item -Path 'C:\tmp\agent.exe' -Destination 'C:\Program Files\Breeze\breeze-agent.exe' -Force`
	helperCopy := `Copy-Item -Path 'C:\tmp\helper.exe' -Destination 'C:\Program Files\Breeze\breeze-user-helper.exe' -Force`
	agentIdx := strings.Index(got, agentCopy)
	helperIdx := strings.Index(got, helperCopy)
	if agentIdx < tryIdx || agentIdx > catchIdx {
		t.Fatalf("agent Copy-Item must be inside try { … } catch; script was:\n%s", got)
	}
	if helperIdx < tryIdx || helperIdx > catchIdx {
		t.Fatalf("helper Copy-Item must be inside try { … } catch; script was:\n%s", got)
	}
}

// TestBuildRestartScript_StartServiceInBothPaths verifies Start-Service is
// invoked in BOTH the try-success path (inside the try { … }) AND the catch
// path (so a partial-Copy failure still leaves the host with a service
// start attempt — better to fail the start with a corrupt agent than to
// leave the service stopped indefinitely).
func TestBuildRestartScript_StartServiceInBothPaths(t *testing.T) {
	got := buildRestartScript(restartScriptOptions{
		AgentTempPath:   `C:\tmp\agent.exe`,
		AgentTargetPath: `C:\Program Files\Breeze\breeze-agent.exe`,
	})

	// Count Start-Service invocations on the BreezeAgent service — must be 2
	// (one in try-path, one in catch-path). Test by substring count.
	const needle = "Start-Service -Name 'BreezeAgent'"
	count := strings.Count(got, needle)
	if count != 2 {
		t.Fatalf("expected Start-Service to appear twice (try + catch); got %d. Script was:\n%s", count, got)
	}

	// The catch-path Start-Service must use -ErrorAction SilentlyContinue
	// (since `$ErrorActionPreference = 'Stop'` is set globally and we DON'T
	// want a failed start inside the catch to re-throw and skip cleanup).
	if !strings.Contains(got, "Start-Service -Name 'BreezeAgent' -ErrorAction SilentlyContinue") {
		t.Fatalf("expected catch-path Start-Service with -ErrorAction SilentlyContinue; script was:\n%s", got)
	}
}

// TestBuildRestartScript_FailureLogUsesTemp verifies the structured failure
// log goes to ${env:TEMP}, not a hardcoded drive letter or
// C:\ProgramData\Breeze (which may not exist yet on a fresh install — see
// #609). %TEMP% is guaranteed to exist on any Windows host.
func TestBuildRestartScript_FailureLogUsesTemp(t *testing.T) {
	got := buildRestartScript(restartScriptOptions{
		AgentTempPath:   `C:\tmp\agent.exe`,
		AgentTargetPath: `C:\Program Files\Breeze\breeze-agent.exe`,
	})

	if !strings.Contains(got, "$env:TEMP") {
		t.Fatalf("expected failure log path to reference $env:TEMP; script was:\n%s", got)
	}
	if !strings.Contains(got, "breeze-update-failure-") {
		t.Fatalf("expected failure log filename pattern breeze-update-failure-<stamp>.log; script was:\n%s", got)
	}
	// `Out-File -Append -Encoding utf8` is the spec'd write call.
	if !strings.Contains(got, "Out-File") || !strings.Contains(got, "-Append") || !strings.Contains(got, "-Encoding utf8") {
		t.Fatalf("expected Out-File -Append -Encoding utf8 for the failure log; script was:\n%s", got)
	}
	// Defense-in-depth: no hardcoded C:\ProgramData log path crept in.
	if strings.Contains(got, `C:\ProgramData\Breeze\breeze-update-failure`) {
		t.Fatalf("failure log must not be written under C:\\ProgramData\\Breeze (may not exist on fresh installs); script was:\n%s", got)
	}
}

// TestBuildRestartScript_CleanupOutsideTryCatch asserts the Remove-Item
// cleanup lines run regardless of swap success/failure — they must live
// AFTER the closing `}` of the catch block, not inside try or catch.
func TestBuildRestartScript_CleanupOutsideTryCatch(t *testing.T) {
	got := buildRestartScript(restartScriptOptions{
		AgentTempPath:        `C:\tmp\agent.exe`,
		AgentTargetPath:      `C:\Program Files\Breeze\breeze-agent.exe`,
		UserHelperTempPath:   `C:\tmp\helper.exe`,
		UserHelperTargetPath: `C:\Program Files\Breeze\breeze-user-helper.exe`,
	})

	// Find the close of the catch block: the literal "\n}\r\n" — i.e. the
	// catch-closing brace must be followed by the cleanup Remove-Item lines.
	// Match the position of the catch-closing brace as the first standalone
	// "}" that follows the `} catch {` opener.
	catchOpenerIdx := strings.Index(got, "} catch {")
	if catchOpenerIdx < 0 {
		t.Fatalf("expected `} catch {`; script was:\n%s", got)
	}
	// The closing `}` of the catch is the next `}` AFTER `} catch {`'s `{`.
	closeIdx := strings.Index(got[catchOpenerIdx+len("} catch {"):], "\n}")
	if closeIdx < 0 {
		t.Fatalf("expected catch-block closing `}`; script was:\n%s", got)
	}
	catchCloseIdx := catchOpenerIdx + len("} catch {") + closeIdx

	// All Remove-Item lines must appear AFTER the catch close.
	for _, needle := range []string{
		`Remove-Item -Path 'C:\tmp\agent.exe' -Force -ErrorAction SilentlyContinue`,
		`Remove-Item -Path 'C:\tmp\helper.exe' -Force -ErrorAction SilentlyContinue`,
		"Remove-Item -Path $PSCommandPath -Force -ErrorAction SilentlyContinue",
	} {
		idx := strings.Index(got, needle)
		if idx < 0 {
			t.Fatalf("missing cleanup line %q; script was:\n%s", needle, got)
		}
		if idx < catchCloseIdx {
			t.Fatalf("cleanup line %q must appear after catch block close; script was:\n%s", needle, got)
		}
	}
}

// TestBuildRestartScript_WithUserHelper verifies that when both user-helper
// paths are provided the generated script emits a second Copy-Item AFTER the
// agent's and includes a cleanup step for the helper temp file. The ordering
// matters: the agent Copy-Item must come first so a partial failure still
// leaves a working (if pre-#816) install rather than an installed user-helper
// with a stale agent.
func TestBuildRestartScript_WithUserHelper(t *testing.T) {
	got := buildRestartScript(restartScriptOptions{
		AgentTempPath:        `C:\Windows\Temp\breeze-agent-1234.exe`,
		AgentTargetPath:      `C:\Program Files\Breeze\breeze-agent.exe`,
		UserHelperTempPath:   `C:\Windows\Temp\breeze-user-helper-5678.exe`,
		UserHelperTargetPath: `C:\Program Files\Breeze\breeze-user-helper.exe`,
	})

	agentCopy := `Copy-Item -Path 'C:\Windows\Temp\breeze-agent-1234.exe' -Destination 'C:\Program Files\Breeze\breeze-agent.exe' -Force`
	helperCopy := `Copy-Item -Path 'C:\Windows\Temp\breeze-user-helper-5678.exe' -Destination 'C:\Program Files\Breeze\breeze-user-helper.exe' -Force`

	agentIdx := strings.Index(got, agentCopy)
	helperIdx := strings.Index(got, helperCopy)
	if agentIdx < 0 {
		t.Fatalf("expected agent Copy-Item line; script was:\n%s", got)
	}
	if helperIdx < 0 {
		t.Fatalf("expected user-helper Copy-Item line; script was:\n%s", got)
	}
	if helperIdx <= agentIdx {
		t.Fatalf("user-helper Copy-Item must come AFTER agent Copy-Item; script was:\n%s", got)
	}

	// Helper temp file cleanup line.
	if !strings.Contains(got, `Remove-Item -Path 'C:\Windows\Temp\breeze-user-helper-5678.exe' -Force -ErrorAction SilentlyContinue`) {
		t.Fatalf("expected Remove-Item cleanup for helper temp; script was:\n%s", got)
	}
}

// TestBuildRestartScript_EscapesSingleQuotes guards the single-quote escaping
// pattern (PowerShell-injection safety): a path containing a literal single
// quote must be doubled inside the script so PowerShell parses it as a
// literal rather than a string-delimiter. This mirrors the agent-path
// escaping that's been in place since the helper was introduced — the
// user-helper path must follow the same rule (issue #816).
func TestBuildRestartScript_EscapesSingleQuotes(t *testing.T) {
	got := buildRestartScript(restartScriptOptions{
		AgentTempPath:        `C:\tmp\agent'evil.exe`,
		AgentTargetPath:      `C:\Program Files\Breeze\breeze-agent.exe`,
		UserHelperTempPath:   `C:\tmp\helper'evil.exe`,
		UserHelperTargetPath: `C:\Program Files\Breeze\breeze-user-helper.exe`,
	})

	if !strings.Contains(got, `'C:\tmp\agent''evil.exe'`) {
		t.Fatalf("expected agent path single quotes to be doubled; script was:\n%s", got)
	}
	if !strings.Contains(got, `'C:\tmp\helper''evil.exe'`) {
		t.Fatalf("expected user-helper path single quotes to be doubled; script was:\n%s", got)
	}
	// And the un-escaped form must NOT appear — that would mean we're shipping
	// a script PowerShell would terminate the string on, letting an attacker
	// inject commands via a crafted temp path.
	if strings.Contains(got, `'C:\tmp\agent'evil.exe'`) {
		t.Fatalf("agent path single quote was not escaped; script was:\n%s", got)
	}
}

// TestBuildRestartScript_HelperOnlyPathsAreIgnoredIfEmpty exercises the
// defensive code path where only one of the two helper paths is provided.
// We treat this as "no user-helper to install" rather than partially
// generating a broken script.
func TestBuildRestartScript_HelperOnlyPathsAreIgnoredIfEmpty(t *testing.T) {
	cases := []struct {
		name string
		opts restartScriptOptions
	}{
		{
			name: "temp set, target empty",
			opts: restartScriptOptions{
				AgentTempPath:      `C:\tmp\agent.exe`,
				AgentTargetPath:    `C:\Program Files\Breeze\breeze-agent.exe`,
				UserHelperTempPath: `C:\tmp\helper.exe`,
			},
		},
		{
			name: "target set, temp empty",
			opts: restartScriptOptions{
				AgentTempPath:        `C:\tmp\agent.exe`,
				AgentTargetPath:      `C:\Program Files\Breeze\breeze-agent.exe`,
				UserHelperTargetPath: `C:\Program Files\Breeze\breeze-user-helper.exe`,
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := buildRestartScript(tc.opts)
			if strings.Contains(got, `breeze-user-helper.exe' -Force`) {
				t.Fatalf("expected no user-helper Copy-Item when one path is empty; script was:\n%s", got)
			}
		})
	}
}
