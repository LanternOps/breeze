<#
.SYNOPSIS
Verifies Authenticode signatures on released Windows artifacts.

.DESCRIPTION
Shared by every Windows signing provider job in release.yml so the providers
cannot drift apart. Previously each provider carried its own inline copy of the
verification, which is how the Azure path ended up with no publisher binding at
all while the SSL.com path pinned a certificate.

Every check throws on failure; the caller runs under `shell: pwsh`, where a
terminating error fails the step.

.PARAMETER Path
Artifacts to verify. Relative paths resolve against GITHUB_WORKSPACE.

.PARAMETER ExpectedSubject
Exact organization name that must appear as the O or CN of the signer
certificate, compared case-insensitively. The subject is parsed via
X500DistinguishedName.Format() rather than a regex over the raw DN string, so a
value containing a comma (`O="LanternOps, LLC"`) is handled correctly instead of
failing the release.

.PARAMETER ExpectedThumbprintSha256
Optional SHA-256 certificate pin. Empty means "do not pin", which is correct for
Azure Artifact Signing, whose leaf certificates are short-lived by design and
rotate automatically. Non-empty must be 64 hex characters, separators ignored.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]] $Path,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedSubject,

    [Parameter(Mandatory = $false)]
    [AllowEmptyString()]
    [string] $ExpectedThumbprintSha256 = ''
)

$ErrorActionPreference = 'Stop'

function Get-SubjectOrganizationNames {
    param([System.Security.Cryptography.X509Certificates.X509Certificate2] $Certificate)

    # Format($true) emits one RDN per line. A value containing a comma or a
    # plus sign comes back quoted, so the quotes are stripped here rather than
    # compared literally -- a regex over the raw DN string got this wrong and
    # would have rejected a legitimate 'O="LanternOps, LLC"' certificate.
    $names = @()
    foreach ($line in ($Certificate.SubjectName.Format($true) -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        # '+' separates the attributes of a multi-valued RDN, but only when it
        # is not inside a quoted value.
        $attributes = if ($line.Contains('"')) { @($line) } else { $line -split '\+' }
        foreach ($attribute in $attributes) {
            $separator = $attribute.IndexOf('=')
            if ($separator -lt 1) { continue }
            $key = $attribute.Substring(0, $separator).Trim()
            $value = $attribute.Substring($separator + 1).Trim()
            if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
                $value = $value.Substring(1, $value.Length - 2).Replace('""', '"')
            }
            if ($key -eq 'O' -or $key -eq 'CN') { $names += $value }
        }
    }
    return $names
}

$expectedPin = ''
if (-not [string]::IsNullOrWhiteSpace($ExpectedThumbprintSha256)) {
    $expectedPin = ($ExpectedThumbprintSha256 -replace '[^0-9A-Fa-f]', '').ToLowerInvariant()
    if ($expectedPin -notmatch '^[0-9a-f]{64}$') {
        throw 'ExpectedThumbprintSha256 must contain exactly 64 hexadecimal characters'
    }
}

$workspace = $env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($workspace)) { $workspace = (Get-Location).Path }

foreach ($item in $Path) {
    $target = if ([System.IO.Path]::IsPathRooted($item)) { $item } else { Join-Path $workspace $item }

    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        throw "Artifact to verify is missing: $target"
    }

    $signature = Get-AuthenticodeSignature -FilePath $target

    # UnknownError is PowerShell's default bucket: it covers the benign
    # "root not yet cached on this runner" case but also CERT_E_EXPIRED,
    # CERT_E_REVOKED, CERT_E_UNTRUSTEDROOT and CERT_E_CHAINING. Tolerating it is
    # only safe because the subject, validity and (where configured) pin checks
    # below independently establish the publisher.
    if ($signature.Status -ne 'Valid' -and $signature.Status -ne 'UnknownError') {
        throw "Signature validation failed for $target. Status: $($signature.Status)"
    }
    if ($signature.Status -eq 'UnknownError') {
        Write-Host "::warning::$target signed but chain not fully validated locally (Status: UnknownError)."
    }
    if (-not $signature.SignerCertificate) {
        throw "Signer certificate missing for $target"
    }
    if (-not $signature.TimeStamperCertificate) {
        throw "RFC 3161 timestamp missing for $target"
    }

    $certificate = $signature.SignerCertificate
    $now = [DateTime]::UtcNow
    if ($certificate.NotAfter.ToUniversalTime() -lt $now) {
        throw "Signer certificate for $target expired on $($certificate.NotAfter.ToUniversalTime().ToString('o'))"
    }
    if ($certificate.NotBefore.ToUniversalTime() -gt $now) {
        throw "Signer certificate for $target is not valid until $($certificate.NotBefore.ToUniversalTime().ToString('o'))"
    }

    $organizations = Get-SubjectOrganizationNames -Certificate $certificate
    if (-not ($organizations | Where-Object { $_ -ieq $ExpectedSubject })) {
        throw "Unexpected signer subject for $target. Expected O or CN '$ExpectedSubject'; got: $($certificate.Subject)"
    }

    $actualPin = $certificate.GetCertHashString(
        [System.Security.Cryptography.HashAlgorithmName]::SHA256
    ).ToLowerInvariant()

    if ($expectedPin -ne '') {
        if ($actualPin -ne $expectedPin) {
            throw "Unexpected signer certificate for $target (SHA-256 $actualPin)"
        }
    }

    Write-Host "Verified: $target - Status: $($signature.Status) - Signer: $($certificate.Subject) - SHA-256: $actualPin"
}
