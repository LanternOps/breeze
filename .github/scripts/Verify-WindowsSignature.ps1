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
Optional SHA-256 certificate pin, or a comma-separated allowlist of them. Empty
means "do not pin", which is correct for Azure Artifact Signing, whose leaf
certificates are short-lived by design and rotate automatically.

Each entry must be 64 hex characters; internal separators such as the colons in
`C9:EA:...` are ignored, and entries are split on commas, semicolons and
whitespace. An allowlist exists so a certificate renewal can be staged: add the
incoming thumbprint alongside the outgoing one before the changeover, then drop
the old entry afterwards. Otherwise renewal is a release-day edit made after the
signing steps have already run and consumed eSigner quota.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]] $Path,

    [Parameter(Mandatory = $true)]
    [string] $ExpectedSubject,

    [Parameter(Mandatory = $false)]
    [AllowEmptyString()]
    [string] $ExpectedThumbprintSha256 = '',

    # Required to verify without a leaf pin. GitHub renders an unset secret as
    # an empty string, which binds to [string] as '' -- so without this switch a
    # deleted or mis-scoped SSLCOM_CERT_SHA256 silently turned pinning off and
    # still exited 0. Callers must now say so out loud.
    [Parameter(Mandatory = $false)]
    [switch] $AllowUnpinnedLeaf
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

$expectedPins = @()
if (-not [string]::IsNullOrWhiteSpace($ExpectedThumbprintSha256)) {
    # Split on list separators only: colons are kept, because a thumbprint is
    # commonly pasted in 'C9:EA:...' form.
    foreach ($candidate in ($ExpectedThumbprintSha256 -split '[,;\s]+')) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $normalized = ($candidate -replace '[^0-9A-Fa-f]', '').ToLowerInvariant()
        if ($normalized -notmatch '^[0-9a-f]{64}$') {
            throw 'Each ExpectedThumbprintSha256 entry must contain exactly 64 hexadecimal characters'
        }
        $expectedPins += $normalized
    }
    if ($expectedPins.Count -eq 0) {
        throw 'ExpectedThumbprintSha256 was set but contained no usable thumbprint'
    }
}

if ($expectedPins.Count -eq 0 -and -not $AllowUnpinnedLeaf) {
    throw 'ExpectedThumbprintSha256 is empty and -AllowUnpinnedLeaf was not supplied. A missing certificate pin must fail the release, not weaken it.'
}

$workspace = $env:GITHUB_WORKSPACE
if ([string]::IsNullOrWhiteSpace($workspace)) { $workspace = (Get-Location).Path }

foreach ($item in $Path) {
    $target = if ([System.IO.Path]::IsPathRooted($item)) { $item } else { Join-Path $workspace $item }

    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        throw "Artifact to verify is missing: $target"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $target

    # UnknownError is PowerShell's catch-all bucket. It covers the benign
    # "root not yet cached on this runner" case, but equally CERT_E_REVOKED,
    # TRUST_E_EXPLICIT_DISTRUST, CERT_E_EXPIRED and CERT_E_CHAINING -- so on its
    # own it establishes nothing. Subject and validity are self-asserted by the
    # certificate and cannot substitute: a self-signed certificate claiming the
    # expected subject satisfies both. Identity therefore has to come from
    # either the leaf pin or a chain that actually builds.
    if ($signature.Status -ne 'Valid' -and $signature.Status -ne 'UnknownError') {
        throw "Signature validation failed for $target. Status: $($signature.Status) ($($signature.StatusMessage))"
    }
    if ($signature.Status -eq 'UnknownError') {
        Write-Host "::warning::$target Authenticode status UnknownError: $($signature.StatusMessage)"
        if ($expectedPins.Count -eq 0) {
            # Unpinned: the chain is the only remaining binding, so require it to
            # build. Only a revocation response we could not fetch is tolerable.
            $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
            $chain.ChainPolicy.RevocationMode = 'Online'
            $chain.ChainPolicy.RevocationFlag = 'EntireChain'
            $built = $chain.Build($signature.SignerCertificate)
            $statuses = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
            $tolerable = @('NoError', 'RevocationStatusUnknown', 'OfflineRevocation')
            $fatal = @($statuses | Where-Object { $tolerable -notcontains $_ })
            if (-not $built -and $fatal.Count -gt 0) {
                throw "Unpinned signature for $target did not build a trusted chain: $($statuses -join ', ')"
            }
            Write-Host "Chain built for $target (status: $(if ($statuses) { $statuses -join ', ' } else { 'NoError' }))"
        }
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

    # Only the actual thumbprint is reported: the expected value is supplied as
    # a secret and would be masked anyway.
    if ($expectedPins.Count -gt 0 -and $expectedPins -notcontains $actualPin) {
        throw "Unexpected signer certificate for $target (SHA-256 $actualPin)"
    }

    Write-Host "Verified: $target - Status: $($signature.Status) - Signer: $($certificate.Subject) - SHA-256: $actualPin"
}
