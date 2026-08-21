# SSL.com Public Release Signing Hardening Design

**Status:** Approved

## Context

The public `LanternOps/breeze` release workflow already supports selecting
Azure Artifact Signing or SSL.com eSigner for the Windows Viewer and Helper
MSIs. Commit `923626dc2` introduced the repository variable
`WINDOWS_SIGNING_PROVIDER`; `sslcom` selects eSigner and every other value
currently falls back to Azure.

That implementation establishes the provider switch but leaves two hardening
gaps:

1. Azure and SSL.com execute in the same job, so an SSL.com run retains
   `id-token: write`, even though only Azure needs OIDC.
2. The shared Authenticode check proves that a certificate and timestamp exist,
   but it does not prove an SSL.com signature came from the expected LanternOps
   certificate.

The public workflow intentionally publishes the self-host Agent family
(`agent`, `backup`, `watchdog`, `user-helper`, and `breeze-agent.msi`) unsigned.
Those artifacts are outside this signing-provider switch and must remain so.

## Goal

Harden the existing public Azure/SSL.com provider switch so each provider has
least-privilege credentials and SSL.com output is pinned to the expected
LanternOps certificate, without changing the public release asset set or
signing the Agent family.

## Non-goals

- Do not sign public Agent-family Windows EXEs or `breeze-agent.msi`.
- Do not change the public self-host/hosted edition boundary.
- Do not move hosted-release credentials or artifacts into the public workflow.
- Do not change macOS signing, notarization, manifest signing, or Linux assets.
- Do not configure or transmit secret values in committed files.

## Provider resolution

`vars.WINDOWS_SIGNING_PROVIDER` has exactly these meanings when
`vars.ENABLE_WINDOWS_SIGNING == 'true'`:

| Value | Result |
|---|---|
| unset or empty | Azure (backward-compatible default) |
| `azure` | Azure Artifact Signing |
| `sslcom` | SSL.com eSigner |
| any other value | fail before either signing job can run |

A dedicated resolution job normalizes the value and exposes one output:
`provider`, whose value is exactly `azure` or `sslcom`. A typo must never
silently select a credentialed provider.

## Job topology and permissions

The existing `sign-windows-tauri` job becomes a provider convergence gate,
while the actual signing work is split:

```text
build-viewer + build-helper
            |
    resolve signing provider
        /               \
Azure signer        SSL.com signer
(id-token: write)   (contents: read only)
        \               /
       sign-windows-tauri gate
                  |
      existing release integrity flow
```

Both signer jobs use the existing dynamic GitHub Environment:
`signing-production` for stable tags and `signing-prerelease` for tags with a
suffix. Only the selected provider job runs. The Azure job alone receives
`id-token: write`; the SSL.com job has `contents: read` and no OIDC permission.

Both jobs upload the same canonical artifact names, but mutual exclusivity
ensures only one producer exists in a run. The convergence gate checks that the
selected signer succeeded and the unselected signer was skipped. Existing
downstream jobs continue to depend on the `sign-windows-tauri` gate ID.

When `ENABLE_WINDOWS_SIGNING` is not `true`, all signer jobs and the convergence
gate remain skipped, preserving the existing public build-only behavior.

## SSL.com signing inputs

The following secrets live in both `signing-production` and
`signing-prerelease`:

- `SSLCOM_USERNAME`
- `SSLCOM_PASSWORD`
- `SSLCOM_CREDENTIAL_ID`
- `SSLCOM_TOTP_SECRET`
- `SSLCOM_CERT_SHA256`
- `SSLCOM_ENVIRONMENT_LABEL`

`SSLCOM_CERT_SHA256` is the 64-character lowercase SHA-256 thumbprint of the
expected LanternOps leaf certificate. It is intentionally environment-scoped
so certificate renewal can be staged in prerelease before production changes.

Environment scoping is load-bearing and invisible in the workflow: nothing about
the YAML differs between a stable and a prerelease tag except which environment
supplies these secrets. If they are added at repository level instead -- the
path of least resistance, and how every `AZURE_*` secret is stored today -- both
environments resolve the same credential and a prerelease tag is signed with the
production certificate, with every check passing. `SSLCOM_ENVIRONMENT_LABEL`
holds the environment's own name (`signing-production` / `signing-prerelease`)
and is compared against the environment the job actually runs in, so a
repository-level secret fails one of the two loudly. No lint rule can detect
this from the YAML, which is why it is enforced at run time.

The current SSL.com action remains pinned to the immutable commit behind its
`v1.3.2` tag:
`cf5f6c1d38ad10f47e3ed9aca873f429b1a8d85b`. No mutable branch or tag reference
may appear in the workflow.

