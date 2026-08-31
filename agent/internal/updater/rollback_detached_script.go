package updater

import (
	"encoding/json"
	"fmt"
	"strings"
)

type windowsRollbackOperation string

const (
	windowsRollbackSwap    windowsRollbackOperation = "swap"
	windowsRollbackRecover windowsRollbackOperation = "recover"
)

type windowsRollbackScriptOptions struct {
	JournalPath string
	Journal     rollbackSwapJournal
	Operation   windowsRollbackOperation
}

func powershellQuote(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}

func rollbackJournalPayload(journal rollbackSwapJournal, state string, next int) (string, error) {
	journal.State = state
	journal.Next = next
	payload, err := json.Marshal(journal)
	if err != nil {
		return "", err
	}
	return powershellQuote(string(payload)), nil
}

func appendWindowsRecovery(lines []string, journal rollbackSwapJournal, journalPath string, indent string) []string {
	for _, entry := range journal.Artifacts {
		recoveryPath := entry.LivePath + ".breeze-recover-" + rollbackPathToken(journal.DirectiveID)
		lines = append(lines,
			fmt.Sprintf("%sCopy-RecoveryFile '%s' '%s'", indent, powershellQuote(entry.BackupPath), powershellQuote(recoveryPath)),
			fmt.Sprintf("%sMove-WriteThrough '%s' '%s'", indent, powershellQuote(recoveryPath), powershellQuote(entry.LivePath)),
		)
	}
	for _, entry := range journal.Artifacts {
		lines = append(lines,
			fmt.Sprintf("%sRemove-Item -LiteralPath '%s' -Force -ErrorAction SilentlyContinue", indent, powershellQuote(entry.BackupPath)),
			fmt.Sprintf("%sRemove-Item -LiteralPath '%s' -Force -ErrorAction SilentlyContinue", indent, powershellQuote(entry.NewPath)),
		)
	}
	return append(lines, fmt.Sprintf("%sRemove-Item -LiteralPath '%s' -Force -ErrorAction SilentlyContinue", indent, powershellQuote(journalPath)))
}

// buildWindowsRollbackScript renders the detached, stop-before-mutate helper
// used for both the target-set swap and old-set recovery on Windows. Journal
// updates and executable replacements use write-through handles/primitives so
// a reboot cannot acknowledge a boundary that was only buffered in memory.
func buildWindowsRollbackScript(opts windowsRollbackScriptOptions) (string, error) {
	if opts.JournalPath == "" || opts.Journal.SchemaVersion != 1 || strings.TrimSpace(opts.Journal.DirectiveID) == "" || len(opts.Journal.Artifacts) == 0 {
		return "", fmt.Errorf("invalid Windows rollback journal")
	}
	if opts.Operation != windowsRollbackSwap && opts.Operation != windowsRollbackRecover {
		return "", fmt.Errorf("invalid Windows rollback operation")
	}

	lines := []string{
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -TypeDefinition @'",
		"using System;",
		"using System.Runtime.InteropServices;",
		"public static class BreezeRollbackNative {",
		"  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]",
		"  public static extern bool MoveFileEx(string existingName, string newName, int flags);",
		"}",
		"'@",
		"function Move-WriteThrough([string]$source, [string]$target) {",
		"  if (-not [BreezeRollbackNative]::MoveFileEx($source, $target, 9)) {",
		"    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())",
		"  }",
		"}",
		"function Write-RollbackJournal([string]$payload) {",
		fmt.Sprintf("  $tempPath = '%s.tmp-' + $PID", powershellQuote(opts.JournalPath)),
		"  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($payload)",
		"  $stream = [IO.FileStream]::new($tempPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)",
		"  try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }",
		fmt.Sprintf("  Move-WriteThrough $tempPath '%s'", powershellQuote(opts.JournalPath)),
		"}",
		"function Copy-RecoveryFile([string]$source, [string]$target) {",
		"  Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue",
		"  $input = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
		"  $output = [IO.FileStream]::new($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)",
		"  try { $input.CopyTo($output); $output.Flush($true) } finally { $output.Dispose(); $input.Dispose() }",
		"}",
		"Start-Sleep -Seconds 2",
		"try {",
		"  Stop-Service -Name 'BreezeWatchdog' -Force -ErrorAction SilentlyContinue",
		"  Stop-Service -Name 'BreezeAgent' -Force -ErrorAction SilentlyContinue",
		"  Get-Process -Name 'breeze-agent','breeze-helper','breeze-user-helper','breeze-desktop-helper','breeze-viewer','breeze-watchdog','breeze-backup' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue",
		"  Start-Sleep -Seconds 2",
	}

	if opts.Operation == windowsRollbackSwap {
		for index, entry := range opts.Journal.Artifacts {
			payload, err := rollbackJournalPayload(opts.Journal, "swapping", index)
			if err != nil {
				return "", err
			}
			lines = append(lines,
				fmt.Sprintf("  Write-RollbackJournal '%s'", payload),
				fmt.Sprintf("  Move-WriteThrough '%s' '%s'", powershellQuote(entry.NewPath), powershellQuote(entry.LivePath)),
			)
		}
		payload, err := rollbackJournalPayload(opts.Journal, "swapped", len(opts.Journal.Artifacts))
		if err != nil {
			return "", err
		}
		lines = append(lines, fmt.Sprintf("  Write-RollbackJournal '%s'", payload))
	} else {
		lines = appendWindowsRecovery(lines, opts.Journal, opts.JournalPath, "  ")
	}

	lines = append(lines,
		"  Start-Service -Name 'BreezeAgent'",
		"  Start-Service -Name 'BreezeWatchdog' -ErrorAction SilentlyContinue",
		"} catch {",
	)
	if opts.Operation == windowsRollbackSwap {
		// A partial target swap must never be restarted. Restore every old
		// component while all owned processes are still stopped.
		lines = appendWindowsRecovery(lines, opts.Journal, opts.JournalPath, "  ")
	}
	lines = append(lines,
		"  Start-Service -Name 'BreezeAgent' -ErrorAction SilentlyContinue",
		"  Start-Service -Name 'BreezeWatchdog' -ErrorAction SilentlyContinue",
		"}",
		"Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
	)
	return strings.Join(lines, "\r\n"), nil
}
