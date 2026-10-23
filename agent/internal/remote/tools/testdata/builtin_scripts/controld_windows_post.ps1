$ErrorActionPreference = 'Stop'
$src = Get-ChildItem -Path {{install.dir}} -Recurse -Filter 'ctrld.exe' | Select-Object -First 1
if (-not $src) { Write-Error 'ctrld.exe not found in package'; exit 2 }
New-Item -ItemType Directory -Force -Path 'C:\ControlD' | Out-Null
Copy-Item -Force -Path $src.FullName -Destination 'C:\ControlD\ctrld.exe'
& 'C:\ControlD\ctrld.exe' start --cd-org {{var.controld_provisioning_code}}
exit $LASTEXITCODE
