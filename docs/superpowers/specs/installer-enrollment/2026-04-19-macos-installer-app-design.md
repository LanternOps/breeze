# macOS GUI Installer App — Design Spec

- **Created:** 2026-04-19
- **Status:** Proposed, not yet implemented
- **Related:** `buildMacosInstallerZip` in `apps/api/src/services/installerBuilder.ts`, `agent/installer/macos/`, Windows `MsiSigningService` at `apps/api/src/services/msiSigning.ts`

## Problem

Downloading a macOS installer from the web UI today produces a zip containing two unsigned `.pkg` files, `enrollment.json`, and `install.sh`. The admin has to unzip, open Terminal, and run `sudo bash install.sh`. This is fine for technical users but wildly off-brand compared to the Windows MSI experience (double-click, click through, done). Non-technical end-users bounce off it.

**Goal:** ship a macOS installer that feels exactly like the MSI flow — one file, double-click, native admin-password prompt, GUI progress, done.

## Why the naive approach (server-side inject + sign + notarize per install) is too expensive

MSI is an OLE2 compound file — the API can byte-patch space-padded sentinels in place and re-sign with `signtool` in ~3s. PKG is a xar archive whose TOC checksums the contents, so any modification invalidates the signature. Per-customer injection requires the full pipeline: `xar -xf` → edit → `xar -cf` → `productsign` → `xcrun notarytool submit --wait` → `xcrun stapler staple`. The `notarytool` call is a **30–180s round-trip to Apple** that can't be avoided if users browser-download the file. It also needs a macOS signing host, not just a Linux VM.

For a UX improvement over a working-but-awkward flow, that infrastructure isn't worth it. The existing Windows MSI signing pipeline already teaches this lesson: it works, but the signing VM + Cloudflare Access tunnel + Azure Trusted Signing account + rotating cert + byte-patch sentinel code is a heavy stack for the value delivered. See the appendix for why we're not mirroring that stack on the Mac side.

## Design — Static notarized `.app`, per-customer token encoded in filename

Ship a tiny `Breeze Installer.app`, signed + notarized **once per release in CI**, identical across all customers. Per-customer data (one short token) is encoded in the bundle's filename. The code signature and stapled notarization ticket are based on the content of `Contents/` — renaming the bundle's enclosing folder has no effect on either. The app reads its own bundle path on launch, extracts the token, calls a bootstrap endpoint, prompts for admin password, installs the embedded PKG, runs `breeze-agent enroll`.

### User-facing flow

1. Admin clicks "Download macOS Installer" in the web UI.
2. Browser downloads `Breeze Installer [A7K2XQ@us.2breeze.app].app.zip` (~55 MB — the app bundle embeds both arm64 and amd64 PKGs in its `Resources/`).
3. Safari auto-extracts on download; Chrome requires a double-click. Either way the admin ends up with `Breeze Installer [A7K2XQ@us.2breeze.app].app` in `~/Downloads`.
4. Double-click the app. Gatekeeper verifies the stapled notarization ticket — no "unidentified developer" warning.
5. App reads its own bundle URL, regex-extracts token + API host from the filename.
6. App fetches `GET https://us.2breeze.app/api/v1/installer/bootstrap/A7K2XQ` → returns `{ serverUrl, enrollmentKey, enrollmentSecret?, siteId?, orgName }`.
7. App shows a one-window UI: "Install Breeze Agent for *Acme Corp*?" with an Install button.
8. User clicks Install → native macOS admin password dialog (via AppleScript `do shell script … with administrator privileges`).
9. App picks the right PKG for the host CPU (`uname -m`), runs `installer -pkg <path> -target /` as root with progress spinner.
10. App runs `/usr/local/bin/breeze-agent enroll <key> --server <url> [--enrollment-secret <secret>] [--site-id <id>]`.
11. Success screen → Quit.

### Why filename-token works

A `.app` bundle's code signature is based on hashes of every file under `Contents/`, recorded in `Contents/_CodeSignature/CodeResources`. The bundle's own name and path are **not** inputs to that hash. Renaming the bundle from `Breeze Installer.app` to `Breeze Installer [A7K2XQ@us.2breeze.app].app` leaves signature verification and stapled-ticket verification both passing. Gatekeeper on launch runs `codesign --verify` and `spctl -a` — both succeed regardless of the enclosing directory name.

Confirm with: `codesign -v -v "Breeze Installer [A7K2XQ@us.2breeze.app].app"` after rename.

### Single-file distribution — no sidecar, no DMG

