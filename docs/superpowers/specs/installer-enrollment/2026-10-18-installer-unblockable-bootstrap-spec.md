# Installer bootstrap from an independent artifact source when the control plane is filtered — spec

**Issue:** #8874 · **Composes with:** #8868 (block detection and diagnosis), #8870 (second control-plane domain), #8869 (agent ECH, shipped)
**Date:** 2026-10-18 · **Status:** Draft spec. No plan yet. Open Decisions below need owner answers before planning.
**Rigor:** high. The release workflow, the signed-manifest trust chain and the installer scripts are agent-shipped, high-blast-radius surfaces.

## 1. Problem

### 1.1 What fails

Some consumer and SMB ISP gateways block the hosted control-plane hostname by the SNI in the TLS ClientHello. They answer on 443 with a plaintext `HTTP/1.1 302` to a block page. DNS is not touched. #8869 lets an installed agent get through with Encrypted Client Hello (ECH). The MSI also works on such a network: it carries the agent binary, and its `bootstrap` custom action redeems the token in Go through `ech.NewClient` (`agent/internal/agentapp/bootstrap.go`, `redeemBootstrapToken`), with the one-shot ECH retry from the ECH spec §5.

Three install paths still fail on the first HTTPS call to the control plane. Their TLS stacks cannot do ECH (Schannel/.NET, curl, URLSession):

