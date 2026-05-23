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