Everything needed to install lives inside the `.app`:

```
Breeze Installer [A7K2XQ@us.2breeze.app].app/
└── Contents/
    ├── Info.plist
    ├── MacOS/
    │   └── Breeze Installer          ← the Swift executable
    ├── Resources/
    │   ├── breeze-agent-arm64.pkg    ← embedded, signed, ~26 MB
    │   ├── breeze-agent-amd64.pkg    ← embedded, signed, ~26 MB
    │   ├── AppIcon.icns
    │   └── en.lproj/                 ← UI strings
    └── _CodeSignature/
        └── CodeResources             ← hashes of everything above
```

Both PKGs live inside the signed app bundle and are notarized together with the app. The app bundle is one atomic unit — if notarization passes, every contained artifact is trusted. No sibling files, no DMG, no re-notarization per customer.

Shipped wrapper: a single `.zip` containing the renamed `.app`. No README, no instructions file. The filename itself is the only per-customer payload.

## Components

### 1. Swift installer app — `agent/installer/macos-app/`

**Language:** Swift + SwiftUI
**Target:** macOS 11.0+ (matches agent minimum)
**Bundle ID:** `com.breeze.installer`
**Xcode project:** checked in, configured for Developer ID Application signing

**Filename parsing (app startup, first code to run):**

```swift
// Bundle.main.bundleURL is the full path to the .app itself.
// lastPathComponent strips to "Breeze Installer [A7K2XQ@us.2breeze.app].app"
let bundleName = Bundle.main.bundleURL.lastPathComponent

// Regex: [<token>@<host>] — token is [A-Z0-9]{6}, host is any non-] chars
let pattern = #"\[([A-Z0-9]{6})@([^\]]+)\]"#
guard let match = bundleName.firstMatch(of: try! Regex(pattern)) else {
  // User renamed the bundle and stripped the token bracket.
  showError("This installer needs its original filename. Please re-download from your Breeze web console.")
  return
}
let token = String(match.1)
let apiHost = String(match.2)

// Construct bootstrap URL. apiHost is always a valid hostname because it
// was written by our server; validate shape defensively anyway.
guard let bootstrapURL = URL(string: "https://\(apiHost)/api/v1/installer/bootstrap/\(token)") else {
  showError("Installer filename is malformed. Please re-download.")
  return
}
```

**State machine:**

```
Launch → Parse filename → Fetch bootstrap → Confirm → Install → Enroll → Done
                                                              ↘ Error
```

Each transition displays a SwiftUI view. Errors are recoverable where possible ("Retry" button for network errors) and terminal where not ("Please re-download" for bad filenames).

**Admin-privilege install:** use AppleScript, which is the officially-supported way to trigger the native admin-password dialog for a one-shot command:

```swift
let script = """
do shell script "'/usr/sbin/installer' -pkg '\(pkgPath)' -target / && \
'/usr/local/bin/breeze-agent' enroll '\(token)' --server '\(serverUrl)' \
--enrollment-secret '\(secret)' --site-id '\(siteId)' --quiet" \
with administrator privileges
"""
var error: NSDictionary?
NSAppleScript(source: script)?.executeAndReturnError(&error)
```

Shell-escape the values (they come from server response — still, belt and suspenders). `NSAppleScript` with `administrator privileges` shows the familiar "Breeze Installer wants to make changes" dialog with Touch ID / password field. No SMJobBless helper tool needed for this scope.

**Architecture detection:** `Process` launching `/usr/bin/uname -m`, read stdout, match `"arm64"` → `breeze-agent-arm64.pkg`, `"x86_64"` → `breeze-agent-amd64.pkg`. Same logic as today's `install.sh`, ported to Swift.

**Progress display:** v1 ships with an indeterminate spinner and a "this takes about 10 seconds" label. Parsing `installer` stderr for percentage is a v2 nicety.

**What happens if enrollment fails (network error, expired token after install):** PKG is installed, agent binary is on disk, but `breeze-agent enroll` returned non-zero. Show an actionable error: "Agent installed but enrollment failed: *<reason>*. Re-run the installer to retry, or enroll manually via the web console." Do **not** attempt automatic cleanup — the agent binary can be safely left installed; re-running the app re-enrolls.

### 2. API — bootstrap token endpoint

**New table:** `installer_bootstrap_tokens`

