# NU Known Issues

Hard-won debugging knowledge for the Nodes Unlimited (NU) fork/deployment of Breeze.
Each entry: Symptom → Root cause → Fix → Prevention. See also
[operations.md](operations.md), [msi.md](msi.md), [branding.md](branding.md).

## Apple Silicon M5 agent crash

- **Symptom:** macOS pkg installs cleanly, but the agent dies instantly and never
  enrolls. `/Library/Logs/Breeze/agent.err` shows a segfault during Go package init.
- **Root cause:** the stock agent binary is built with cgo. Transitive dependency
  `github.com/shoenig/go-m1cpu` reads Apple CPU registers via IOKit at package init
  and does not know the M5, segfaulting before `main` runs.
- **Fix:** build with `CGO_ENABLED=0`. Now forced in `agent/Makefile`:
  - line 33: `export CGO_ENABLED := 0` (global)
  - lines 297, 349, 392: per-target `CGO_FLAG` re-forces `CGO_ENABLED=0` on
    cross-compiles.
- **Prevention:** never build the agent with cgo. `agent/installer/release/stage-release.sh`
  builds the whole release set CGO-off (see [operations.md](operations.md)).

## PowerShell BOM bug (Windows PowerShell 5.1)

- **Symptom:** a .ps1 script fails with a ParseException such as
  "Array index expression is missing or not valid" pointing at a plainly valid line
  ~20 lines BELOW the real cause; stdout AND stderr are both empty. Looks like a
  broken script or blocked ExecutionPolicy; it is neither. Observed live 2026-08-13
  on three NU Windows scripts.
- **Root cause:** Windows PowerShell 5.1 decodes a BOM-less .ps1 as CP1252, not
  UTF-8. An em dash (U+2014, UTF-8 bytes `E2 80 94`) decodes to `â€"` — and the
  final byte `0x94` is a CP1252 RIGHT DOUBLE QUOTATION MARK. That injected quote
  breaks string pairing, so every subsequent string literal in the file parses
  shifted by one.
- **Fix:** the executor prepends a UTF-8 BOM (`EF BB BF`) to .ps1 payloads only —
  `agent/internal/executor/shell.go` (~line 147, extension check
  `strings.EqualFold(ext, ".ps1")`). Scoped to .ps1 because a BOM on a `#!` script
  would break the shebang. PowerShell 7+/pwsh and non-Windows shells default to
  UTF-8 and tolerate the BOM. Regression coverage:
  `agent/internal/executor/shell_bom_test.go`.
- **Diagnostic that cracked it:** fetch the stored script via the API and scan for
  characters > 127.
- **Prevention:** BOM injection is in the executor; do not remove it, and do not
  extend it beyond .ps1.

## Semver prerelease version trap

- **Symptom:** device stuck "updating" forever; the server re-ordered an "upgrade"
  every 60 s.
- **Root cause:** `0.104.0-nu1` sorts BELOW `0.104.0` (semver prerelease
  precedence), so an agent reporting `0.104.0-nu1` is forever "behind" a server
  serving `0.104.0`.
- **Fix / rule:** the agent version must EXACTLY equal what the control plane
  serves — the `VERSION` file at the binaries volume root. Server IMAGES may use
  `-nu.N` tag suffixes (`nu-v*` namespace, see [operations.md](operations.md));
  agent ARTIFACTS may NOT drift from the `VERSION` file.
- **Prevention:** `stage-release.sh` stamps the same `VERSION` into binaries and
  manifest; never bump the volume `VERSION` file without staging matching signed
  binaries first.

## macOS PKCS#12 import failure

- **Symptom:** `security import` of a .p12 fails with
  "MAC verification failed during PKCS12 import (wrong password?)" even with the
  correct password.
- **Root cause:** modern OpenSSL defaults (AES-256-CBC + SHA-2) produce PKCS#12
  files the macOS Security framework cannot read. The error blames the password;
  the algorithm is the problem.
- **Fix:** export with legacy algorithms AND a non-empty password:
  `-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1`
  (see `agent/installer/macos/create-signing-identity.sh`, ~lines 56-70 — an
  empty-password .p12 fails `security import` with the same misleading error).
- **Prevention:** use the script; never hand-roll the openssl export.

## Stable code-signing identity vs TCC

- **Symptom:** after a self-update, Full Disk Access / Accessibility /
  Screen Recording silently stop working.
- **Root cause:** macOS TCC ties those grants to the code-signing identity.
  Ad-hoc signing re-randomises the identity per build, so every self-update drops
  the permissions.