| Path | First control-plane call (as built) | What the user sees |
|---|---|---|
| Windows PowerShell one-liner (`apps/web/src/lib/installCommands.ts`, `winFetchChecksum`) | `GET <api>/api/v1/agent-versions/latest?platform=windows&arch=amd64&component=agent` for the SHA-256, then `GET <api>/api/v1/agents/download/windows/amd64?version=…` | `could not fetch release integrity metadata … refusing to install` (the underlying exception is dropped; #8868 W2 fixes the message) |
| macOS/Linux one-liner (same file, `unixCmd`) | `GET <api>/api/v1/agents/install.sh`. The script is a template literal in `apps/api/src/routes/agents/download.ts` (`generateInstallScript`). It then calls `agent-versions/latest` and the download, pkg and backup routes on the same host. | `Could not fetch the Breeze installer from <api>` |
| macOS installer app (`agent/installer/macos-app`, `BootstrapClient.fetch`) | `POST https://<host>/api/v1/installer/bootstrap` with `X-Breeze-Bootstrap-Token`. The arch-specific `.pkg` files are **bundled** in the app, so nothing is downloaded. | `Network error: …` |

Today's workaround is to download the MSI or pkg on another network and copy it over.

### 1.2 What already exists (re-scoping the issue)

- **No client-side fallback exists.** `apps/api/src/config/validate.ts` (~L1504–1524) says "installer fallback assets verified against the signed release manifest". That is **server-side**: in `BINARY_SOURCE=github` mode the API fetches the macOS pkg, the Helper installer and `Breeze Installer.app.zip` from GitHub and verifies them (`fetchVerifiedGithubReleaseArtifact` in `apps/api/src/services/releaseArtifactManifest.ts`, used by `installerBuilder.ts`). Every client download still goes through the control plane.
- **In github mode the bytes already come from GitHub.** The download routes answer `302` to `https://github.com/<repo>/releases/download/v<ver>/<asset>` (`download.ts` → `githubDownloadBase` in `binarySource.ts`). Only the metadata call, the 302 hop and the `install.sh` fetch touch the control plane.
- **The public GitHub release is the self-host edition only.** The manifest generator in `.github/workflows/release.yml` stamps every asset `"edition": "self-host"`. Its comment says hosted builds come from a separate private repository and never reach this manifest. A hosted deployment must run `BINARY_EDITION=hosted` with `BINARY_SOURCE=local` (`validate.ts`, the `binaryEdition === 'hosted'` block). `assertGithubFetchableEdition` (`apps/api/src/services/releaseAssetTrust.ts`) refuses hosted assets from any public GitHub release. A hosted-build agent (`hostpolicy.Enforced()`) only accepts `hosted` update artifacts (`agent/internal/updater/edition.go`, `editionAllowed`).
  **Consequence:** the issue's proposed fix ("fall back to the project's GitHub Releases") would install the **wrong edition** on hosted customer machines. That edition has no host-policy allowlist and an unsigned Windows exe. Hosted machines are exactly the population that hit the problem. A hosted fallback needs a hosted-edition source (Open Decision 1).
- **The signed release manifest** is `release-artifact-manifest.json`, plus `.ed25519` (raw Ed25519 over the exact bytes, base64) and `.minisig`. It is schema v1: `repository`, `release` (tag), `sourceCommit`, `releaseKind`, and `assets[]` entries of `{name, sha256, size, platformTrust, edition, signingIdentity?, signingTeamId?}`. It has **no timestamp or expiry**. The API verifies it against `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` (comma-separated, no key ids). The agent updater verifies the manifest it gets from the control plane against compiled-in roots (`embeddedManifestPublicKeys` in `agent/internal/updater/updater.go`) plus TOFU-pinned deployment keys (`agent/internal/config/manifestkeys.go`). `checksums.txt` (sha256sum format) is attached to the release but is excluded from the manifest.
- **Asset names are stable and unversioned.** The tag is in the URL path: `breeze-agent-{linux,darwin}-{amd64,arm64}`, `breeze-agent-windows-amd64.exe`, `breeze-backup-linux-{amd64,arm64}`, `breeze-agent-darwin-{amd64,arm64}.pkg`, `breeze-agent.msi`. A **server-only** release (`releaseKind: "server-only"`) carries no agent assets; its manifest names the `binariesRelease` that does.
- **One-liner tokens** come from `POST /devices/onboarding-token` (`apps/api/src/routes/devices/core.ts`). The TTL can be up to 365 days (`ENROLL_TOKEN_MAX_TTL_MINUTES`), so commands get pasted into RMM or MDM scripts and reused for months.
- **Enrollment already handles the filter:** `enroll` and `bootstrap` do one-shot ECH on the first filter signature and print `filterSignatureHint` (`agent/internal/agentapp/enroll_error.go`, `oneshot_ech.go`). The `bootstrap` subcommand's `--install-data "<msi path>|<token>|<server>"` input (`agent/internal/agentapp/main.go`, `resolveBootstrapInputs`) is OS-agnostic Go.
- **ECH limits that still apply:** ECH is not used through an HTTP proxy (`agent/internal/ech/transport.go`). It does not help when DNS for the control-plane name is poisoned (#8870's domain), or when the edge publishes no `ech=` record (most self-hosters).

### 1.3 Restated goal

When the control plane cannot be reached at the transport level, the one-liners get the **same bytes** the control plane would have served from an independent, pre-agreed artifact host. They verify those bytes against a trust anchor the operator received from the control plane **before** the device was on the filtered network. Then they run `enroll`, which has ECH. The macOS app needs no artifact source. It hands token redemption to the bundled agent.

"Unblockable" is aspirational. The design treats the artifact host as an **independent** fallback with a different blocking profile, not as a guarantee.

## 2. Users and scope

| Deployment | Who | Today's binary source | Fallback after this spec |
|---|---|---|---|
| **Hosted** (`BINARY_EDITION=hosted`, `BINARY_SOURCE=local`) | MSPs (partner scope) and their techs (org scope) using the hosted console; end devices on consumer or SMB networks | Local volume on the control plane | A public **hosted-edition distribution release** (Open Decision 1). Off until that exists and the owner sets it. |
| **Self-host, official repo** (`BINARY_SOURCE=github`, default `BINARY_GITHUB_REPOSITORY`) | Self-hosting MSPs | The 302 to the public GitHub release | On by default, same repo and tag the 302 already uses (Open Decision 2) |
| **Self-host, BYO-signing fork** (topology T1 of `docs/superpowers/specs/2026-08-09-selfhost-byo-signing-design.md`) | Self-hosters who sign their own builds | The 302 to their repo's release | On by default against their `BINARY_GITHUB_REPOSITORY`. If that repo is private, the fallback fetch fails closed with a clear message. |
| **Self-host, local volume** (`BINARY_SOURCE=local`, topology T2) | Air-gapped or BYO builds | Local volume | **Off** unless `INSTALLER_FALLBACK_SOURCE` names a mirror that serves identical bytes |

Partner scope vs org scope: no difference. Anyone who can mint an onboarding token (`installer_distribute` capability, `ORGS_WRITE`, MFA) gets the anchor in the same response. The anchor is public data. It is not tenant-specific and holds no credential.

In scope: the PowerShell one-liner, the macOS/Linux one-liner and `install.sh`, the macOS installer app, the release pipeline contract, API anchor issuance and config, and install-path telemetry.
Out of scope: the MSI and pkg double-click paths (they already work), and the items in §5.

## 3. Proposed design

### 3.1 Sources and fallback order

1. **Control plane, primary.** Unchanged. It keeps "latest promoted" resolution at run time, the edition scoping and the local-volume builds.
2. **#8870 alternate control-plane host,** once #8870 ships and the install artifact carries it. That is #8870's scope. This spec only reserves the slot: an alternate host is a control-plane host, so it goes before the artifact source.
3. **Artifact source**, a GitHub Releases download URL by pinned tag:
   - Shape: `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>`. GitHub redirects to its release-asset CDN, which today is `release-assets.githubusercontent.com` (older: `objects.githubusercontent.com`; both are already trusted by `trustedReleaseHost` in `agent/internal/agentapp/first_install_release.go`).
   - Clients follow redirects and **do not pin the CDN host**. Integrity comes from the hash, not the host.
   - Never `/releases/latest/…`.
   - Non-GitHub mirrors are allowed only for self-host by explicit config.

Why GitHub Releases and not the alternatives:
- A first-party CDN on our own domain sits in the same reputation class as the control plane.
- The #8870 domain is a control-plane domain that will build up its own reputation.
- Object storage on a shared cloud domain is commonly filtered per bucket, because virtual-hosted bucket names travel in SNI.
- Blocking GitHub's release CDN breaks a large share of software updates, so consumer filters do not realistically do it.
- Corporate egress policies sometimes do block GitHub. In that case the fallback simply fails closed.

### 3.2 Trust: the anchor travels with the token (no client-side signature verification)

**Rejected:** embedding an Ed25519 public key in the scripts and verifying the signed manifest on the client.
- Windows PowerShell 5.1 runs on .NET Framework, which has no Ed25519.
- Bash cannot count on an Ed25519-capable `openssl`, and macOS ships LibreSSL.
- A bundled verifier binary has to be fetched and verified itself, so the problem just moves.
- Keys embedded in copy-pasted text that lives in RMM scripts for months make key rotation a fleet-wide paste problem.
- Quorum agreed: possible, but not worth the extra dependency and the second bootstrap-trust problem.

**Design:** `POST /devices/onboarding-token` already runs in an authenticated, MFA-gated console session over TLS, on the operator's network. Its response gains an optional `installFallback` object, computed server-side from a release manifest the API has **verified** against `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`. In local mode that is the manifest in the binaries volume; in github mode it is the manifest of the synced release. The web builder embeds the object in the commands. Its content (exact encoding is left to the plan):

```
installFallback: {
  release:   "v0.124.0",                  // the tag that CARRIES the binaries (binariesRelease for a server-only release)
  baseUrl:   "https://github.com/<owner>/<repo>/releases/download/v0.124.0/",
  validUntil: "<RFC 3339>",               // Open Decision 3
  assets: {                               // only the assets the one-liners consume; sha256 from the verified manifest entry
    "install.sh": "<sha256>",
    "breeze-agent-windows-amd64.exe": "<sha256>",
    "breeze-agent-linux-amd64": "<sha256>", "breeze-agent-linux-arm64": "<sha256>",
    "breeze-backup-linux-amd64": "<sha256>", "breeze-backup-linux-arm64": "<sha256>",
    "breeze-agent-darwin-amd64.pkg": "<sha256>", "breeze-agent-darwin-arm64.pkg": "<sha256>"
  },
  macosPkgPublisher: { teamId: "<10 chars>", signingIdentity: "<string>" }   // from the manifest's signingTeamId/signingIdentity
} | null
```

Rules:
- **Null means no fallback.** The API returns `null` (and the commands are byte-identical to today's) when any of these holds: the fallback source is off; the manifest cannot be verified; a consumed asset is missing from the manifest, or has no unique entry; an asset's `edition` does not match the deployment's `BINARY_EDITION`; an asset's `platformTrust` fails the existing positive allowlist; the asset is a `signing-input`.
- **The version** is the one the primary path would install at mint time: the deployment's `isLatest` row for its edition, the same row `GET /agent-versions/latest` resolves. The tenant agent pin (#2124) still governs upgrades after enrollment. A device installed through the fallback converges the same way a primary-path install does.
- **Exact bytes.** The client accepts only bytes whose SHA-256 equals the embedded value for that asset name. It does not trust anything else it downloads: no fetched manifest, no `checksums.txt`, no redirect target. The trust equals today's, where the runtime checksum also comes from the API over TLS. Here it simply arrives earlier.
- **Key rotation and revocation stay server-side.** The client never sees a key. A rotated or revoked release key changes **future** anchors only. Commands that were already copied keep authorizing the bytes they pinned until `validUntil` (Open Decision 3), which is why the anchor carries one.
- **Downgrade and replay.** Bytes cannot be substituted. The residual risk is installing the pinned version after newer ones exist. Two controls bound it:
  - `validUntil`: an expired anchor disables the fallback. The primary path still works.
  - An installed-version floor: in fallback mode, the scripts refuse to replace an installed `breeze-agent` whose `--version` is newer than the pinned release. They keep the newer binary and go on to `enroll` with it. The version probe execs the known install path directly, with no `PATH` lookup.

  `validUntil` reads the device clock, so it is best-effort hygiene, not a security boundary. The hash pin is the boundary. The floor does not cover a fresh install or a reinstall after uninstall, so those can still install a pinned release as old as `validUntil` allows.
- **Yanking a release.** Commands that were already copied cannot be reached. The real kill switch for a bad release is deleting its assets from the artifact source, which makes every anchor pinned to it fail closed. The release runbook gets this step.
  Heartbeat upgrades never downgrade (`mainAgentUpgradeDecision`), but they are gated by the effective partner+org update policy (`updateGateAllows` in `apps/api/src/routes/agents/heartbeat.ts`), so "it will upgrade itself" is not assumed.
- **No bypass of an untrusted certificate.** The fallback never engages on a certificate-verification failure (§3.4). That keeps #8868's rule that `untrusted_certificate` is never routed around.

### 3.3 `install.sh` becomes a static, released file

The served script's only interpolations are the usage comments (`generateInstallScript(serverUrl)`); the server comes from `--server`. Change:
- Move the script to a checked-in file. "Byte-identical" means the API's **response body** equals the file. Today's template uses `\${…}` escapes, so the reference is the rendered output, not the TS source, and a golden-file test pins it. The API serves it (`GET /api/v1/agents/install.sh` keeps its route, its public-download rate limit, `Cache-Control: no-cache` and the 503 when no server URL is configured). The usage comments use a placeholder host.
- `release.yml` attaches `install.sh` to every binaries-carrying release, so it is listed in the signed manifest. A server-only release does not carry it; the anchor points at `binariesRelease`.
- The **hosted** pipeline (private, owner) attaches the same file, from this repo at the release's `sourceCommit`.
- `install.sh` gains a stable fallback interface, versioned by a comment marker, for example `# breeze-install-fallback: 1`, and passed as **argv flags**. The values are public, and `sudo VAR=… bash` is refused on hosts whose sudoers lack `SETENV`. The token and secret keep today's handling.
  - Flags: `--fallback-base`, `--fallback-sha256s` (name=sha list), `--fallback-valid-until`, `--fallback-pkg-team-id` and `--fallback-pkg-identity`, or a single `--fallback-spec` that carries all of them. The plan picks the form.
  - The script regex-validates every value before use: an https base with no userinfo, query or fragment; 64-hex hashes; known asset names; an RFC 3339 time; a 10-character team ID. If any value is invalid, it ignores the whole fallback.
  - When the flags are present and a control-plane call fails at the transport level, every later fetch in the run uses the fallback: version metadata, the agent binary, the backup helper and the pkg.
  - Missing fallback inputs mean today's behavior.
- **Version skew is expected.** The primary path gets the script from the API's image; the fallback gets the copy attached to the anchor's release. Both must honor the fallback interface at the marker version they declare. A script that does not know an anchor's schema ignores it and behaves as today.
- **Backup helper:** the fallback covers `breeze-backup-linux-*`. If it is missing from the anchor, the script prints the existing non-fatal warning.
- **macOS pkg in fallback mode:** keep `verify_sha256`, the `xar!` magic check, the `pkgutil --check-signature` identity binding against `--fallback-pkg-team-id`/`--fallback-pkg-identity` (replacing the `X-Breeze-MacOS-*` response headers) and `spctl --assess --type install`.

### 3.4 Trigger: fall back only on a transport failure that carries no origin response

The rule: fall back only when the control plane provably did not answer.
- Any HTTP status from the origin is a server answer: no fallback, today's message.
- A 200 whose body is HTML (captive portal) is no fallback either, because GitHub would be captive too.
- A proxy CONNECT rejection (403/407) is no fallback. It is the customer's own proxy policy, and the message says so.
- Certificate verification failure is never a fallback.
- Exact allowlists per client (the plan pins them against the lab):

| Client | Fall back on | Never fall back on |
|---|---|---|
| PowerShell 5.1 / 7 | Exception chain contains a `WebException` with `Status` ∈ {`NameResolutionFailure`, `ConnectFailure`, `SecureChannelFailure`, `ReceiveFailure`, `ConnectionClosed`, `SendFailure`} **and no `Response`**, or PS 7 `HttpRequestException` with no `StatusCode` whose inner chain is a socket or IO error, **and** none of the certificate markers in the next column | Any HTTP status. **Certificate failures, classified by structure and never by message text** (messages are localized): `WebExceptionStatus.TrustFailure`, any `System.Security.Authentication.AuthenticationException` in the inner chain, or an `HResult` in the certificate-trust family (for example `0x80090325`, `0x800B0109`, `0x800B010F`). The English regex in the `winDownload` const (`remote certificate is invalid\|establish trust relationship for the SSL/TLS`) stays only to pick today's message. `ProxyNameResolutionFailure` and proxy 407; cancellation or timeout before connect |
| curl (one-liner and `install.sh`) | Exit 6 (resolve), 7 (connect), 35 (TLS handshake: the plaintext-302 filter produces this), and 52/56 only when `%{http_code}` is `000` and `%{http_connect}` is `000` | 22 or any non-`000` `http_code`; 60 (certificate); 5/`%{http_connect}` ≠ `000` (proxy); 28 when a response line was seen |
| URLSession (macOS app) | `NSURLErrorCannotFindHost`, `NSURLErrorCannotConnectToHost`, `NSURLErrorDNSLookupFailed`, and `NSURLErrorSecureConnectionFailed` **only** when no nested certificate error is present (`NSURLErrorServerCertificate*`, `kCFStreamErrorDomainSSL` trust codes) and the task saw no response or redirect | Timeouts after the request was sent; any `HTTPURLResponse`; any redirect history; certificate errors |

The URLSession rule is the strictest because a `max_usage = 1` bootstrap token may already be consumed if the request reached the server. Proxy settings are always honored. The fallback fetch uses the same proxy the primary used.

### 3.5 Per-client behavior

**Windows one-liner** (`installCommands.ts`):
- When `installFallback` is present, `winFetchChecksum`'s `catch` classifies the exception (§3.4).
- If the fallback is allowed and `validUntil` has not passed, it sets `$meta` from the embedded `{release, sha256}` and the download URL to `baseUrl + 'breeze-agent-windows-amd64.exe'`, and prints one line: `Breeze: <api> is unreachable from this network (<base exception message>); downloading the pinned release from the fallback source`.
- Otherwise it throws with the #8868 message.
- The rest is unchanged and runs against whichever source answered: the private staging dir, the MZ check, the best-effort Authenticode check and the checksum check.
- If the **download** call fails at the transport level after the metadata call succeeded, the same rule applies. The switch covers the **whole run**: `$meta` is discarded, and both the URL and `$expectedSha` come from the anchor. Mixing the primary's checksum with the pinned release's bytes would always fail closed. Every later fetch in the run also uses the fallback. Test case: the metadata call succeeds, the download fails at transport.
- Then `enroll` (one-shot ECH) and `service install`, as today. The installed-version floor applies before an existing binary is replaced.

**macOS/Linux one-liner** (`unixCmd`):
- On a transport-class failure fetching `install.sh` (§3.4), and only if the anchor is present and unexpired, fetch `baseUrl + 'install.sh'`.
- Require `sha256(file) == assets["install.sh"]`. Use `sha256sum` or `shasum -a 256`, whichever exists; if neither does, fail closed.
- No fallback request carries the enrollment token, the secret or an `Authorization` header. Credentials only ever go to the control plane, at `enroll`.
- **Verify as root, then run the verified copy,** so there is no check-then-exec race on a user-owned temp file. Under `sudo`, copy the file into a root-owned `mktemp` file, check its SHA-256 there, and execute that copy with the `--fallback-*` flags (§3.3). The hash check in the user shell only gives an earlier, friendlier error.
- Every fallback `curl` uses `--proto '=https' --proto-redir '=https'`. PowerShell fallback downloads keep `-OutFile` into the private staging dir and refuse a non-https redirect.
- The shebang check stays for the primary path. The hash replaces it for the fallback path.

**`install.sh`:** as in §3.3. Its pre-flight probe treats a transport-class failure as "switch to fallback" when the fallback flags are present, instead of `fatal`. Every other pre-flight outcome is unchanged.

**macOS installer app** (Swift):
- On a §3.4-qualifying failure of `BootstrapClient.fetch`, show a consent step instead of the error: "This Mac can't reach `<host>` directly. The agent can try an encrypted connection after it is installed. Install anyway?"
- On consent, run `installer -pkg` and then `"$B" bootstrap --install-data "|<token>|https://<host>" --quiet`, using the existing installed-binary discovery in `Installer.privilegedCommand`.
- The Go path redeems the token over ECH, gates the host through `hostpolicy`, enrolls, and refunds the slot on a definitive 4xx (`cancelBootstrapIfRefundable`).
- **Lost in this mode:** the pre-install "Installing for `<orgName>`" confirmation. The consent copy says so.
- The **Retry** action uses the same classification.
- After an ambiguous failure (timeout after send), the app gives recovery steps ("download a fresh installer from the console") and does not imply the token is still usable.
- Today's tests do not cover the empty-path form of `--install-data`: `bootstrap_test.go` assumes a non-empty path. W3 adds that case, or the app passes a sentinel path.
- If the plan finds `bootstrap`'s MSI-specific behavior (rollback exit codes, the major-upgrade guard) unsuitable, it adds `--token`/`--server` flags to `bootstrap`. That is an agent change, in the same wave.

### 3.6 Enrollment after download

**No queue-and-retry daemon.** A service holding an unredeemed token on disk and retrying for days is a new credential-at-rest surface and a new state machine. The 365-day token TTL would make it worse.

`enroll` runs as today. One-shot ECH covers SNI filtering where the edge publishes an ECH config. It does not cover DNS poisoning (#8870), an HTTP proxy (ECH is bypassed there) or a self-hosted edge without `ech=`. In those cases `enroll` fails with its existing classified message, including `filterSignatureHint`, and the scripts print the agent's stderr unchanged.

"Enrolled" does not mean "fully installed." The Windows `service install` can succeed with the watchdog deferred (`exit_codes.go`). The scripts keep reporting that state and do not hide it.

### 3.7 Defender, SmartScreen and Gatekeeper

The fallback fetches **the same bytes**, so the Authenticode signature (where present), Developer ID signature, notarization and stapling travel with them. `Invoke-WebRequest -OutFile` and curl set no Mark-of-the-Web or quarantine attribute, so SmartScreen and Gatekeeper do not prompt any differently than today. The pkg checks in `install.sh` run in both modes.

This spec **tests these outcomes rather than promising them**: EDR products also score the download host and parent process. The hosted distribution release must carry the hosted pipeline's **already-signed** bytes, not re-signed copies, or every hash in every anchor would differ from the control plane's.

### 3.8 Configuration

One new API env, `INSTALLER_FALLBACK_SOURCE`, added to the config schema (`validate.ts`) and the compose `environment:` mappings:
- `auto` (default):
  - `BINARY_SOURCE=github` → `https://github.com/<BINARY_GITHUB_REPOSITORY>/releases/download/`.
  - `BINARY_SOURCE=local` → off.
  - `BINARY_EDITION=hosted` → off.
- `off`.
- An explicit `https://github.com/<owner>/<repo>` or, self-host only, an `https://` mirror base with no userinfo, query or fragment.
- **Production validation:** `BINARY_EDITION=hosted` with a value that resolves to the official public repo is a boot error, because that repo is the self-host edition.

This is deployment config, not a product setting, so the settings rules (`docs/agents/settings.md`) do not apply. No UI.

### 3.9 Telemetry: which source won, and how the server learns it

- Scripts export `BREEZE_INSTALL_PATH` ∈ {`control_plane`, `artifact_fallback`, `agent_redeem_fallback`}.
  - `artifact_fallback` means the binary came from the fallback source.
  - `agent_redeem_fallback` means the macOS app handed redemption to the agent. Its artifacts were bundled and nothing was downloaded.
- `enroll` and `bootstrap` read the variable and send an additive optional `installPath` enum on the enroll body. `enrollSchema` in `apps/api/src/routes/agents/schemas.ts` is a non-strict `z.object`, so an older API strips the key.
- The value is client-claimed, so it is advisory only. The API parses it leniently: unknown values become `unknown`, and it never rejects an enroll. The API records it in the existing `agent.enroll` audit details and in a Prometheus counter `breeze_agent_enroll_install_path_total{path}`. Absent is counted as `unknown`.
- The counter only counts **successful** enrollments. A fallback that fails before enrollment leaves no server trace by construction. The scripts print the full diagnosis locally, and the release notes say so.
- **No new table or column.**

### 3.10 Boundary with #8868 and #8870

| Concern | Owner |
|---|---|
| Base-exception message plus the web-filter hint in the Windows one-liner's `catch` | #8868 W2 (it owns `installCommands.ts` first; this spec's Windows wave rebases on it) |
| `filterSignatureHint` in `enroll` and the `controlPlaneBlock` heartbeat object | #8868 / #8869 (shipped or planned). This spec only surfaces the agent's output. |
| Second domain, `hostpolicy` allowlist entry, `backup_server_url` push, failover treating blocked like down, DNS-TXT alternate-host discovery | #8870 |
| Enrollment artifacts carrying both hosts (MSI/pkg filename tokens, one-liner `--server` list, bootstrap tokens) | #8870. This spec's fallback order (§3.1) reserves slot 2. When both ship, the one-liner tries primary → alternate → artifact source, and `enroll` gets both hosts from #8870's interface. |
| Artifact source, anchor, trigger classification, `install.sh` fallback mode, macOS app agent-redeem path, install-path telemetry | **This spec** |

Composition test, required once both exist: block the primary by SNI and leave the #8870 alternate reachable. The one-liner must use the alternate, not the artifact source.

## 4. Tenancy and data model impact

- **No new table, no migration, no new column.** The anchor is computed per request from already-verified release data. The install path goes into existing audit details and a metric.
- **No new route.** `POST /devices/onboarding-token` keeps `requireScope('organization', 'partner', 'system')`, `requirePermission(ORGS_WRITE)`, `requireMfa()` and `requireCapability('installer_distribute')`. The additive response field carries no tenant data, so the RLS, cascade, export-policy and `mcp-coverage.test.ts` registrations are untouched.
- If the plan instead adds a separate anchor route, it needs `requireScope`, an `mcp-coverage.test.ts` entry and partner-read gating per CLAUDE.md. The recommendation is not to add one: the anchor belongs with the token it serves.
- **No new job.** If Open Decision 5 picks the API parity check, it adds a worker and needs a `workerReadinessManifest.ts` entry.
- **Web:** no new mutation (`onboarding-token` is the existing call). Any new UI string, such as a "includes a fallback download source" hint, goes in all 8 locales (`apps/web/src/lib/i18n/localeParity.test.ts`) with a `data-testid`. The one-liner's own messages stay English, as today.

## 5. Out of scope

- Making the MSI or pkg double-click paths fall back. They already carry the binary and enroll over ECH.
- A pending-enrollment daemon (§3.6).
- Client-side Ed25519 verification and a bootstrap verifier binary (§3.2).
- Anything #8870 owns (§3.10), including registering the domain.
- Building or operating the hosted distribution repository and its private publication pipeline. This spec states the **contract** (§6.2). The pipeline lives outside this repo and is the owner's task.
- ECH for the installer TLS stacks themselves.
- Reporting failed fallback attempts to the server.
- `support`/viewer/helper installers.

## 6. Open Decisions

Each has a recommendation. An independent second-model review agreed with the architecture, and its amendments are folded into §3. On Decisions 3 and 5 the two positions differed, so both are given.

1. **Hosted-edition artifact source.**
   (a) A new **public distribution repository** whose releases carry only the hosted pipeline's signed artifacts, the hosted signed manifest and `install.sh`, published by the private pipeline. The bytes are already downloadable without authentication from the hosted download routes, so publishing them discloses nothing new.
   (b) A public-read object-storage bucket on a shared cloud domain: under our control, but bucket names travel in SNI and shared storage hosts are often filtered.
   (c) No hosted fallback: hosted keeps the MSI/pkg workaround plus #8870.
   **Recommend (a).** It is the only option with GitHub's blocking profile that serves the right edition. It needs one owner action: create the repository and grant the private pipeline publish rights. **Gate:** hosted `INSTALLER_FALLBACK_SOURCE` stays `off` until the first hosted release exists there and the §7 lab passes.

2. **Self-host default.** (a) `auto` turns the fallback on in github mode with `BINARY_GITHUB_REPOSITORY`, the same bytes the 302 already serves. (b) Off unless configured. A "default on for hosted only" reading does not survive §1.2, because hosted cannot use the public repo.
   **Recommend (a).** It costs nothing unless the control plane is unreachable, and a private fork fails closed with a clear message.

3. **Anchor lifetime.**
   - Position A: no expiry, relying on exact-hash pinning plus the heartbeat upgrade.
   - Position B: bound it, because revocation only affects future anchors, Linux reinstalls overwrite binaries, and upgrades are policy-gated. All three were verified in code.
   - Options: (a) `validUntil = min(token expiry, mint + 30 days)`; (b) `validUntil = token expiry`; (c) none.
   **Recommend (a)** plus the installed-version floor (§3.2). Long-lived RMM-pasted commands keep the primary path. They lose only the fallback after 30 days, and re-copying a command re-arms it.

4. **Anchor encoding.** (a) Per-asset hashes embedded, as in §3.2: no parsing, and it works for any mirror, but the Unix command is about 500 characters longer. (b) The hash of the signed manifest, with `install.sh` parsing JSON in bash: fragile, and the hosted manifest generator lives elsewhere. (c) The hash of `checksums.txt`: short and parse-free, but it is not signed, is excluded from the manifest, and its presence in the local or hosted volume is unproven.
   **Recommend (a).** The plan adds a length-budget test (Decision 7).

5. **Mirror parity check.** Who proves the artifact source holds the anchor's bytes?
   - Position A: (a) the publishing pipeline asserts parity at publish time; the API never fetches from the mirror; a client that sees a mismatch fails closed ("checksum mismatch from the fallback source").
   - Position B: (b) the API verifies the distribution release itself through a **narrow distribution verifier** bound to repository, release, edition and platform trust. That needs a scoped exception to `assertGithubFetchableEdition`, plus a background job.
   **Recommend (a) for v1, with an ordering contract.**
   - A release's artifacts must be on the artifact source **before** it becomes the deployment's `isLatest` row.
   - For hosted, the API issues an anchor only for a release the operator has declared mirrored. That could be a minimum mirrored release in config, or a field the hosted manifest carries; the plan picks.
   - Both are W-hosted exit criteria.

   Option (a) keeps the "no hosted asset from a public release" guard intact for every serving and ingesting path, and adds no worker. Option (b) becomes a follow-up if the lab or the field shows drift.

6. **macOS app on an unreachable control plane.** (a) Consent, then agent-side redemption (§3.5). (b) A better error only.
   **Recommend (a).** The Go path already exists and is ECH- and hostpolicy-aware. The cost is the missing org-name confirmation, which the consent copy states.

7. **Command length.**
   - Today's Windows one-liner measures about 2,950 characters, or about 7,870 as UTF-16 Base64 for `-EncodedCommand`, close to CMD's 8,191 limit. The fallback adds roughly 600 to 900.
   - Options: (a) a unit test asserting a budget for both forms, plus documenting that wrappers needing `-EncodedCommand` should use a script file; (b) add a "download as .ps1/.sh" button in this feature (browser downloads get MOTW and execution-policy friction).
   **Recommend (a)** now and (b) as a follow-up only if the budget cannot be met.

## 7. Test and rollout notes

### 7.1 Tests (minimum)

- **API:**
  - The `installFallback` builder returns `null` for: source off; unverifiable manifest; a missing or duplicate consumed asset; an edition mismatch; a `signing-input` asset; a server-only release without resolvable `binariesRelease`.
  - The hosted + official-repo combination is a boot error.
  - The anchor version equals the `agent-versions/latest` row.
  - `validUntil` ≤ the token's expiry.
  - The served `install.sh` is byte-equal to the checked-in file.
  - `installPath` is accepted, stripped when unknown and counted.
- **Web:** `installCommands.test.ts` covers:
  - Byte-identical output when `installFallback` is null.
  - The embedded values are escaped for PowerShell and bash. Hashes and tags are validated by regex before interpolation, and nothing token-derived lands outside its quotes.
  - The length budget (Decision 7).
- **Scripts:** bash tests extend the real-bash harness in `apps/api/src/routes/agents/download.test.ts` (`install.sh functional pre-flight behavior`, which runs the script with `execFileSync('bash', …)`). PowerShell coverage in `apps/web/src/lib/installCommands.test.ts` is string-assertion only; the lab (§7.2) is the only execution test for PowerShell.
  - A transport failure triggers the fallback; HTTP 4xx/5xx, HTML 200, certificate failure and proxy 407 do not.
  - An expired anchor gives no fallback.
  - **Tampered artifact** (one byte flipped at the fallback source) → refuse, and nothing is installed or replaced.
  - A tampered `install.sh` at the fallback source is refused before execution.
  - The installed-version floor keeps a newer binary.
  - A pkg with the wrong team ID → refuse.
- **Swift** (`agent/installer/macos-app/Tests/BreezeInstallerTests`, beside `BootstrapClientSecurityTests.swift`): classification table for every URLSession error in §3.4, including a nested certificate error, a timeout after send and redirect history.
- **Agent:** `installPath` passes from env into the enroll body for `enroll` and `bootstrap`. Any new `bootstrap` flags get the same `hostpolicy` gating tests as `--install-data`.

### 7.2 Lab recipe (owner-run; never on a host with an installed production agent)

The issue's recipe (a DNS sinkhole to a local listener) cannot also prove "enroll via ECH against the real edge": the sinkhole would capture the ECH dial too. Use an **SNI-selective** middlebox instead, the way the real filter behaves:
1. A lab host whose hosts file points the control-plane name at a TCP proxy.
2. The proxy peeks the ClientHello SNI. For example, an nginx `stream` block with `ssl_preread` maps `$ssl_preread_server_name`:
   - the control-plane name goes to a local responder that writes `HTTP/1.1 302 Found\r\nLocation: http://blocked.example/\r\n\r\n` (the scenario-1 listener of `docs/superpowers/plans/2026-10-16-agent-ech-lab.md`);
   - every other SNI, including the ECH cover name, is passed through to the real edge address.
3. GitHub stays reachable.

Expected results:
- Each one-liner falls back, verifies, installs, and `enroll` succeeds over ECH. The device reports `installPath: artifact_fallback`.
- The macOS app reaches the consent step and the agent redeems the token.

Negative runs:
- A tampered asset served from a local mirror (self-host config) → refuse.
- Proxy 407 → no fallback.
- An untrusted-certificate interceptor → no fallback.
- An expired anchor → no fallback.
- Re-running against a host with a newer agent → the binary is kept.

Run these environments:
- a SYSTEM-context Windows runner (PsExec `-s` or an RMM runner);
- Windows PowerShell 5.1 on Server 2016;
- **a non-English Windows locale** behind an untrusted-certificate interceptor. It must not fall back.

Capture the fallback host's requests and assert that none carries the token, the secret or an `Authorization` header.

### 7.3 Waves (sketch only; the plan decides)

| Wave | Content | Blast radius |
|---|---|---|
| W1 release + static script | Checked-in `install.sh` served byte-identical, attached in `release.yml` and listed in the manifest. No behavior change. | **High:** release workflow and signed-manifest inputs; `release-integrity-gate` must not regress |
| W2 API anchor + config + telemetry intake | `installFallback` on `onboarding-token`, `INSTALLER_FALLBACK_SOURCE`, the hosted validation, `installPath` intake and counter. Ships with `auto` effective only for self-host github mode. | Medium |
| W3 agent | `installPath` from env in `enroll`/`bootstrap`, and optional `bootstrap --token/--server` | **High** (agent-shipped; promote only after the lab) |
| W4 Windows one-liner | §3.5. **Blocked on #8868 W2** (same file, same `catch`), and needs W2 | Medium (customer machines, but no binary change) |
| W5 Unix one-liner + `install.sh` fallback mode | §3.3–3.5 | Medium–high (root installer) |
| W6 macOS app | Classification, consent, agent-redeem path. App release and notarization. Needs W3 if W3 adds `bootstrap` flags. | **High** (shipped, notarized) |
| W-hosted (owner, outside this repo) | Distribution repo and publication contract (Decision 1); then flip hosted `INSTALLER_FALLBACK_SOURCE` | **High** (signing/release) |

Ordering:
- W1 → W5: the fallback needs `install.sh` on a release.
- W2 → W4 and W5.
- #8868 W2 → W4.
- W3 → W6, if W3 adds flags.
- W-hosted → hosted enablement.

Outside those, each wave ships dark: a `null` anchor means today's behavior.

### 7.4 Rollout

- Self-host gets the fallback automatically once W2 and W4/W5 ship.
- Hosted stays `off` until W-hosted and the lab pass.
- Release notes state:
  - the fallback exists and which source it uses;
  - that it pins the release current when the command was copied;
  - the 30-day re-copy rule (if Decision 3a is chosen);
  - that a failed fallback leaves no server-side trace.
- The rollback is `INSTALLER_FALLBACK_SOURCE=off`. New anchors become `null` immediately. Commands already copied keep their embedded anchor until `validUntil`, which is a further reason to keep it short.

### 7.5 Binding contracts carried into the plan

- Partner-Wide First does not apply: there is no config or policy table.
- If a later wave adds a table after all: RLS enabled and forced in the same migration, the `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` allowlist, `CORE_ORG_CASCADE_DELETE_ORDER` (`apps/api/src/services/tenantCascade.ts`), `CORE_TENANT_EXPORT_POLICY` (`apps/api/src/services/tenantExportPolicyRegistry.ts`) and the device lists if it has `device_id`.
- New routes: `requireScope`, partner-read gating and an `mcp-coverage.test.ts` entry.
- New jobs: `workerReadinessManifest.ts`.
- Web mutations: `runAction`. Strings: all 8 locales. New UI: `data-testid`.
- Public repo: no customer names, hostnames or IPs in code, tests, fixtures or PR text. Fixtures use `*.example` and `*.invalid`.