```sql
CREATE TABLE installer_bootstrap_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token TEXT NOT NULL UNIQUE,              -- stored lowercase, 6-char base36
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  parent_enrollment_key_id UUID NOT NULL REFERENCES enrollment_keys(id) ON DELETE CASCADE,
  site_id UUID REFERENCES sites(id),
  max_usage INTEGER NOT NULL DEFAULT 1,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_from_ip TEXT
);

CREATE INDEX idx_installer_bootstrap_tokens_expires
  ON installer_bootstrap_tokens(expires_at)
  WHERE consumed_at IS NULL;
```

**RLS:** Shape 1 (direct `org_id`) — auto-discovered by the RLS contract test. Standard `breeze_has_org_access(org_id)` policy. Bootstrap consumption path uses `withSystemDbAccessContext` since the token IS the auth and there's no user session; admin-facing read paths use the request context as usual.

**Token entropy:** 6 chars of `[A-Z0-9]` (base36) = 36⁶ ≈ 2.2 billion values. Single-use + 24h TTL + RLS-isolated lookup means brute-force is not a realistic threat (issuing 1000 guesses/sec would take 25 days per token, and expired tokens 404 identically to invalid ones). If we want to be paranoid, bump to 8 chars (2.8 trillion) — cost is two extra characters in the filename.

**Store raw, not hashed:** unlike enrollment keys (which are long-lived secrets used by agents), bootstrap tokens are single-use, 24h-TTL, and only exist in the DB long enough to be consumed. Hashing adds ceremony without a meaningful security win. Store `token` as plain text and compare by equality.

**Route change — `GET /:id/installer/:platform` in `apps/api/src/routes/enrollmentKeys.ts`:**

When `platform === 'macos'`:

1. Validate parent key as today (TTL, usage, access).
2. Generate a 6-char base36 token.
3. **Do NOT create a child enrollment key here.** The child is created lazily inside the bootstrap route on first token consumption. Eliminates orphan child keys from "admin downloaded installer but never ran it".
4. Insert `installer_bootstrap_tokens` row with 24h expiry, parent key ID, site ID, desired `maxUsage`.
5. Fetch cached `Breeze Installer.app.zip` from GitHub release (new helper `fetchMacosInstallerAppZip`, same pattern as `fetchMacosPkg`).
6. Rewrite the zip so the inner `.app` directory is renamed from `Breeze Installer.app` to `Breeze Installer [<TOKEN>@<apiHost>].app`. See implementation note below.
7. Return the zip with `Content-Disposition: attachment; filename="Breeze Installer [<TOKEN>@<apiHost>].app.zip"`.

**Implementation note — renaming entries inside a ZIP:** `node-stream-zip` or `adm-zip` can read entry-by-entry and write a new zip with rewritten paths. No decompression needed for store-compressed entries, but deflated entries must be re-copied. `archiver` handles the write side cleanly. Pseudo:

```ts
import StreamZip from 'node-stream-zip';
import archiver from 'archiver';

export async function renameAppInZip(
  sourceZip: Buffer,
  oldAppName: string,  // "Breeze Installer.app"
  newAppName: string,  // "Breeze Installer [A7K2XQ@us.2breeze.app].app"
): Promise<Buffer> {
  const zip = new StreamZip.async({ file: <tmp-from-buffer> });
  const out = archiver('zip', { zlib: { level: 0 } }); // store-only; app is already compressed internally
  const chunks: Buffer[] = [];
  out.on('data', c => chunks.push(c));

  for (const entry of Object.values(await zip.entries())) {
    const rewrittenPath = entry.name.replace(oldAppName, newAppName);
    const data = await zip.entryData(entry.name);
    out.append(data, { name: rewrittenPath, mode: entry.attr });
  }
  await out.finalize();
  await zip.close();
  return Buffer.concat(chunks);
}
```

Rewriting ZIP entry paths does NOT touch the files inside `Contents/` — signature remains valid.

**New public route:** `GET /api/v1/installer/bootstrap/:token` — no auth (token IS the auth), no tenant context (resolved from token row), no rate limit for v1 (add a global 1000/min if abuse appears).

