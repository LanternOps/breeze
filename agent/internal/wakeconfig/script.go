package wakeconfig

// readScript is READ-ONLY: it only calls Get-* cmdlets and reads one registry
// value. Writes live in apply_script.go. Adapters are matched by RegistryKeyword and the WakeOnMagicPacket
// enum, never by DisplayName/DisplayValue (those are localised). It lives in an
// untagged file so its read-only guarantee is tested on every OS.
//
// The NetAdapter cmdlets are probed with Get-Command before use (#12138). A
// missing cmdlet raises CommandNotFoundException, whose category is also
// ObjectNotFound, so without the probe the Get-NetAdapter catch below would
// swallow it and the host would read as having no wired adapter. A host without
// them reports netAdapter=false and is not assessable.
const readScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
$hb=$null
try { $hb=(Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Power' -Name 'HiberbootEnabled').HiberbootEnabled } catch { $hb=$null }
$na=$true
foreach ($c in @('Get-NetAdapter','Get-NetAdapterPowerManagement','Get-NetAdapterAdvancedProperty')) { if (-not (Get-Command -Name $c -ErrorAction SilentlyContinue)) { $na=$false } }
$nics=@()
if ($na) { try { $nics=@(Get-NetAdapter -Physical | Where-Object { $_.NdisPhysicalMedium -eq 14 }) } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } } }
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
 $s5=$null
 try {
  $q=@(Get-NetAdapterAdvancedProperty -Name $n.Name -RegistryKeyword 'S5WakeOnLan')
  if ($q.Count -gt 0) { $s5=[string]@($q[0].RegistryValue)[0] }
 } catch {
  if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { $s5='error' }
 }
 [pscustomobject]@{ name=[string]$n.Name; mac=[string]$n.MacAddress; magicPacket=$mp; eee=$eee; s5=$s5 }
})
ConvertTo-Json -InputObject ([pscustomobject]@{ hiberboot=$hb; netAdapter=$na; adapters=$rows }) -Depth 4 -Compress`
