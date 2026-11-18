package wakeconfig

// readScript is READ-ONLY: it only calls Get-* cmdlets and reads one registry
// value. Adapters are matched by RegistryKeyword and the WakeOnMagicPacket
// enum, never by DisplayName/DisplayValue (those are localised). It lives in an
// untagged file so its read-only guarantee is tested on every OS.
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
