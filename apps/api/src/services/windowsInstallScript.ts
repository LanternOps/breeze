export function generateWindowsInstallScript(serverUrl: string): string {
  const escapedServerUrl = serverUrl.replace(/'/g, "''");

  return String.raw`function Install-BreezeAgent {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Token,
        [string]$EnrollmentSecret
    )

    $ErrorActionPreference = 'Stop'
    $serverUrl = '${escapedServerUrl}'
    $osv = [System.Environment]::OSVersion.Version
    if ($osv.Major -lt 10) {
        throw "Breeze: Windows 10 or Windows Server 2016 or later is required (detected $($osv.Major).$($osv.Minor))"
    }

    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    try {
        $meta = Invoke-RestMethod -Uri "$serverUrl/api/v1/agent-versions/latest?platform=windows&arch=amd64&component=agent" -UseBasicParsing -UserAgent 'BreezeInstaller/1.0'
    } catch {
        throw "Breeze: could not fetch release integrity metadata from $serverUrl - refusing to install without a trusted checksum"
    }

    $expectedSha = [string]$meta.checksum
    if ($expectedSha -notmatch '^[A-Fa-f0-9]{64}$') {
        throw "Breeze: release metadata did not include a valid SHA-256 checksum - refusing to install"
    }

    $version = [string]$meta.version
    if ([string]::IsNullOrWhiteSpace($version)) {
        throw "Breeze: release metadata did not include a version - refusing to install without a pinned download"
    }

    $guid = [guid]::NewGuid().ToString('N')
    $d = Join-Path $env:TEMP "breeze-install-$guid"
    New-Item -ItemType Directory -Path $d -ErrorAction Stop | Out-Null
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    icacls $d /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' ('*' + $sid + ':(OI)(CI)F') | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Breeze: could not set restrictive permissions on the staging directory $d"
    }
    $exe = Join-Path $d 'breeze-agent.exe'

    $downloadUrl = "$serverUrl/api/v1/agents/download/windows/amd64?version=$([uri]::EscapeDataString($version))"
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $exe -UseBasicParsing -UserAgent 'BreezeInstaller/1.0'
    } catch {
        if ("$($_.Exception)" -match 'remote certificate is invalid|establish trust relationship for the SSL/TLS') {
            throw "Breeze: this machine rejected the TLS certificate of $serverUrl ($($_.Exception.GetBaseException().Message)). If the server uses a self-signed or private-CA certificate, import its root CA into Cert:\LocalMachine\Root; otherwise check that the certificate matches the server name and has not expired. See https://docs.breezermm.com/deploy/tls/#trusting-the-internal-ca-on-agents"
        }
        throw
    }

    $b = [IO.File]::ReadAllBytes($exe)
    if ($b.Length -lt 2 -or $b[0] -ne 0x4D -or $b[1] -ne 0x5A) {
        throw "Breeze: downloaded file is not a Windows executable - a captive portal or web filter may be intercepting this network"
    }

    $sig = Get-AuthenticodeSignature $exe
    if ($sig.Status -ne 'NotSigned' -and $sig.Status -ne 'Valid') {
        throw "Breeze: downloaded agent binary has an invalid or untrusted signature ($($sig.Status)) - refusing to install"
    }

    $actualSha = (Get-FileHash -Algorithm SHA256 -Path $exe).Hash
    if ($actualSha.ToUpper() -ne $expectedSha.ToUpper()) {
        throw "Breeze: downloaded agent binary checksum does not match the server's release metadata - refusing to install"
    }

    $enrollArgs = @('enroll', $Token, '--server', $serverUrl)
    if ($EnrollmentSecret) {
        $enrollArgs += @('--enrollment-secret', $EnrollmentSecret)
    }
    & $exe @enrollArgs
    if ($LASTEXITCODE) {
        throw "Breeze: enrollment failed (exit code $LASTEXITCODE)"
    }

    & $exe service install
    if ($LASTEXITCODE) {
        throw "Breeze: service install failed (exit code $LASTEXITCODE)"
    }
}
`;
}
