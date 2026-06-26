# Built-in Huntress & SentinelOne Deployment Packages

**Date:** 2026-06-26
**Status:** Approved — ready for implementation plan
**Author:** Todd Hebebrand (with Claude)

## Summary

Add **built-in Huntress and SentinelOne agent deployment packages** to the Software
deployment library. The packages appear automatically when the corresponding
integration is connected at the partner level, and deploy to endpoints with the
correct per-organization enrollment key (Huntress org key / S1 site token) injected
into the installer command **automatically** — no manual key copy-paste per org.

Huntress is the zero-touch reference case: both the installer download URL and the
silent-install keys are fully derivable from data we already sync. SentinelOne
follows the same machinery with two extra wrinkles (a site token to sync and a
one-time binary upload).

**v1 scope:** Windows only, both vendors. macOS/Linux are a clean fast-follow via
the existing `software_versions.supportedOs` field with no rework.

## Background / Current State

### Software deployment library (org-scoped today)
- `software_catalog` (`org_id NOT NULL`) → `software_versions`
  (`download_url` / `s3_key`, `silent_install_args` with a `{file}` placeholder,
  pre/post scripts, `supported_os`) → `software_deployments` (`org_id NOT NULL`) →
  `deployment_results` (per-device).
- Deploy flow: resolve target device IDs → insert deployment + per-device results →
  for immediate installs, presign S3 / use `download_url`, send a `software_install`
  WS command to each online agent. The Go agent downloads, verifies checksum, runs
  the installer with `silent_install_args`, returns exit code + output.
- There is **no concept of built-in / system / template packages** today; each org
  starts with an empty catalog. `is_managed` exists but refers to inventory
  management, not built-ins.
- Files: `apps/api/src/db/schema/software.ts`, `apps/api/src/routes/software.ts`,
  `apps/web/src/components/software/*`,
  `agent/internal/remote/tools/software_install.go`.

### Integrations (partner-scoped)
- **Huntress** — `huntress_integrations` (partner-scoped, `api_key_encrypted`,
  `account_id`, `is_active`) + `huntress_org_mappings` which **already stores
  `huntress_org_key` and `huntress_account_id` per mapped Breeze org**.
- **SentinelOne** — `s1_integrations` (partner-scoped, `api_token_encrypted`,
  `management_url`, `is_active`) + `s1_org_mappings` storing `s1_site_id` per mapped
  Breeze org. **The S1 site enrollment token is not stored yet.**
- Both are configured once at partner scope and mapped to Breeze orgs via
  `*_org_mappings`. Activation state = `is_active` + `last_sync_status`.
- Secrets are encrypted via `apps/api/src/services/secretCrypto.ts` (AES-256-GCM,
  v3 AAD-bound to `table.column`).
- Files: `apps/api/src/routes/huntress.ts`, `apps/api/src/routes/sentinelOne.ts`,
  `apps/api/src/jobs/huntressSync.ts`, `apps/api/src/jobs/s1Sync.ts`,
  `apps/web/src/components/integrations/{HuntressIntegration,SecurityIntegration}.tsx`.

### Vendor deployment mechanics (researched & confirmed)
- **Huntress (Windows):** stable per-account installer URL
  `https://update.huntress.io/download/<ACCOUNT_KEY>/HuntressInstaller.exe`; silent
  install `HuntressInstaller.exe /ACCT_KEY="<acct>" /ORG_KEY="<org>" /TAGS="<tags>" /S`.
  Account key is per-partner; org key is per-org. Official deploy script is
  Windows-only. (macOS is a separate `.pkg` flow — out of v1 scope.)
- **SentinelOne (Windows):** needs a **SITE_TOKEN** (base64 "registration token"),
  *not* the site ID. MSI path:
  `msiexec /i SentinelInstaller.msi SITE_TOKEN=<token> /q /NORESTART`. The token is
  exposed on the S1 management API `GET /sites` as `registrationToken`. Installer
  binaries are version-specific and gated behind auth → realistic path is a one-time
  partner upload.