```ts
installerRoutes.get('/bootstrap/:token', async (c) => {
  const token = c.req.param('token')?.toUpperCase() ?? '';
  if (!/^[A-Z0-9]{6}$/.test(token)) {
    return c.json({ error: 'invalid token' }, 400);
  }

  // Atomically consume the token + create the child enrollment key.
  // Concurrent callers can't both succeed — PG row lock on the update serializes them.
  const result = await withSystemDbAccessContext(async (tx) => {
    const [row] = await tx.select().from(installerBootstrapTokens)
      .where(eq(installerBootstrapTokens.token, token))
      .limit(1);
    if (!row) return null;
    if (row.consumedAt) return null;
    if (new Date(row.expiresAt) < new Date()) return null;

    // Mark consumed
    const [updated] = await tx.update(installerBootstrapTokens)
      .set({
        consumedAt: new Date(),
        consumedFromIp: c.req.header('cf-connecting-ip') ?? null,
      })
      .where(and(
        eq(installerBootstrapTokens.id, row.id),
        isNull(installerBootstrapTokens.consumedAt),  // idempotency guard
      ))
      .returning();
    if (!updated) return null;  // lost race to a concurrent request

    // Lazily create the child enrollment key now, with a fresh TTL
    const [parentKey] = await tx.select().from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, row.parentEnrollmentKeyId)).limit(1);
    if (!parentKey) return null;  // parent deleted between issue and consume

    const rawChildKey = generateEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);
    const [child] = await tx.insert(enrollmentKeys).values({
      orgId: row.orgId,
      siteId: row.siteId,
      name: `${parentKey.name} (mac-installer ${token})`,
      key: childKeyHash,
      keySecretHash: parentKey.keySecretHash,
      maxUsage: row.maxUsage,
      expiresAt: freshChildExpiresAt(),
      createdBy: row.createdBy,
      installerPlatform: 'macos',
    }).returning();

    const [org] = await tx.select().from(organizations)
      .where(eq(organizations.id, row.orgId)).limit(1);

    return { rawChildKey, siteId: row.siteId, orgName: org?.name ?? 'your organization' };
  });

  if (!result) {
    return c.json({ error: 'token invalid, expired, or already used' }, 404);
  }

  return c.json({
    serverUrl: process.env.PUBLIC_API_URL,
    enrollmentKey: result.rawChildKey,
    enrollmentSecret: process.env.AGENT_ENROLLMENT_SECRET || null,
    siteId: result.siteId,
    orgName: result.orgName,
  });
});
```

**Security properties:**

- Single-use: transaction updates `consumed_at` with an `IS NULL` guard; concurrent consumption returns 404 from the losing side.
- 24h TTL enforced in SQL.
- No information leak: invalid / expired / already-used tokens all return `404 {error: "token invalid, expired, or already used"}`.
- Parent key deletion between token issue and consume: returns 404 (parent FK `ON DELETE CASCADE` removes the token row automatically, but belt-and-braces check inside the tx too).
- No user auth needed: the token's entropy + single-use + short TTL is the security model. Same pattern as password-reset links.

### 3. Web UI — no change required

The existing "Download macOS Installer" button POSTs to `GET /:id/installer/macos` and saves the returned blob. The response's `Content-Type` shifts from `application/zip` (unchanged) but its filename and contents change. Browser handles the blob as an opaque download. Zero UI code changes.

One small polish: on the macOS download success toast, show a one-liner: *"If your download doesn't auto-extract, double-click the zip to unzip first, then double-click Breeze Installer."* — covers Chrome users who don't auto-extract.

### 4. CI — build, sign, notarize `Breeze Installer.app` once per release

**New job in `.github/workflows/release.yml`:** `build-macos-installer-app`, depends on `build-macos-agent` (needs the signed darwin agent binaries to embed the PKGs).