The SSL.com job signs the Viewer MSI and Helper MSI in place with malware
blocking enabled. `clean_logs` is deliberately not set: it is a no-op in this
action, which computes `path.dirname()` over the entire command string and so
removes a path that never exists.

Pinning the action commit does **not** pin what the action executes. At run time
it downloads CodeSignTool from a mutable GitHub release asset with no integrity
check and runs it in this job, and separately installs Amazon Corretto resolved
from a floating "latest" index whose published checksum it reads but never
compares. Either download is arbitrary code execution alongside long-lived,
portable eSigner credentials. The job therefore stages CodeSignTool itself from
a digest-verified archive and exports `CODESIGNTOOL_PATH`, which the action
honours to skip its own fetch, and pins `JAVA_VERSION` so the Corretto path
never runs -- the verified archive bundles its own JDK.

The GitHub Environment scopes which credentials are readable. It is not by
itself an approval boundary: neither signing environment currently carries
required reviewers, only a `v*` tag restriction.

## Verification

Both providers run the **same** verification, `.github/scripts/Verify-WindowsSignature.ps1`.
Two inline copies previously drifted: the SSL.com copy pinned a certificate
while the Azure copy asserted only that some timestamped signature existed, so a
mis-set endpoint or certificate profile would have shipped under an unintended
publisher with every check green. Nothing downstream catches that -- the release
manifest's `platformTrust` field is a declaration, not a verification.

For every Viewer/Helper MSI, both providers must prove:

- the artifact exists;
- `Get-AuthenticodeSignature` returns `Valid` or `UnknownError`;
- `SignerCertificate` exists;
- `TimeStamperCertificate` exists, proving an RFC 3161 timestamp;
- the signer certificate is inside its validity window;
- an `O` or `CN` of the signer subject equals the expected publisher.

`UnknownError` is PowerShell's default bucket and also covers `CERT_E_EXPIRED`,
`CERT_E_REVOKED`, `CERT_E_UNTRUSTEDROOT` and `CERT_E_CHAINING`. Tolerating it is
only sound because the subject and validity checks establish the publisher
independently of chain building.

The subject is compared by parsing the DN with `X500DistinguishedName.Format()`
and unquoting each RDN value, not by matching a regex against the raw subject
string. A regex over the raw string rejects a legitimate
`O="LanternOps, LLC"` certificate outright -- fail-closed, but a release-day
outage that only appears at renewal.

The SSL.com path additionally requires the signer certificate SHA-256 thumbprint
to equal `SSLCOM_CERT_SHA256`, compared case-insensitively and ignoring
separators.

The Azure path pins no thumbprint, because Azure Artifact Signing certificates
are short-lived and rotate automatically. Identity there rests on the subject
assertion, which survives rotation.

## Public Agent-family non-regression

The existing public manifest guard remains authoritative:

- canonical Agent-family Windows assets have `platformTrust: "none"`;
- `-unsigned` copies retain `intendedUse: "signing-input"`;
- no public Agent-family Windows asset may acquire
  `windows-authenticode-required`;
- every public asset keeps `edition: "self-host"`.

New workflow-invariant tests explicitly assert that SSL.com references are
confined to the Viewer/Helper signer job and never mention the Agent-family
Windows filenames.

## Testing

Automated checks cover:

1. provider normalization: empty/`azure`/`sslcom` accepted, invalid rejected;
2. Azure is the only signer job with `id-token: write`;
3. SSL.com requires all five secrets and pins the action to the exact commit;
4. SSL.com verifies the expected certificate thumbprint and timestamp;
5. the public Agent-family filenames remain outside all SSL.com signing steps;
6. exactly one provider must succeed when signing is enabled;
7. existing workflow-security, supply-chain, manifest, and `actionlint` checks.

After configuration, the first live SSL.com exercise uses a prerelease tag.
The stable provider variable is switched only after the prerelease Viewer and
Helper MSIs pass local `Get-AuthenticodeSignature` verification and show the
expected LanternOps publisher.

## Rollback

Set `WINDOWS_SIGNING_PROVIDER=azure`. No code rollback or artifact-format
change is required. A release already published under one provider is never
re-signed or replaced; rollback applies only to the next release.

## Secret handling

No SSL.com username, password, TOTP seed, credential ID, certificate PIN, or
certificate thumbprint value is committed. Secret values are entered directly
into GitHub Environment secrets. Workflow output must never echo the assembled
CodeSignTool command or any secret-derived OTP.
