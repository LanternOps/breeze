# BitLocker / FileVault Recovery-Key Escrow — Design

**Issue:** [#2021](https://github.com/LanternOps/breeze/issues/2021) — Built-in BitLocker / FileVault encryption key management
**Date:** 2026-07-06
**Status:** Approved design, pending implementation plan

## Problem

There is no built-in way to manage disk encryption across devices. Techs collect BitLocker
recovery keys with ad-hoc scripts and store them manually. There is no central view of which
devices are encrypted, no escrow of recovery keys, and no audited way to look a key up when a
user is locked out.

## Scope (v1)

**In scope:**
- Automatic escrow of BitLocker recovery keys (Windows), encrypted at rest.
- On-demand, credentialed rotate-and-escrow for FileVault personal recovery keys (macOS).
- On-demand BitLocker key rotation and re-collection.
- Audited, fetch-on-demand key reveal (who/when ledger + standard audit log).
- Real escrow status in the existing fleet Encryption page and device Security tab.

**Out of scope (deferred):**
- Remote *enforcement* — enabling BitLocker/FileVault on unencrypted devices.
- Silent/background FileVault key collection (macOS does not expose the PRK after enablement;
  escrow requires a rotation authenticated by a FileVault-enabled user).
- Linux LUKS escrow (status detection already exists and remains status-only).
- New alerting. Flagging is via the fleet view and the existing security-posture score, which
  already penalizes unencrypted devices. An alert-bridge evaluator can be added later if needed.
- Config/policy tables. v1 adds **no config table**, so the partner-wide-first rule (CLAUDE.md,
  epic #2135) does not apply to this feature. If a future "encryption required" policy is added,
  it must follow the dual-ownership playbook.

## What already exists (reuse, don't rebuild)

- **Agent detection:** `agent/internal/security/status.go` already detects encryption status and
  per-volume detail for BitLocker (`Get-BitLockerVolume`), FileVault (`fdesetup status`), and
  LUKS (`lsblk`), reported on the 5-minute security tick via
  `sendInventoryData("security/status", ...)`.
- **Server storage:** `security_status.encryption_status` + `encryption_details` (jsonb), written
  by `upsertSecurityStatusForDevice` under the agent's org-scoped RLS context.
- **Fleet endpoint + UI:** `GET /security/encryption` (`apps/api/src/routes/security/compliance.ts`)
  and `apps/web/src/components/security/EncryptionPage.tsx`. **Note:** the endpoint's
  `recoveryKeyEscrowed` field is currently a fake heuristic (`compliance.ts:154`) — v1 replaces it
  with real data.
- **Secrets at rest:** `apps/api/src/services/secretCrypto.ts` (AES-256-GCM, AAD =
  `table.column`, keyring rotation) + `encryptedColumnRegistry.ts`.
- **Audited sensitive actions:** PAM elevation pattern — domain ledger table + `writeRouteAudit`,
  secret never in audit details (`apps/api/src/routes/devices/actuateElevation.ts`).
- **Server→agent commands:** handler registry pattern (`agent/internal/heartbeat/handlers_security.go`),
  results POSTed back per command, `privilege.elevatedCommandTypes` gating.

## Architecture (Approach A — extend the security pipeline)

Keys get a dedicated table; collection, transport, auth, crypto, audit, and UI all ride existing
rails. A standalone module and vault/custom-field storage were considered and rejected (more code
for no v1 benefit; not first-class, respectively). Enforcement can be added later without rework —
the escrow table and command handlers are the same either way.

## Data model

### `device_recovery_keys`

One row per escrowed key. Hot agent-write table → RLS shape 5 with **denormalized `org_id`**
(phase 1-4 pattern), policy `breeze_has_org_access(org_id)`.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `device_id` | uuid FK → devices.id, cascade | |
| `org_id` | uuid FK → organizations.id, cascade | denormalized from device |
| `key_type` | varchar | `bitlocker_recovery_password` \| `filevault_personal_recovery_key` |
| `volume_mount` | varchar, nullable | e.g. `C:`; null for FileVault |
| `protector_id` | varchar, nullable | BitLocker KeyProtector GUID; null for FileVault |
| `encrypted_key` | text | `encryptSecret` AES-256-GCM, AAD `device_recovery_keys.encrypted_key` |
| `key_fingerprint` | varchar | SHA-256 of plaintext; dedupe/change-detect without decrypting |
| `status` | varchar | `active` \| `superseded` |
| `escrowed_at` | timestamptz | |
| `superseded_at` | timestamptz, nullable | |
| `created_at` / `updated_at` | timestamptz | |

Indexes: `(device_id)`, `(org_id)`, partial unique on `(device_id, key_type, volume_mount)`
`WHERE status = 'active'` (with `COALESCE(volume_mount,'')` if needed for null handling).

Ingest semantics: each agent `PUT` is a **full snapshot of the device's BitLocker keys**. For
each reported key, match on `(device_id, key_type, volume_mount)` — same fingerprint → no-op;
different fingerprint → mark the existing active row `superseded` (set `superseded_at`) and
insert a new `active` row. Active `bitlocker_recovery_password` rows for the device that are
absent from the snapshot are also superseded (the protector was removed, so the key no longer
unlocks anything). FileVault rows are **exempt from snapshot-supersede** — they are written only
by the rotate command, never by the Windows snapshot. **History is retained** (superseded keys
may still unlock volumes after a half-failed rotation, and have forensic value). No retention
pruning in v1.

`encrypted_key` is registered in `encryptedColumnRegistry` (kind `text`) so key-rotation sweeps
cover it. Writes go through `encryptColumnValueForWrite`; reads through `decryptForColumn`.

### `recovery_key_access_events`

Append-only reveal ledger. RLS shape 1 (direct `org_id`, auto-discovered policy).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `key_id` | uuid FK → device_recovery_keys.id | |
| `device_id` | uuid FK → devices.id, cascade | |
| `org_id` | uuid FK → organizations.id, cascade | |
| `user_id` | uuid | revealing user |
| `user_email` | varchar | snapshot at reveal time |
| `action` | varchar | `revealed` (rotate/collect audited via route audit only) |
| `created_at` | timestamptz | |

Every reveal writes **both** a ledger row and a standard `writeRouteAudit` event
(`device.recovery_key.reveal`) — the PAM dual-record discipline. Key material appears in
**neither** (audit details pass through `sanitizeAuditPayload`, and the route never puts the key
in `details`).

### Migration

`apps/api/migrations/<commit-date>-device-recovery-keys.sql` (dated the day it's committed, per
the migration naming convention): creates both tables **and** their RLS
(enable + force + policies) in the same idempotent migration. Register both tables in the
rls-coverage contract-test allowlists as required for their shapes, in the same PR. Add both
tables to the tenant-cascade lists if applicable (dual-cascade contract).

## Agent (Go)

### Automatic BitLocker escrow (Windows)

New collector in `agent/internal/security` (e.g. `recoverykeys_windows.go` + no-op stubs for
other platforms, or runtime GOOS switch matching `status.go`):

- PowerShell: `Get-BitLockerVolume | Select MountPoint, KeyProtector` — extract
  `RecoveryPassword`-type protectors → `{mount, protectorId, recoveryPassword}` per volume,
  JSON output, parsed defensively (PS 5.1 single-element collapse — see known gotcha).
- Rides the existing 5-minute security tick in `heartbeat.go`, but **only transmits when the
  fingerprint set differs from the last successful send** (in-memory hash of collected key set),
  plus once at agent startup. Server-side fingerprint dedupe makes retransmission idempotent.
- Transport: `PUT /api/v1/agents/{id}/security/recovery-keys` via `sendInventoryData`.
- Key material is never written to agent logs at any level.

### On-demand commands

New `agent/internal/heartbeat/handlers_encryption.go`, registered via `init()` like
`handlers_security.go`. Both command types added to `privilege.elevatedCommandTypes` and new
`Cmd*` constants in `agent/internal/remote/tools/types.go`.

- **`encryption_collect_keys`** (Windows): run the collector now, push results, return counts
  (never keys) in the `CommandResult`.
- **`encryption_rotate_key`**:
  - *Windows:* for the target volume, add a new recovery-password protector, delete the old one
    (add-before-delete so the volume is never protector-less), collect + push, return success/failure only.
  - *macOS:* payload carries `{username, password}` of a FileVault-enabled user **or**
    `{currentRecoveryKey}`. Agent builds a temp `-inputplist` for
    `fdesetup changerecovery -personal`, captures the new PRK from stdout, pushes it to escrow,
    shreds the temp plist and zeroes buffers. `CommandResult` contains no key or credential
    material.

### Command-payload credential handling

`device_commands` persists payloads, so the macOS rotate credentials must not land in the DB or
logs in plaintext:

- The API encrypts sensitive payload fields (`password`, `currentRecoveryKey`) with
  `secretCrypto` before enqueueing the command, decrypts them only at the point of delivery to
  the agent (WS/heartbeat dispatch), and blanks them from the stored command row after the
  command reaches a terminal state.
- Command audit events (`EventCommandReceived`/`EventCommandExecuted` on the agent; route audit
  on the API) redact the payload for this command type.

## API

All new tech-facing routes live under `apps/api/src/routes/security/` alongside the existing
encryption endpoint; the agent ingest route lives under `apps/api/src/routes/agents/`.

| Route | Auth | Behavior |
|---|---|---|
| `PUT /agents/:id/security/recovery-keys` | `requireAgentRole` | Zod-validated batch of `{keyType, volumeMount?, protectorId?, recoveryKey}`; supersede/dedupe upsert per Data Model; `encryptColumnValueForWrite`; runs in agent org-scoped context. |
| `GET /security/encryption/devices/:deviceId/recovery-keys` | user token + site-scope check | Key **metadata** (type, volume, protector, status, escrowed_at) + access history. Never key material. |
| `POST /security/encryption/devices/:deviceId/recovery-keys/:keyId/reveal` | user token + site-scope check | `decryptForColumn` → return plaintext once; insert `recovery_key_access_events` row + `writeRouteAudit('device.recovery_key.reveal')`. No caching; key never in list payloads. |
| `POST /security/encryption/devices/:deviceId/recovery-keys/rotate` | user token + site-scope check | Enqueue `encryption_rotate_key` command; macOS body requires credentials (encrypted per above); audited as `device.recovery_key.rotate`. Validates OS/type match. |
| `GET /security/encryption` (existing) | unchanged | Replace fake `recoveryKeyEscrowed` (`compliance.ts:154`) with real `EXISTS` on active `device_recovery_keys`; add "escrow missing" filter value. |

Site-scope authorization mirrors `apps/api/src/routes/security/posture.ts` (explicit check beyond
RLS). Reveal access = any tech with device access; no admin-only gate in v1 (decision: frontline
lockout recovery is the primary use case; the audit trail is the safeguard).

Security-posture scoring is unchanged in v1.

Human-readable audit action labels added in `apps/api/src/routes/devices/events.ts`.

## Web

- **`EncryptionPage.tsx`** (fleet): real escrow column + "escrow missing" filter; expandable
  device rows gain a **Reveal key** action → modal that fetches on reveal via `runAction`,
  displays the key with a copy button and a "this access is recorded" notice, and shows recent
  access history for that key.
- **`DeviceSecurityTab.tsx`** (device detail → Security tab): new encryption card — status,
  method, per-volume detail (data already collected), escrowed key list with reveal buttons,
  rotate action (confirm dialog on Windows; credentials modal on macOS explaining why they're
  needed), and per-key access history.
- All mutations wrapped in `runAction`; standard `handleActionError` catch pattern; fetches via
  `fetchWithAuth` with AbortController per existing page conventions.

## Error handling

- Collector failures (PowerShell/fdesetup errors, parse failures) leave previously escrowed data
  untouched; no partial writes; encryption status stays `unknown` per existing behavior.
- Rotate failures return an error `CommandResult` with no key/credential material; the UI surfaces
  the failure via `runAction` toasts.
- Missing/misconfigured `APP_ENCRYPTION_KEY` fails ingest/reveal loudly (secretCrypto strict
  mode) — never a silent fallback.
- Unsupported platforms (Linux, and macOS for automatic collection) render as "escrow not
  supported" / "requires rotation", not as missing keys.
- Reveal of a `superseded` key is allowed (it may still be the one taped to the old protector)
  but labeled as superseded in the UI.

## Testing

Per the breeze-testing checklist:

- **Go (table-driven, `-race`):** BitLocker KeyProtector JSON parsing (incl. PS 5.1
  single-element collapse), `fdesetup changerecovery` output parsing, both command handlers with
  mocked `RunCommand`, fingerprint change-detection gating.
- **API route tests (Vitest + Drizzle mocks):** ingest supersede/dedupe/no-op paths; reveal
  happy path + site-scope denial + ledger row written + **assertion that audit `details` and all
  log output contain no key material**; rotate validation (OS mismatch, missing macOS creds).
- **RLS integration:** `deviceRecoveryKeysRls.integration.test.ts` — cross-tenant forged insert
  fails with 42501 for both tables; tables registered in the rls-coverage contract test
  allowlists; verified live as `breeze_app`.
- **Web (Vitest + jsdom):** reveal modal (fetch-on-reveal, key display, error path), rotate
  credentials modal validation.

## Decisions log

| Decision | Choice |
|---|---|
| v1 scope | Escrow only; no remote enable/enforcement |
| FileVault escrow | On-demand rotate-and-escrow with tech-supplied FileVault-user credentials; no background collection |
| Reveal access | Any tech with device access; dual audit (ledger + route audit); no forced rotate after reveal |
| Flagging | Fleet view + existing posture score only; no new alerts in v1 |
| Architecture | Approach A — extend existing security pipeline; dedicated `device_recovery_keys` table |
| Key history | Superseded keys retained indefinitely in v1 |