```yaml
build-macos-installer-app:
  needs: [build-macos-agent]
  runs-on: macos-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4          # pkgbuild orchestration from a Node script, optional
      with: { node-version: '20' }

    - name: Import signing cert
      uses: apple-actions/import-codesign-certs@v3
      with:
        p12-file-base64: ${{ secrets.APPLE_DEVELOPER_ID_APPLICATION_P12 }}
        p12-password: ${{ secrets.APPLE_DEVELOPER_ID_APPLICATION_P12_PASSWORD }}

    - name: Download prebuilt PKGs
      uses: actions/download-artifact@v4
      with:
        name: breeze-agent-darwin-amd64-pkg
        path: installer-pkgs/
    - uses: actions/download-artifact@v4
      with:
        name: breeze-agent-darwin-arm64-pkg
        path: installer-pkgs/

    - name: Build Breeze Installer.app
      run: |
        cp installer-pkgs/breeze-agent-darwin-amd64.pkg \
           agent/installer/macos-app/Breeze\ Installer/Resources/breeze-agent-amd64.pkg
        cp installer-pkgs/breeze-agent-darwin-arm64.pkg \
           agent/installer/macos-app/Breeze\ Installer/Resources/breeze-agent-arm64.pkg
        cd agent/installer/macos-app
        xcodebuild -scheme "Breeze Installer" -configuration Release \
          -derivedDataPath build \
          CODE_SIGN_IDENTITY="Developer ID Application: Olive Technologies LLC (TEAMID)" \
          CODE_SIGN_STYLE=Manual \
          DEVELOPMENT_TEAM=$TEAM_ID

    - name: Notarize + staple
      env:
        APPLE_ID:          ${{ secrets.APPLE_ID }}
        APPLE_ID_PASSWORD: ${{ secrets.APPLE_ID_PASSWORD }}
        APPLE_TEAM_ID:     ${{ secrets.APPLE_TEAM_ID }}
      run: |
        APP="agent/installer/macos-app/build/Build/Products/Release/Breeze Installer.app"
        ditto -c -k --keepParent "$APP" installer-notarize.zip
        xcrun notarytool submit installer-notarize.zip \
          --apple-id "$APPLE_ID" --password "$APPLE_ID_PASSWORD" --team-id "$APPLE_TEAM_ID" \
          --wait
        xcrun stapler staple "$APP"
        ditto -c -k --sequesterRsrc --keepParent "$APP" "Breeze Installer.app.zip"

    - name: Upload to release
      uses: actions/upload-artifact@v4
      with:
        name: breeze-installer-app-zip
        path: Breeze Installer.app.zip
```

The release's asset-upload step (already present for the other darwin artifacts) picks up `Breeze Installer.app.zip` and pushes it to the GitHub release.

### 5. Installer builder service — `apps/api/src/services/installerBuilder.ts`

**Add fetcher (mirrors `fetchMacosPkg`):**

```ts
export async function fetchMacosInstallerAppZip(): Promise<Buffer>
```

**Add renamer** (implementation sketch above):

```ts
export async function buildMacosInstallerAppZip(
  templateAppZip: Buffer,
  token: string,
  apiHost: string,
): Promise<Buffer>
```

**Deprecate** `buildMacosInstallerZip` (the zip-with-install.sh builder). Keep it behind a `?legacy=1` query param on the installer route for one release cycle as a rollback escape hatch, then delete in a followup.

## Open questions

1. **Token format exposed in filename.** Current choice: `[<6-char-token>@<api-host>]` — visible and somewhat ugly in Finder. Alternatives:
   - `[A7K2XQ]` with API host fetched from a DNS TXT record or a hardcoded compile-time default. Cleaner but breaks self-hosters who don't compile their own app.
   - Base64-encoded compact payload `[QTdLMlhRQHVzLjJicmVlemUuYXBw]` — shorter numerically but more opaque; users can't tell what region it is at a glance.
   - **Recommendation:** keep `[TOKEN@HOST]` as designed. The bracket makes it visually distinct from the app name, and the host is informative ("which Breeze deployment does this install into?"). Ugly-but-honest beats pretty-but-magic.

2. **PKG embedding vs remote download at install time.** Embedding both PKGs makes the `.app` ~55 MB. Downloading from GitHub CDN at install time would keep it ~5 MB but adds a network dependency mid-install. Embedding matches current behavior and makes the installer fully self-contained; that's the safer default. Download-on-demand is a followup if install bundle size becomes a real complaint.

3. **Re-enrollment UX.** If the admin runs the installer on a machine already enrolled as device X, we'd currently create a duplicate device Y. Detecting this: run `/usr/local/bin/breeze-agent status` (returns device ID if enrolled, non-zero otherwise) before enrolling. If already enrolled, show a confirmation: *"This Mac is already registered as <hostname> in <org>. Replace it?"*. **Deferred to v2** — not blocking the first ship.

4. **Progress parsing.** `installer` emits percentage lines to stderr, parseable but finicky. v1 ships with a spinner.

5. **Telemetry.** Should the installer app phone home with `install.start` / `install.success` / `install.fail` events for support diagnosis? Low priority for v1; punted to followup.

## Non-goals

- Per-customer signing or notarization of the `.app`. The whole point is that it's static.
- MDM-based silent install. MSPs with Jamf/Kandji/Intune should push the raw PKG via MDM, not this GUI installer.
- In-app auto-update of the installer. Agent's `/enroll` command is stable; old installers keep working.
- Progress parsing from `installer` stderr. Spinner is fine.
- Self-hoster doc for custom-compiling the installer with their own Developer ID. Covered in a followup doc after the Apple pipeline stabilizes.

## Risks