Sources:
- https://support.huntress.io/hc/en-us/articles/4404012600979-Install-via-Single-Command-Line
- https://github.com/huntresslabs/deployment-scripts/blob/main/Powershell/InstallHuntress.powershellv2.ps1
- https://www.scribd.com/document/625759028/Mass-Deployment-Methods-for-SentinelOne-Agents-1
- https://www.postman.com/api-evangelist/sentinelone/request/qh3og2o/get-sites

## Goals

1. Built-in Huntress + S1 packages appear in the Software library automatically when
   the partner connects the integration.
2. Deploying a built-in package injects the correct **per-org** enrollment key into
   the installer command automatically, resolved server-side at dispatch.
3. Reuse the existing deployment pipeline (wizard, `software_install` WS command,
   results/progress tracking) with minimal new surface area.
4. Keep tenant isolation intact (partner-scoped catalog via RLS dual-axis;
   deployments remain org-scoped).

## Non-Goals (v1)

- macOS / Linux variants (fast-follow via `supported_os`).
- Auto-fetching the S1 binary from the S1 `update/agent/packages` API into S3
  (Approach C) — deferred; partner uploads the MSI once.
- Configurable Huntress `/TAGS` UI — may default to empty/none in v1.
- A generic "any integration → deployment package" framework. Two code-defined
  providers only; generalize later if a third appears.

## Design

### 1. Catalog gains a partner axis

Single idempotent migration on `software_catalog`:

- Add `partner_id uuid` (nullable, FK → `partners.id`).
- Make `org_id` nullable.
- Add `CHECK (num_nonnulls(org_id, partner_id) = 1)` — a row is **either** org-scoped
  (existing custom packages) **or** partner-scoped (built-ins), never both/neither.
- Add `integration_provider varchar(20)` nullable — `'huntress'` | `'sentinelone'`.
  Non-null marks a built-in, read-only package; null = normal user package.
- Index on `partner_id` and on `(partner_id, integration_provider)`.

**RLS:** `software_catalog` moves to dual-axis (shape 4, like `users`):
`breeze_has_org_access(org_id) OR breeze_has_partner_access(partner_id)` in both
USING and WITH CHECK. Policies ship in the same migration. Add `software_catalog` to
`PARTNER_TENANT_TABLES` (and the dual-axis allowlist) in
`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`. Verify as
`breeze_app` that a cross-partner insert fails.

`software_versions` already FKs `software_catalog`; no tenancy column change needed —
it inherits scope via the catalog join. (Confirm RLS coverage for `software_versions`
still holds with a partner-scoped parent; adjust its policy/allowlist entry if it
currently assumes an org-keyed parent.)

`software_deployments` and `deployment_results` stay **org-scoped, unchanged**.

### 2. Built-in package registry + auto-provisioning

A small server-side, code-defined registry (e.g.
`apps/api/src/services/builtinDeploymentPackages.ts`) describes each built-in:

```
huntress:
  name: "Huntress EDR Agent", vendor: "Huntress", category: "security"
  fileType: "exe", supportedOs: ["windows"]
  downloadUrlTemplate: https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe
  silentInstallArgsTemplate: /ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S
  requiresBinaryUpload: false

sentinelone:
  name: "SentinelOne Agent", vendor: "SentinelOne", category: "security"
  fileType: "msi", supportedOs: ["windows"]
  silentInstallArgsTemplate: SITE_TOKEN={s1_site_token} /q /NORESTART
  requiresBinaryUpload: true   # no deployable version until partner uploads the MSI
```

On **partner connect** — success path of `POST /huntress/integration` and
`POST /s1/integration` — upsert one partner-scoped `software_catalog` row per provider
and (for Huntress) its `software_versions` row. Idempotent: connecting again is a
no-op. The catalog row stores the **templates** with `{...}` placeholders; it never
stores resolved secret keys.

For S1, the catalog row is created on connect but has **no deployable version** until
the partner uploads the S1 MSI through the existing version-upload UI (which fills
`s3_key`/`checksum`); `silent_install_args` is pre-populated with the token template.

### 3. Per-device key resolution at deploy time

Extend the existing `{file}` substitution in the deployment dispatch path. When a
deployment's version belongs to an `integration_provider` package, for **each target
device**:

