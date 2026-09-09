# Hash a tree for byte-exact + metadata comparison (Windows).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File hash-tree.ps1 -Root C:\assure\src > out.tsv
#
# Same TSV shape as hash-tree.sh so compare-hashes.sh works on both:
#   F <relpath> <size> <sha256> <mtime-epoch-utc> <attrs>
#   L <relpath> SYMLINK <target>            (symlinks + junctions)
#   D <relpath>                             (only EMPTY directories)
# Relative paths use forward slashes. Unreadable files hash as UNREADABLE.
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Continue'
$rootFull = (Get-Item -LiteralPath $Root -Force).FullName.TrimEnd('\')
$prefixLen = $rootFull.Length + 1
$epoch = [DateTime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc)
$sha = [System.Security.Cryptography.SHA256]::Create()
$lines = New-Object System.Collections.Generic.List[string]

function Rel([string]$full) { ($full.Substring($prefixLen)) -replace '\\','/' }

Get-ChildItem -LiteralPath $rootFull -Recurse -Force -Attributes !ReparsePoint | ForEach-Object {
  $item = $_
  if ($item.PSIsContainer) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }
    $children = @(Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction SilentlyContinue)
    if ($children.Count -eq 0) { $lines.Add("D`t" + (Rel $item.FullName)) }
    return
  }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    $lines.Add("L`t" + (Rel $item.FullName) + "`tSYMLINK`t" + $item.Target)
    return
  }
  $hash = 'UNREADABLE'
  try {
    $fs = [System.IO.File]::Open($item.FullName, 'Open', 'Read', 'ReadWrite')
    try { $hash = ([System.BitConverter]::ToString($sha.ComputeHash($fs))).Replace('-','').ToLower() } finally { $fs.Close() }
  } catch { }
  $mtime = [long](($item.LastWriteTimeUtc - $epoch).TotalSeconds)
  $attrs = ($item.Attributes.ToString() -replace ' ','')
  $lines.Add("F`t" + (Rel $item.FullName) + "`t$($item.Length)`t$hash`t$mtime`t$attrs")
}
# Reparse points (symlinks, junctions) are skipped by -Attributes !ReparsePoint above; list them explicitly.
Get-ChildItem -LiteralPath $rootFull -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object {
  $lines.Add("L`t" + (Rel $_.FullName) + "`tSYMLINK`t" + ($_.Target -join ';'))
}
# Get-ChildItem -Recurse descends into directory symlinks and junctions; drop
# anything that lives under a reparse point so the tree is hashed once.
$linkDirs = @($lines | Where-Object { $_.StartsWith("L`t") } | ForEach-Object { (($_ -split "`t")[1]) + '/' })
if ($linkDirs.Count -gt 0) {
  $lines = @($lines | Where-Object {
    $l = $_; $p = ($l -split "`t")[1]
    -not ($linkDirs | Where-Object { $p.StartsWith($_) })
  })
}
$out = $lines | Sort-Object { ($_ -split "`t")[1] } -Culture 'en-US-POSIX' -ErrorAction SilentlyContinue
if (-not $out) { $out = $lines | Sort-Object { ($_ -split "`t")[1] } }
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdout = [Console]::OpenStandardOutput()
foreach ($l in $out) { $b = $utf8.GetBytes($l + "`n"); $stdout.Write($b, 0, $b.Length) }
$stdout.Flush()
