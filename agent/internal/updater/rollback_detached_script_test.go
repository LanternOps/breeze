package updater

import (
	"strings"
	"testing"
)

func testWindowsRollbackJournal() rollbackSwapJournal {
	return rollbackSwapJournal{
		SchemaVersion: 1,
		DirectiveID:   "rollback-id",
		State:         "prepared",
		Artifacts: []rollbackSwapJournalEntry{
			{Component: RollbackComponentAgent, LivePath: `C:\Program Files\Breeze\breeze-agent.exe`, BackupPath: `C:\Program Files\Breeze\.agent.old`, NewPath: `C:\Program Files\Breeze\.agent.new`},
			{Component: RollbackComponentBackup, LivePath: `C:\Program Files\Breeze\breeze-backup.exe`, BackupPath: `C:\Program Files\Breeze\.backup.old`, NewPath: `C:\Program Files\Breeze\.backup.new`},
		},
	}
}

func requireOrderedScriptFragments(t *testing.T, script string, fragments ...string) {
	t.Helper()
	previous := -1
	for _, fragment := range fragments {
		index := strings.Index(script, fragment)
		if index < 0 {
			t.Fatalf("script is missing %q:\n%s", fragment, script)
		}
		if index <= previous {
			t.Fatalf("script fragment %q is out of order:\n%s", fragment, script)
		}
		previous = index
	}
}

func TestBuildWindowsRollbackScript_StopsOwnedProcessesBeforeDurableCompleteSetSwap(t *testing.T) {
	script, err := buildWindowsRollbackScript(windowsRollbackScriptOptions{
		JournalPath: `C:\ProgramData\Breeze\agent-rollback-swap.json`,
		Journal:     testWindowsRollbackJournal(),
		Operation:   windowsRollbackSwap,
	})
	if err != nil {
		t.Fatal(err)
	}

	requireOrderedScriptFragments(t, script,
		"Stop-Service -Name 'BreezeWatchdog'",
		"Stop-Service -Name 'BreezeAgent'",
		"Get-Process -Name 'breeze-agent','breeze-helper','breeze-user-helper','breeze-desktop-helper','breeze-viewer','breeze-watchdog','breeze-backup'",
		"Write-RollbackJournal '",
		"Move-WriteThrough 'C:\\Program Files\\Breeze\\.agent.new' 'C:\\Program Files\\Breeze\\breeze-agent.exe'",
		"Move-WriteThrough 'C:\\Program Files\\Breeze\\.backup.new' 'C:\\Program Files\\Breeze\\breeze-backup.exe'",
		`"state":"swapped"`,
		"Start-Service -Name 'BreezeAgent'",
	)
	if !strings.Contains(script, "Flush($true)") {
		t.Fatalf("journal writes must be flushed before replacement:\n%s", script)
	}
}

func TestBuildWindowsRollbackScript_StopsOwnedProcessesBeforeRecovery(t *testing.T) {
	journal := testWindowsRollbackJournal()
	journal.State = "swapped"
	script, err := buildWindowsRollbackScript(windowsRollbackScriptOptions{
		JournalPath: `C:\ProgramData\Breeze\agent-rollback-swap.json`,
		Journal:     journal,
		Operation:   windowsRollbackRecover,
	})
	if err != nil {
		t.Fatal(err)
	}

	requireOrderedScriptFragments(t, script,
		"Stop-Service -Name 'BreezeWatchdog'",
		"Stop-Service -Name 'BreezeAgent'",
		"Get-Process -Name 'breeze-agent','breeze-helper','breeze-user-helper','breeze-desktop-helper','breeze-viewer','breeze-watchdog','breeze-backup'",
		"Copy-RecoveryFile 'C:\\Program Files\\Breeze\\.agent.old'",
		"Move-WriteThrough 'C:\\Program Files\\Breeze\\breeze-agent.exe.breeze-recover-",
		"Copy-RecoveryFile 'C:\\Program Files\\Breeze\\.backup.old'",
		"Remove-Item -LiteralPath 'C:\\ProgramData\\Breeze\\agent-rollback-swap.json'",
		"Start-Service -Name 'BreezeAgent'",
	)
}

func TestBuildWindowsRollbackScript_QuotesPathsAndJournal(t *testing.T) {
	journal := rollbackSwapJournal{
		SchemaVersion: 1,
		DirectiveID:   "rollback\u2019id",
		State:         "prepared",
		Artifacts: []rollbackSwapJournalEntry{
			{Component: RollbackComponentAgent, LivePath: "C:\\O\u2019Brien\\breeze-agent.exe", BackupPath: "C:\\O\u2019Brien\\.agent.old", NewPath: "C:\\O\u2019Brien\\.agent.new"},
		},
	}
	for _, op := range []windowsRollbackOperation{windowsRollbackSwap, windowsRollbackRecover} {
		script, err := buildWindowsRollbackScript(windowsRollbackScriptOptions{
			JournalPath: "C:\\ProgramData\\\u2018Breeze\u2019\\agent-rollback-swap.json",
			Journal:     journal,
			Operation:   op,
		})
		if err != nil {
			t.Fatal(err)
		}
		want := []string{
			"Move-WriteThrough $tempPath 'C:\\ProgramData\\\u2018\u2018Breeze\u2019\u2019\\agent-rollback-swap.json'",
			"Remove-Item -LiteralPath 'C:\\O\u2019\u2019Brien\\.agent.old' -Force",
		}
		if op == windowsRollbackSwap {
			want = append(want,
				"Move-WriteThrough 'C:\\O\u2019\u2019Brien\\.agent.new' 'C:\\O\u2019\u2019Brien\\breeze-agent.exe'",
				`"directiveId":"rollback`+"\u2019\u2019"+`id"`,
			)
		}
		for _, w := range want {
			if !strings.Contains(script, w) {
				t.Errorf("%s script missing %q:\n%s", op, w, script)
			}
		}
	}
}
