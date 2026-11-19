package hpwarrantyobserve

import (
	"strings"

	"github.com/breeze-rmm/agent/internal/psscript"
)

// The WMI read is one fixed Windows PowerShell script, built here from
// constants only (no device or server value is interpolated), so the literal
// guard has nothing to check and a test can read every line of it. It:
//
//   - lists the child namespaces of root/HP, root/HP/InstrumentedServices and
//     root/HP/InstrumentedServices/v1 (a missing namespace is an error code,
//     never a guess);
//   - when v1 exists, lists its class names and, for HP_Warranty and
//     HP_Entitlements, their property names and CIM types, their row count and,
//     for at most maxRows rows, the values of property names that pass the same
//     deny-then-allow filter the Go side applies again (Go is authoritative);
//   - prints the result as JSON.
//
// It reads only: Get-CimInstance, Get-CimClass and ConvertTo-Json. It never
// loads a module, calls HP's backend, runs winget or writes WMI. A value
// filtered out never leaves the PowerShell process.

// powershellArgs is the exact argv the runner passes to the System32 Windows
// PowerShell. The windows runner refuses any other argv.
func powershellArgs() []string {
	return []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-Command", wmiScript()}
}

// wmiScript is the read-only script; see the package comment.
func wmiScript() string {
	var b strings.Builder
	b.WriteString("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8\n")
	b.WriteString("$ErrorActionPreference = 'Stop'\n")
	b.WriteString("$ProgressPreference = 'SilentlyContinue'\n")
	b.WriteString("$deny = " + psscript.Quote(denyPattern) + "\n")
	b.WriteString("$allow = " + psscript.Quote(allowPattern) + "\n")
	b.WriteString("$ident = " + psscript.Quote(propertyNamePattern) + "\n")
	b.WriteString(wmiScriptBody)
	return b.String()
}

const wmiScriptBody = `
function Get-Code($e) {
  $x = $e.Exception
  if ($x -is [Microsoft.Management.Infrastructure.CimException]) { return 'cim_' + [string]$x.NativeErrorCode }
  return ('0x{0:X8}' -f $x.HResult)
}
function Get-Children($ns) {
  try {
    $n = @(Get-CimInstance -Namespace $ns -ClassName __NAMESPACE -ErrorAction Stop | ForEach-Object { [string]$_.Name } | Select-Object -First 64)
    return [ordered]@{ s = 'present'; n = $n }
  } catch { return [ordered]@{ s = (Get-Code $_); n = @() } }
}
function Get-Val($v) {
  if ($null -eq $v) { return [ordered]@{ k = 'null' } }
  if ($v -is [datetime]) { return [ordered]@{ k = 'datetime'; v = $v.ToUniversalTime().ToString('o') } }
  if ($v -is [string]) {
    if ($v.Length -gt 128) { $v = $v.Substring(0, 128) }
    return [ordered]@{ k = 'string'; v = $v }
  }
  if ($v -is [bool]) { return [ordered]@{ k = 'bool'; v = [string]$v } }
  if ($v -is [array]) { return [ordered]@{ k = 'array' } }
  if ($v -is [ValueType] -and -not ($v -is [timespan])) { return [ordered]@{ k = 'number'; v = [string]$v } }
  return [ordered]@{ k = 'other' }
}
$ns = 'root/HP/InstrumentedServices/v1'
$o = [ordered]@{}
$o.rootHp = Get-Children 'root/HP'
$o.isv = Get-Children 'root/HP/InstrumentedServices'
$o.v1 = Get-Children $ns
if ($o.v1.s -eq 'present') {
  try {
    $all = @(Get-CimClass -Namespace $ns -ErrorAction Stop | ForEach-Object { [string]$_.CimClassName } | Where-Object { -not $_.StartsWith('__') })
    $o.classes = [ordered]@{ s = 'present'; total = $all.Count; n = @($all | Sort-Object | Select-Object -First 64) }
  } catch { $o.classes = [ordered]@{ s = (Get-Code $_); total = 0; n = @() } }
  $cls = [ordered]@{}
  foreach ($c in @('HP_Warranty', 'HP_Entitlements')) {
    $r = [ordered]@{ s = 'present'; props = @(); rows = $null; rowsErr = $null; values = @() }
    try {
      $def = Get-CimClass -Namespace $ns -ClassName $c -ErrorAction Stop
      $r.props = @($def.CimClassProperties | Select-Object -First 128 | ForEach-Object { [ordered]@{ n = [string]$_.Name; t = [string]$_.CimType } })
      $names = @($def.CimClassProperties | ForEach-Object { [string]$_.Name } | Where-Object { $_ -match $ident -and $_ -notmatch $deny -and $_ -match $allow })
      try {
        $rows = @(Get-CimInstance -Namespace $ns -ClassName $c -ErrorAction Stop)
        $r.rows = $rows.Count
        $r.values = @($rows | Select-Object -First 25 | ForEach-Object {
          $row = $_
          $m = [ordered]@{}
          foreach ($n in $names) { $m[$n] = Get-Val $row.CimInstanceProperties[$n].Value }
          $m
        })
      } catch { $r.rowsErr = Get-Code $_ }
    } catch { $r.s = Get-Code $_ }
    $cls[$c] = $r
  }
  $o.cls = $cls
}
$o | ConvertTo-Json -Depth 8 -Compress
`