- **User renames the `.app` and strips the `[...]` bracket.** App falls back to clear error message: *"This installer needs its original filename — re-download from your Breeze web console."* Can't mitigate without per-install notarization.
- **ZIP extraction behavior differs by browser.** Safari auto-extracts; Chrome does not. Add a one-liner to the download-success toast covering Chrome users.
- **Token leakage via browser history or corporate proxy logs.** The bootstrap URL contains the token. Mitigations already in place: single-use + 24h TTL. Moving the token to a POST body is marginal — URL-path tokens are industry-standard for this kind of short-lived bootstrap (password resets, magic login links). Good enough.
- **Safari 17+ zip auto-extract prompts for permission the first time.** One-time OS-level nuisance, not our bug.
- **User's Mac is fully offline after download.** Bootstrap endpoint unreachable → install fails. Show network-error view with "Retry" button. Online install only.
- **Apple notarization service outage during release.** Blocks the CI job. Same risk as today's agent-binary notarization — existing mitigation (retry, manual kick) applies.
- **Developer ID Application cert rotation.** One-time annual chore, same as agent binaries. Not new ops.

## Build sequence

1. **Token table + RLS + migrations + integration test.** Migration number, policy SQL, allowlist entry in `rls-coverage.integration.test.ts`. Drop-into-`psql` verification as `breeze_app`. No installer app yet.
2. **Bootstrap route + unit + integration tests.** `POST`-only from `curl`, no Swift app needed. Verify single-use + TTL + race-safe concurrent consume. Verify child enrollment key is created lazily.
3. **Installer route change.** Generate token, skip child-key creation, return the generic template app renamed with `[TOKEN@HOST]` using the existing zip-with-install.sh as a fallback behind `?legacy=1`. Deploy + smoke test with a stub `.app` (any signed Mac app will do for the plumbing).
4. **Swift app.** Xcode project, SwiftUI views, filename parser, bootstrap fetcher, AppleScript installer, enroll invocation. Local Developer ID build + smoke test on dev machine.
5. **CI pipeline.** `build-macos-installer-app` job, upload-artifact, attach to release. Validate notarization + stapling on a fresh tag.
6. **Flip default.** Remove `?legacy=1` fallback after one full release cycle with no rollback needed.

## Appendix — Why we're not mirroring the Windows MSI signing stack

The Windows MSI flow uses server-side byte-patch sentinels + remote signing via a Cloudflare-tunneled Windows VM + Azure Trusted Signing dlib. That works, but carries a real ops tax: a Windows VM on the OliveTech LAN, CF Access service tokens, an Azure subscription with rotating signing certs, a 3-day cert lifetime, and a pile of padded-sentinel code (the v0.62.23 trim bug surfaced precisely because the padded-sentinel path was the one customers actually hit but wasn't in the smoke test). All of that solves "inject per-customer data into a signed binary without re-signing."

Authenticode on MSI is actually based on the MSI's internal content hash, not the filename — meaning a generic signed MSI can be renamed `Breeze Agent [TOKEN].msi` and its signature stays valid, identical in principle to this Mac design. A future cleanup could fold the Windows MSI onto the same pattern:

1. Generic signed + notarized MSI, built once in CI, no per-customer signing.
2. A WiX custom action that reads the built-in `OriginalDatabase` property (full path to the MSI being installed), regex-extracts the token from the filename, calls the same `GET /installer/bootstrap/<token>` endpoint, invokes `breeze-agent enroll` with the returned values.
3. API just renames the template MSI per download and serves it — no byte-patch, no Windows VM, no Azure account.

Retiring the current Windows stack isn't urgent (it's paid for and working), but building the Mac installer on this simpler pattern avoids re-creating the same ops surface on another platform. If the Windows stack ever needs a material change — cert migration, Azure churn, a new signing provider — that's the moment to switch it over. Until then, treat the filename-token approach as the forward-default for any new platform (Linux `.deb`/`.rpm`, Windows app-store bundles, etc.).

## Followups (not in scope)

- Re-enrollment detection + "replace existing device?" confirmation.
- Progress bar from `installer` stderr parsing.
- Installer app telemetry (`install.start`/`install.success`/`install.fail` events).
- Self-hoster doc: "how to build your own signed Breeze Installer.app with your own Developer ID."
- Port Windows MSI to filename-token pattern; retire the `sign.2breeze.app` signing VM.
- Linux installer: same pattern with a signed `.sh` or `.deb` that self-extracts a signed agent + reads token from its own filename.
