//go:build windows

package wakeconfig

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const collectTimeout = 60 * time.Second

// readScript is READ-ONLY: it only calls Get-* cmdlets and reads one registry
// value. Adapters are matched by RegistryKeyword and the WakeOnMagicPacket
// enum, never by DisplayName/DisplayValue (those are localised).
const readScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
$hb=$null
try { $hb=(Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name 'HiberbootEnabled').HiberbootEnabled } catch { $hb=$null }
$nics=@()
try { $nics=@(Get-NetAdapter -Physical | Where-Object { $_.NdisPhysicalMedium -eq 14 }) } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }
$rows=@(foreach ($n in $nics) {
 $mp=$null
 try { $mp=([string](Get-NetAdapterPowerManagement -Name $n.Name).WakeOnMagicPacket).ToLowerInvariant() } catch { $mp=$null }
 $eee=$null
 try {
  $p=@(Get-NetAdapterAdvancedProperty -Name $n.Name -RegistryKeyword '*EEE')
  if ($p.Count -gt 0) { $eee=[string]@($p[0].RegistryValue)[0] }
 } catch {
  if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { $eee='error' }
 }
 [pscustomobject]@{ name=[string]$n.Name; mac=[string]$n.MacAddress; magicPacket=$mp; eee=$eee }
})
ConvertTo-Json -InputObject ([pscustomobject]@{ hiberboot=$hb; adapters=$rows }) -Depth 4 -Compress`

// CollectWindows reads fast startup and the wired adapters' wake settings in
// one PowerShell call.
func CollectWindows(ctx context.Context) (*WindowsReadings, error) {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", readScript)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("powershell exit %d: %s", exit.ExitCode(), strings.TrimSpace(truncate(stderr.String(), 300)))
		}
		return nil, err
	}
	return ParseWindowsReadings(bytes.TrimPrefix(bytes.TrimSpace(stdout.Bytes()), []byte("\xef\xbb\xbf")))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
