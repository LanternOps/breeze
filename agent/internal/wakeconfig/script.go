package wakeconfig

// readScript is READ-ONLY: it only calls Get-* cmdlets and reads one registry
// value. Adapters are matched by RegistryKeyword and the WakeOnMagicPacket
// enum, never by DisplayName/DisplayValue (those are localised). It lives in an
// untagged file so its read-only guarantee is tested on every OS.
//
// EEE is the standard *EEE keyword, else Intel's EEELinkAdvertisement (0 off,
// 1 on): Intel I219 drivers, as in Dell business desktops, have no *EEE, so
// without it EEE read as absent while it was on (lab OptiPlex 7060).
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
 foreach ($kw in @('*EEE','EEELinkAdvertisement')) {
  try {
   $p=@(Get-NetAdapterAdvancedProperty -Name $n.Name -RegistryKeyword $kw)
   if ($p.Count -gt 0) { $eee=[string]@($p[0].RegistryValue)[0]; break }
  } catch {
   if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { $eee='error'; break }
  }
 }
 [pscustomobject]@{ name=[string]$n.Name; mac=[string]$n.MacAddress; magicPacket=$mp; eee=$eee }
})
ConvertTo-Json -InputObject ([pscustomobject]@{ hiberboot=$hb; netAdapter=$na; adapters=$rows }) -Depth 4 -Compress`
