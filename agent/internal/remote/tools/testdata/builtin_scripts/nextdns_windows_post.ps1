$ErrorActionPreference = 'Stop'
& (Join-Path {{install.dir}} 'nextdns.exe') install -profile {{var.nextdns_profile_id}} -report-client-info -auto-activate
exit $LASTEXITCODE