1. Resolve the device's `org_id` → the provider's org mapping
   (`huntress_org_mappings` / `s1_org_mappings`) for the active integration.
2. Resolve placeholders from integration + mapping data:
   - Huntress: `{huntress_acct_key}` (partner-level account key),
     `{huntress_org_key}` (`huntress_org_mappings.huntress_org_key`).
   - SentinelOne: `{s1_site_token}` (`s1_org_mappings.registration_token`, decrypted).
3. Build that device's `software_install` command (download URL + silent args) with
   real values and dispatch over WS.
4. **Guard rails** — if the device's org is unmapped, the integration is inactive, or
   a required key is missing, write that device's `deployment_result` as `failed`
   with a clear message ("Organization not mapped to Huntress", "Integration
   disconnected", "SentinelOne site token not synced — run Sync in Integrations")
   **without** dispatching a broken install.

**Secret handling:** resolved account/org keys and site tokens are produced only at WS
dispatch, server-side. They are never written to the catalog row in plaintext and
never returned in any catalog/version/deployment API response sent to the web client.

Because `software_deployments` is org-scoped, a built-in deploy that targets devices
across multiple orgs creates **one `software_deployment` row per distinct org** (with
that org's `org_id`), each with its own `deployment_results`. This preserves tenant
isolation and reuses all existing progress/results UI unchanged.

### 4. Data dependencies to close

These are implementation tasks, not architecture changes:

- **S1 site token sync.** Add `registration_token text` to `s1_org_mappings`, stored
  **encrypted** via `secretCrypto` (AAD `s1_org_mappings.registration_token`). The
  existing `s1Sync` job captures `registrationToken` from `GET /sites` and writes it
  on each sync. This is the "pre-sync the key" piece for S1.
- **Huntress account *key* vs account *id*.** The download URL and `/ACCT_KEY` require
  the Huntress **Account Key**; today we store `account_id` + the REST `api_key`.
  Implementation must confirm whether the stored value is usable as the deploy account
  key, or fetch it from the Huntress API / capture it explicitly on the integration
  form. Verification step — does not reshape the design. If a new field is needed,
  store it encrypted alongside the existing integration secrets.

### 5. Web UI

- Built-in packages render in the existing Software library with a badge
  (**"Built-in · Huntress"** / **"Built-in · SentinelOne"**) and are **read-only** —
  no edit/delete. For S1, the only allowed mutation is uploading a version binary
  through the existing version-upload UI.
- Deploy action is **disabled with a tooltip** when the integration is disconnected
  (`is_active = false` or no integration). In per-org targeting, unmapped orgs are
  greyed with "Map this org in Integrations first." (The "visible but deploy-disabled"
  behavior.)
- Wrap any new mutation handlers in `runAction` per the web mutation convention.

### 6. Testing

- **RLS contract test:** dual-axis forge for `software_catalog` (cross-partner and
  cross-org inserts must fail as `breeze_app`); confirm `software_versions` coverage
  with a partner-scoped parent.
- **Resolver unit tests:** correct per-org key injection (Huntress acct+org key, S1
  token); unmapped org / inactive integration / missing token → `failed` result and
  **no** WS dispatch; multi-org target splits into one deployment per org.
- **secretCrypto round-trip** for the S1 `registration_token` column (AAD-bound).
- **Web test** for the disabled-deploy state (disconnected integration, unmapped org).
- Follow `breeze-testing` conventions.

## Open Questions / Risks

1. **Huntress account-key source** (§4) — confirm during implementation whether
   `huntress_integrations.account_id` is the deploy Account Key or a separate value to
   capture/fetch.
2. **S1 `registrationToken` field name/shape** — confirm exact field on the target S1
   console/API version during the sync change.
3. **Huntress `/TAGS`** — v1 likely omits; revisit if partners want endpoint tagging.

## Rollout

Windows-only, both vendors, in one spec. Build Huntress end-to-end first as the
reference implementation; SentinelOne reuses the same resolver/placeholder machinery
plus the token-sync and upload-once additions. macOS/Linux follow later via
`supported_os` with no schema rework.
