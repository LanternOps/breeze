# Seed the backup-assurance fidelity corpus (Windows). ASCII-only source on purpose:
# unicode names are built from code points so the script survives PowerShell 5.1
# default encodings.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File seed-corpus.ps1 -Root C:\assure\src [-Big] [-Many 10000]
#
# Deterministic content (SHA-256 counter stream from a fixed passphrase) so two
# rigs seeded the same way hash identically. See docs/testing/backup-assurance/ 4.1.
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [switch]$Big,
  [int]$Many = 10000
)
$ErrorActionPreference = 'Stop'

function Write-PRand {
  param([string]$Path, [long]$Bytes, [string]$Seed)
  # .NET resolves relative paths against the process CWD, not PowerShell's location.
  if (-not [System.IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $script:RootFull $Path }
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  try {
    if ($Bytes -eq 0) { return }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $seedBytes = [System.Text.Encoding]::UTF8.GetBytes("breeze-assurance-$Seed")
    $buf = New-Object byte[] (1MB)
    $remaining = $Bytes
    $counter = [long]0
    while ($remaining -gt 0) {
      $fill = [Math]::Min($buf.Length, $remaining)
      $off = 0
      while ($off -lt $fill) {
        $ctr = [System.BitConverter]::GetBytes($counter)
        $block = $sha.ComputeHash($seedBytes + $ctr)   # 32 bytes
        $n = [Math]::Min(32, $fill - $off)
        [Array]::Copy($block, 0, $buf, $off, $n)
        $off += $n
        $counter++
      }
      $fs.Write($buf, 0, $fill)
      $remaining -= $fill
    }
  } finally { $fs.Close() }
}

function U { param([int[]]$cps) -join ($cps | ForEach-Object { [char]::ConvertFromUtf32($_) }) }

New-Item -ItemType Directory -Path $Root -Force | Out-Null
$script:RootFull = (Get-Item -LiteralPath $Root).FullName.TrimEnd('\')
$Root = $script:RootFull
Set-Location -LiteralPath $Root
[Environment]::CurrentDirectory = $Root
foreach ($d in 'sizes','names','content','meta','many','adversarial','empty') {
  if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force }
}

# --- sizes -------------------------------------------------------------------
Write-PRand 'sizes\0B.bin' 0 s0
Write-PRand 'sizes\1B.bin' 1 s1
Write-PRand 'sizes\4095B.bin' 4095 s4095
Write-PRand 'sizes\4096B.bin' 4096 s4096
Write-PRand 'sizes\1MiB.bin' 1MB s1m
Write-PRand 'sizes\100MiB.bin' 100MB s100m
if ($Big) { Write-PRand 'sizes\2.5GiB.bin' ([long]2560MB) big }

# --- names -------------------------------------------------------------------
$cafe   = 'caf' + (U 0xE9)                                   # cafe with e-acute
$naive  = 'na' + (U 0xEF) + 've r' + (U 0xE9) + 'sum' + (U 0xE9) + '.txt'
$jp     = U 0x65E5,0x672C,0x8A9E                             # Japanese
$jpfile = (U 0x30D5,0x30A1,0x30A4,0x30EB) + '.txt'
$emoji  = 'emoji ' + (U 0x1F680)                             # rocket
$emojif = 'rocket ' + (U 0x1F389) + '.bin'
Write-PRand "names\$cafe\$naive" 2048 n1
Write-PRand "names\$jp\$jpfile" 2048 n2
Write-PRand "names\$emoji\$emojif" 2048 n3
Write-PRand 'names\spaces in name\ leading and trailing .txt' 2048 n4
Write-PRand 'names\dots\.hidden' 2048 n5
Write-PRand 'names\dots\..double-dot-prefix' 2048 n7
Write-PRand 'names\special\#hash %percent +plus &amp ;semi ,comma.txt' 2048 n8
Write-PRand "names\special\quote'apos.txt" 2048 n9
$long = 'L' * 200
try {
  Write-PRand "names\$long\$long.txt" 2048 n12
} catch {
  # 200-char dir + 200-char name exceeds MAX_PATH without LongPathsEnabled; record it.
  Write-Warning "long name (>260) could not be created on this host: $($_.Exception.Message)"
  Set-Content -LiteralPath 'names\LONG-NAME-UNSUPPORTED.txt' -Value $_.Exception.Message
  Write-PRand "names\$long\short.txt" 2048 n12
}
# Deep nesting: 20 levels pushes the absolute path well past MAX_PATH (260).
$deep = 'names\deep'
1..20 | ForEach-Object { $deep = "$deep\level$_" }
try {
  Write-PRand "$deep\bottom.txt" 2048 n13
} catch {
  Write-Warning "long path (>260) could not be created on this host: $($_.Exception.Message)"
  Set-Content -LiteralPath 'names\LONG-PATH-UNSUPPORTED.txt' -Value $_.Exception.Message
}

# --- content -----------------------------------------------------------------
Write-PRand 'content\random.bin' 65536 c1
[System.IO.File]::WriteAllBytes("$Root\content\zeros-1MiB.bin", (New-Object byte[] 1MB))
$line = [System.Text.Encoding]::ASCII.GetBytes("the quick brown fox jumps over the lazy dog`n")
$fs = [System.IO.File]::Open("$Root\content\compressible-1MiB.txt", 'Create'); $w = 0
while ($w -lt 1MB) { $n = [Math]::Min($line.Length, 1MB - $w); $fs.Write($line, 0, $n); $w += $n }; $fs.Close()
[System.IO.File]::WriteAllBytes("$Root\content\edge-bytes.bin", [byte[]](0,1,2,127,128,255))
[System.IO.File]::WriteAllBytes("$Root\content\all-bytes.bin", [byte[]](0..255))
Copy-Item 'content\random.bin' 'content\random-duplicate.bin'
[System.IO.File]::WriteAllText("$Root\content\crlf.txt", "CRLF line 1`r`nCRLF line 2`r`n")
[System.IO.File]::WriteAllText("$Root\content\no-newline.txt", 'no trailing newline')
# Object-key collision probes (agent appends .gz to stored keys).
Write-PRand 'content\collide\report' 3000 col1
Write-PRand 'content\collide\report.gz' 3000 col2
Write-PRand 'content\collide\data.tar' 3000 col3
Write-PRand 'content\collide\data.tar.gz' 3000 col4
# Selective-restore prefix siblings.
Write-PRand 'content\prefix\pick.txt' 1500 pf1
Write-PRand 'content\prefix\pick.txt.bak' 1500 pf2
Write-PRand 'content\prefix\pick.txt2' 1500 pf3
Write-PRand 'content\prefix\pick.txtx\inner.txt' 1500 pf4
# Sparse file: 64 MiB apparent
$sp = [System.IO.File]::Open("$Root\content\sparse-64MiB.bin", 'Create')
$sp.SetLength(64MB); $sp.Seek(64MB - 4, 'Begin') | Out-Null; $sp.Write([System.Text.Encoding]::ASCII.GetBytes('tail'), 0, 4); $sp.Close()
& fsutil sparse setflag "$Root\content\sparse-64MiB.bin" | Out-Null

# --- metadata (Windows attributes + DACL + mtime) ------------------------------
Write-PRand 'meta\readonly.txt' 1024 m1;  Set-ItemProperty -LiteralPath 'meta\readonly.txt' -Name Attributes -Value ([IO.FileAttributes]::ReadOnly)
Write-PRand 'meta\hidden.txt' 1024 m2;    Set-ItemProperty -LiteralPath 'meta\hidden.txt' -Name Attributes -Value ([IO.FileAttributes]::Hidden)
Write-PRand 'meta\system.txt' 1024 m3;    Set-ItemProperty -LiteralPath 'meta\system.txt' -Name Attributes -Value ([IO.FileAttributes]::System)
Write-PRand 'meta\old-mtime.txt' 1024 m5; (Get-Item -LiteralPath 'meta\old-mtime.txt').LastWriteTimeUtc = [DateTime]::new(2020,1,2,3,4,5,[DateTimeKind]::Utc)
Write-PRand 'meta\explicit-acl.txt' 1024 m8
& icacls "$Root\meta\explicit-acl.txt" /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' /grant 'Users:R' | Out-Null
Write-PRand 'meta\hardlink\a.txt' 1024 m6
& cmd /c mklink /H "$Root\meta\hardlink\b.txt" "$Root\meta\hardlink\a.txt" | Out-Null
New-Item -ItemType Directory -Path 'meta\links' -Force | Out-Null
& cmd /c mklink "$Root\meta\links\sym-to-file" "$Root\sizes\1MiB.bin" | Out-Null
& cmd /c mklink /D "$Root\meta\links\sym-to-dir" "$Root\content" | Out-Null
& cmd /c mklink /J "$Root\meta\links\junction-to-dir" "$Root\content" | Out-Null
Write-PRand 'meta\ads-host.txt' 1024 m9
Set-Content -LiteralPath 'meta\ads-host.txt' -Stream 'breeze.assurance' -Value 'alternate-data-stream-1'

# --- many small files ----------------------------------------------------------
for ($i = 0; $i -lt $Many; $i++) {
  $d = [int][Math]::Floor($i / 1000)
  Write-PRand ("many\d$d\f$i.txt") 1000 "many$i"
}

# --- empty dirs + adversarial ----------------------------------------------------
New-Item -ItemType Directory -Path 'empty\a\b\c' -Force | Out-Null
Write-PRand 'adversarial\perm-denied.txt' 4096 adv1
& icacls "$Root\adversarial\perm-denied.txt" /inheritance:r /deny 'Everyone:(R)' | Out-Null
Write-PRand 'adversarial\locked-during-backup.txt' 4096 adv2
Write-PRand 'adversarial\appended-during-backup.txt' 4096 adv3
Write-PRand 'adversarial\deleted-during-backup.txt' 4096 adv4

Write-Output "seeded $Root (big=$($Big.IsPresent) many=$Many)"