- **Fix:** one self-signed "NU Agent Signing" identity used for EVERY build
  (created by `agent/installer/macos/create-signing-identity.sh`).
- **Prevention:** the .p12 lives in `~/.nu-agent-signing/` (0700) and is
  UNRECOVERABLE if lost — losing it means every fleet Mac re-prompts for TCC
  grants. Back it up off-machine. This is a standing operator duty
  ([operations.md](operations.md)).

## AppleDouble `._` files in pkgs

- **Symptom:** built pkg payloads contain `._name` siblings that install into
  `/usr/local/bin`.
- **Root cause:** `com.apple.provenance` xattr (macOS 14+), which `pkgbuild`
  materialises as AppleDouble files. The xattr is PROTECTED — `xattr -c` cannot
  remove it and macOS re-adds it.
- **Fix:** none. strip-before-sign, strip-after-sign, and `COPYFILE_DISABLE=1`
  were all tried 2026-08-13 and all fail (see comments in
  `agent/installer/macos/build-pkg.sh`, ~lines 65-93).
- **Prevention:** the files are inert. Do NOT burn time re-fixing this.

## Cleartext S3 blocks agent self-update

- **Symptom:** every agent self-update download fails with
  `policyReason=cleartext_not_allowed`.
- **Root cause:** `S3_ENDPOINT` is `http://<ip>:3900` (Garage); the agent's
  network policy refuses cleartext.
- **Fix (planned):** give Garage an HTTPS front — an `s3` subdomain via
  Caddy/Traefik.
- **Prevention / warning:** do NOT just unset the `S3_*` envs — softwareUploads
  and backups also use them.

## Upstream local-mode manifest bug (BINARY_SOURCE=local)

- **Symptom:** every `download-info` request 409s; no agent can download binaries.
- **Root cause:** with `BINARY_SOURCE=local`, `validateReleaseManifest`
  (`apps/api/src/routes/agentVersions.ts`) derives the asset name from the LAST
  path segment of `downloadUrl` — which for local URLs is the arch, never an
  asset name, so validation always fails.
- **Workaround (current prod):** stage a signed manifest covering ZERO assets at
  the binaries volume root, so binaries register via per-deployment re-signing
  instead (see `agent/installer/release/stage-release.sh` header for the trust
  chain).
- **Fix:** fix it properly in code — the images are ours now.

## RustDesk provider persistence bug

- **Symptom:** `PATCH /orgs/partners/me` with `remoteAccessProviders` returns 200
  but the field never persists; nesting it inside `settings` gets schema-stripped.
- **Root cause:** `apps/api/src/routes/orgs.ts` — the update schema validates
  TOP-LEVEL `remoteAccessProviders` (line 633), but the PATCH handler (route
  registered at line 771, `/partners/me`) only persists a merged
  `body.settings`; `body.remoteAccessProviders` is silently dropped. The
  launcher resolver (`apps/api/src/services/remoteAccessProviders.ts`) reads
  ONLY the `remoteAccessProviders` key inside the encrypted `partners.settings`
  blob.
- **Workaround (current prod):** the live value was written via direct DB update.
- **Fix:** fix properly in code — persist the validated top-level field into
  `settings.remoteAccessProviders` in the handler (mind
  `encryptColumnValueForWrite('partners','settings', …)` — providers carry
  passwords).

## Coolify landmines

Four independent traps, all hit in production:

1. **Service envs are Laravel encrypted casts.** Write them via the Coolify REST
   API only — a raw DB write stores an undecryptable value.
2. **`LocalFileVolume.content` NULL → Deploy writes an EMPTY file.** This downed
   the site once (empty Caddyfile). Always confirm the content column is
   populated before deploying.
3. **A bare `coolify:` network key (null value) is silently dropped** by
   Coolify's compose parser. Use the dict form (`coolify: {}` or explicit
   attributes).
4. **`TRUSTED_PROXY_CIDRS` must be exact /32 host entries.** The API's validator
   refuses broad private ranges and the container crash-loops. Corollary: the
   gateway container needs STATIC IPs on BOTH networks — otherwise its IP
   changes on recreate, agent auth 401s, and cert-assertion headers from the
   now-untrusted peer are discarded.

## VirtualBox clock skew

- **Symptom:** Windows crash-event timestamps look impossible and mislead
  diagnosis.
- **Root cause:** the test VM's clock ran 8 hours ahead; events were correlated
  against the wrong timeline.
- **Prevention:** when Windows event times look impossible, check the VM clock
  FIRST, before trusting any timestamp correlation.
