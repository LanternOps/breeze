---
issue: 11808
tracking_issue: LanternOps/breeze#12275
status: plan-approved (Gate B, Todd 2026-11-19, with changes)
date: 2026-11-18
base: main @ e8bf959e63
---

# UniFi Site Manager: several labelled API keys per connection, implementation plan (#11808)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cloud UniFi connection holds a list of labelled Site Manager API keys: the Independent-sites key plus one per Fabric. Every sync reads all enabled keys, merges what they see, and removes duplicates by `(host id, site id)` and device id. Each key's health is shown on its own. A failing key affects only the consoles it can reach.

**Architecture:** A new partner-axis table, `unifi_integration_keys`, holds one encrypted key per row along with that key's status. The migration that creates the table copies the existing key into it. The sync's network phase builds one client per key. A pure merge module joins their reads into the single view the existing mapping logic consumes, adding three things: which keys list each host, device ids reported under conflicting hosts, and the hosts a failed key could reach. Device attribution and the stale sweep skip those hosts. Site mappings and devices stay keyed by connection, so a site seen through two keys stays one mapping, and each of its devices stays one row.

**Tech Stack:** Hono/TypeScript API, Drizzle (queries only), hand-written SQL migrations, BullMQ, Zod, Vitest (API and web), React islands, i18next (8 locales), Starlight docs.

**Spec:** No separate spec doc. The source is issue #11808: the reporter's test results (2026-11-16) and the owner's design comment (2026-11-17). The **Design** section below carries the reasoning, argued from code at `e8bf959e63`. An independent Codex review (gpt-6.2-astra, read-only, 2026-11-18) is folded in. Each change it caused is marked *(advisor)*.

Evidence labels: **verified** = read in code at that SHA. **inferred** = reasoned, not run. **not checked** = an open fact a task or gate must confirm.

**Gate B (2026-11-19): approved with four changes,** folded into the tasks below and listed under *Gate B changes*.

**Issues:** anchor #11808. Follow-up bug #12264 (restricted key, wrong org). Wave PRs say `Refs #11808` plus `Closes #<wave sub-issue>`. Never write a closing keyword for #11808: a negated keyword still closes it. The owner closes #11808 after W3 ships.

---

## Design

### What exists (verified)

1. **One key per partner.** `unifi_integrations` has `api_key_encrypted` and the partial unique index `unifi_integrations_partner_active_idx (partner_id) WHERE is_active` (`db/schema/unifi.ts:23-42`). `upsertConnection` and `createSelfHostedIntegration` both upsert on that index, and the self-hosted upsert leaves a previous cloud key in place (`services/unifi/unifiConnectionService.ts:90-150`).
2. **The ciphertext's AAD is the column name.** The key is sealed with AAD `unifi_integrations.api_key_encrypted` (`unifiConnectionService.ts:95`). `decryptForColumn(table, column, …)` derives AAD from its own arguments (`services/secretCrypto.ts:509-516`). `columnAad(spec)` honours `spec.aadTag` (`services/encryptedColumnTransform.ts:76-83`). The column is **not** in `encryptedColumnRegistry`, so key rotation never re-seals it.
3. **A CHECK requires a key on cloud rows:** `unifi_integrations_cloud_key_chk` (`migrations/2026-06-29-a-unifi-self-hosted-connection.sql`).
4. **Sync runs in three phases** (`jobs/unifiWorker.ts:95-140`):
   1. A short system context reads the credentials and a snapshot of the mappings.
   2. `collectSyncData` makes the HTTP calls with no DB context.
   3. `applySyncData` writes the results, using the mapping snapshot from phase 1.

   Of the four account-wide reads, `listHosts`, `listSitesForSync` and `listDevicesByHost` are fatal on failure. `listIspMetricsBySite` makes the run partial (`services/unifi/unifiSyncService.ts:258-300`). The scheduler queues **every** active integration, self-hosted included (`jobs/unifiWorker.ts:67-93`). A manual and a scheduled run of the same integration can overlap.
5. **The device attribution guards assume a complete site list per host.** A mapping gets devices only if four things hold: its site is listed on its host, the host lists exactly one site, the host has no dropped site rows, and no site row lacks a host id (`unifiSyncService.ts:307-370`). Site ids are host-local (`unifiMappingHosts.ts:63`). The ISP-metrics lookup falls back to the bare site id (`unifiSyncService.ts:309`).
6. **Stale sweep.** Each `unifi_devices` row of the connection that this run did not see, and whose mapping did not fail, gets `is_stale` set and `discovered_asset_id` unlinked (`unifiSyncService.ts:527-545`). Device writes upsert on `(integration_id, unifi_device_id)` and rewrite `org_id` and `mapping_id` (`:456-500`).
7. **Identity is per connection:** mappings are unique on `(integration_id, unifi_host_id, unifi_site_id)`, and devices on `(integration_id, unifi_device_id)` (`db/schema/unifi.ts:58-61`, `:88-91`).
8. **Status.** `reauth_required` is set when the error text matches `401|unauthorized`, so a 403 is missed (`jobs/unifiWorker.ts:58-60`). Health emits one `unifi` observation per integration, and `lastSyncStatus = 'partial'` counts as healthy (`services/integrationStates.ts:180`, `:219-226`).
9. **The mapping UI enumerates sites live.** `GET /unifi/hosts` reads `/v1/hosts` and `/v1/sites` with the one key (`routes/unifi/index.ts:201-224`). The AI tool `unifi_status` action `hosts` does the same (`services/aiToolsUnifi.ts:105-117`). The web saves with `hostIds` = every visible host (`useUnifiIntegration.ts:487`). `PUT /unifi/mappings` deletes any saved mapping on those hosts that the save omitted, and the delete cascades to its devices (`routes/unifi/index.ts:263-307`).
10. **Every UniFi route** sits behind `canManagePartnerWidePolicies` (`routes/unifi/index.ts:92-97`). Writes also need `requireMfa()`.

### What the reporter established (#11808, 2026-11-16)

- A key created inside a Fabric returns every site and device in that Fabric, in the same `/v1/hosts` and `/v1/sites` shapes. The "Independent Sites" key returns only sites outside any Fabric.
- **Inferred from the screenshots:** a key can be limited to **selected sites and devices** when it is created. Two keys may therefore see one console with different site or device subsets.
- **Not checked:** whether `/v1/devices` for a key limited to one site of a multi-site console returns all of that console's devices. If it does, a key can list one site while devices from a site it cannot see come back. The single-site guard (fact 5) would then attribute the other site's devices to the wrong org. This risk exists **today** with a single restricted key. Several keys make it more likely. It is tracked as bug #12264. W2 does not wait for the answer: it ships the strict site-count rule (Task 2.2), and #12264 verifies the API behaviour afterwards.
- The reporter does not expect one console to appear under two scopes at once. A console moving into a Fabric may briefly appear under both scopes, or under neither (not checked).

### Decisions

**D1. A table of keys, not JSON on the connection.** The new table, `unifi_integration_keys`, is partner-axis (RLS shape 3), with `partner_id` denormalized and a composite FK to the parent. The model is `partner_service_principal_keys` (`migrations/2026-07-16-partner-service-principals.sql`). A JSON array was rejected for four reasons:
- The worker writes each key's status after every sync. With JSON, that becomes a read-modify-write of one blob, racing any user adding or renaming a key.
- The rotation registry works per column.
- The database could not enforce unique labels or the status domain.
- Health observations need row ids.

**D2. One connection with several keys, not several connections.** The owner's first comment (2026-11-10) proposed several connections. The design comment (2026-11-17) replaced that with one connection holding a list of keys. Identity is per connection (fact 7), so a site seen by two keys is one mapping and its devices are one row each, with no extra code. Several connections would let a site be mapped twice and its devices synced twice. The earlier objection was "a list hides which key failed". Per-key status and per-key health (D7) answer it.

**D3. The existing key moves by a verbatim ciphertext copy.** The creating migration inserts one key row per cloud integration, copying the ciphertext byte for byte. The new column is registered with `aadTag: 'unifi_integrations.api_key_encrypted'` (column-bound), which is how the value is sealed today (fact 2). Every read and write derives AAD with `columnAad(spec)` from that entry. **Never** call `decryptForColumn('unifi_integration_keys', …)`: it would derive the wrong AAD and fail on every copied v3 value *(advisor)*. Nothing is decrypted in SQL, no backfill job is needed, and there is no window in which a connection has no key. The pattern is "moved column keeps its AAD tag" (#6379).

**D4. Merge rules.** Keys are read in a stable order, `created_at` then `id`. That order sets precedence.
- **Hosts:** de-duplicated by id; the first key's payload wins.
- **Sites:** de-duplicated by `(hostId, siteId)`, never by site id alone, because site ids are host-local; the first key's payload wins.
- **Site evidence from a key whose devices read failed still counts** for the multi-site guard: that key's listed sites are real *(advisor)*.
- **Devices:** per-host union by `unifiDeviceId`; the first key's payload wins.
- **Conflicting device ids** *(advisor)*: a `unifiDeviceId` reported under two different hosts (a console mid-move between scopes) is removed from both lists. It is neither written nor swept this run, and the run is partial. Without this rule, the second upsert would move the device into the other host's org.
- **Uncertainty:** `hostsWithDroppedRows` is unioned across keys, and `rowsWithoutHostId` is summed.
- **ISP metrics:**
  - If any key's metrics read failed, the merged map is `undefined`, so `wan_metrics` stays untouched everywhere (as today).
  - Otherwise the maps merge, first key wins, with one exception: a **bare-site-id** entry supplied by more than one key is dropped, because a host-local id like `default` is ambiguous across keys *(advisor)*.

**D5. Failure bounds.** In each sync run, a host is **uncertain** if either of these is true:
- **(a) A failed key may reach it.** Which hosts that covers depends on what the failed key managed to read:
  - Its `/v1/sites` read succeeded this run: the hosts it listed.
  - Otherwise, the hosts in its `last_seen_host_ids` snapshot, which is written by its last successful run.
  - No snapshot (`NULL`): every host.
- **(b) The host's device coverage is incomplete** *(advisor)*: a key that listed the host returned no device group for it. That covers the case where the client silently drops a malformed group from one key while another key returns a valid subset.

For a mapping on an uncertain host, the sync writes no devices and runs no stale sweep. The mapping becomes a per-mapping error that names the key, and the run is partial. Mappings on every other host sync normally. When every key succeeds with full coverage, the behaviour is exactly today's.

**D6. Run status and obsolete writes.**
- **Every enabled key failed:** the run is `failed`. The integration's status is `reauth_required` when every failure was an `UnifiApiError` with status 401 or 403, and `error` otherwise. Failures are typed, not matched on message text *(advisor)*.
- **Some keys failed:** the run is `partial` and the integration stays `connected`. `last_sync_error` reads, for example, `1 of 3 keys failed: "Macera" (key rejected)`.
- **Zero enabled keys:** the run is `failed` with no reads, and the status is `reauth_required` with the message `No enabled API key on this connection`.
- **A key that fails to decrypt** is a failed key (`error`), never silently skipped, so its hosts become uncertain *(advisor)*.
- **Per-key fields:** each key row records `status`, `last_sync_at`, `last_sync_status`, `last_sync_error`, `last_ok_at`, `hosts_seen`, `sites_seen` and `last_seen_host_ids`.
- **Run ledger:** `unifi_sync_runs` gains `key_results jsonb`.
- **Obsolete-write guards** *(advisor)*:
  - Inside the apply transaction, `applySyncData` re-reads the mappings. It writes no devices for a mapping that was deleted, or whose `org_id`, `site_id` or `updated_at` changed since the phase-1 snapshot; such a mapping becomes a per-mapping error and is never swept.
  - Each key's status write is conditional on `last_sync_at IS NULL OR last_sync_at < run.startedAt`, so a run that finishes late never overwrites a newer run's result.
- **Only cloud integrations are scheduled or synced.** `createSelfHostedIntegration` deletes the integration's key rows in the same transaction *(advisor)*.

**D7. Health:** keep the integration observation and add one observation per key *(advisor)*.
- **The integration observation stays as it is:** same `sourceId`, so existing incidents survive. It still catches apply failures and a dead scheduler.
- **Per-key observations are added:** `sourceId` = key id, display name `UniFi: <label>`. A disabled or deleted key retires its observation.
- **Ships in W3,** together with key management, so a second key is never added without an alert path.

**D8. No site provenance column.** `unifi_site_mappings` gets no `key_id`. "Seen via" is computed live from the `/hosts` fan-out, per host and per site. A column would mean an org-cascade table change plus an export-policy classification and an org-merge review, all for data the live read already provides.

**D9. Explicit mapping deletes** *(advisor)*.
- `PUT /unifi/mappings` gains `removeMappingIds: uuid[]` (max 500).
- Each id must belong to the connection and pass the same org and site gates as today's replace-all.
- Once a connection has more than one enabled key, a request that carries `hostIds` is **refused with an explicit signal**, not silently downgraded: 409 `{ success: false, code: 'UNIFI_EXPLICIT_DELETES_REQUIRED', message: 'This connection has several API keys. Send removeMappingIds to remove mappings.' }`, before any write (no upsert, no delete). A host-scoped delete there could otherwise remove site B's mapping and its devices on a console where a failed key hid B while another key showed A; silently ignoring it would instead leave the caller believing the delete happened. *(Gate B)*
- The web sends `removeMappingIds` for cloud saves from W3.
- `GET /unifi/hosts` also returns `complete: false` when any key failed, and the mapping card says so.

**D10. Limits and copy.**
- At most **25** keys per connection (Open Decision 4).
- A label is 1–100 characters after trimming, unique per connection ignoring case.
- `key_last4` is set when a key is added or replaced through the API. A backfilled key gets it from the worker on its next successful sync, and it stays `NULL` until then.
- No route, log line or audit row ever contains a key.
- `baseUrl` cannot change while the connection holds more than one key: `/connect` returns 409 in that case (Task 1.3). This means a URL change never sends retained keys to a new destination *(advisor)*.

**D11. The last enabled key cannot be disabled or deleted** (409 `UNIFI_LAST_ENABLED_KEY`). Removing the whole connection is what Disconnect is for.

**D12. Rollout guards** *(advisor)*.
- **W1 code refuses to sync a connection with more than one enabled key.** It records a failed run and writes nothing, so a rollback from W2/W3 to W1 never sweeps based on one key alone.
- **Pre-W1 code:** a rollback to it reads the legacy column, which W1 keeps up to date for single-key connections. On a connection that already has several keys, pre-W1 code syncs from the first key only. Devices seen only through the other keys go stale; this is reversible on the next run of current code and documented in the W3 PR.
- **Old API instances during the W1 deploy** can still write a reconnect to the legacy column alone. While a connection has exactly one key, W1 and W2 reads compare the legacy plaintext with the key row's plaintext. If they differ, the legacy value is newer (in W1 and W2 nothing else writes the key row's secret), so it is adopted. **If the legacy column fails to decrypt, that means "no adoption"**: the key row is used as is, a warning is logged without the error detail, and the sync is not failed or marked partial for it. *(Gate B)* W3 removes this reconcile.

---

## Global Constraints

- RLS in the creating migration: `ENABLE` + `FORCE` + the four `breeze_partner_isolation_*` policies on `public.breeze_has_partner_access(partner_id)`, copied from `2026-06-28-unifi-network-integration.sql` §1.
- Add `['unifi_integration_keys', 'partner_id']` to `PARTNER_TENANT_TABLES` (`apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`), plus a forge test. No `org_id`, so it is **not** added to `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` or `CORE_TENANT_EXPORT_POLICY`. The partner purge already sweeps every table with a `partner_id` column (`services/tenantCascade.ts:2801-2860`). Grep all three lists in W1 to confirm they hold neither `unifi_integrations` nor `unifi_sync_runs`.
- **No column is added to any org-cascade table.** `unifi_site_mappings` and `unifi_devices` are unchanged.
- **Migration names** must sort after the newest committed migration **at implementation time**. Today the newest is `2027-01-27-150000-export-dataset-alert-index.sql`. Each migration uses the form `YYYY-MM-DD-HHMMSS-<slug>.sql`, is idempotent, and has no inner `BEGIN` or `COMMIT`. If it writes rows, it starts with `SELECT set_config('breeze.scope', 'system', true);`. Run `pnpm db:check-drift` after each.
- **Key AAD:** always `columnAad(UNIFI_KEY_COLUMN_SPEC)`, which evaluates to `'unifi_integrations.api_key_encrypted'`. Never pass the new table's name to `decryptForColumn`.
- **Secrets and errors:** no response includes `apiKeyEncrypted` or a plaintext key. Errors stored on rows or returned go through `safeErrorMessage` or are fixed strings, capped at 500 characters.
- **Network phase:** no DB context. At most `KEY_COLLECT_CONCURRENCY = 4` keys in flight. Keys not started before `KEY_COLLECT_BUDGET_MS = 200_000` fail as `skipped: sync time budget exhausted`. This stays under the worker's `lockDuration: 300_000` (`jobs/unifiWorker.ts:167`).
- **Key routes** carry `partnerScopes`, `writePerm` and `requireMfa()`, behind the blanket `canManagePartnerWidePolicies` guard. Web mutations go through `runAction`.
- **Locales:** new `en` keys go into all 8 locales (`apps/web/src/locales/*`). Never `t(cond ? a : b)`.
- **AI tools:** `aiToolsUnifi.ts` changes are read-only. AI-tool contract tests key `SAFE_WRITE_SITES` by line number, so re-run them after edits.
- **Coordination with #11503** (UniFi suggestions): it also changes `GET /unifi/hosts` and adds `POST /unifi/mappings/accept`. Whichever lands second rebases. The `/hosts` response stays additive, and the accept route is unaffected by D9 because it never deletes.

## Review Focus

1. **One console seen by two keys with different site subsets, one key failing.** The host is uncertain. No devices are written or swept for it, and nothing lands in the wrong org. Pinned in Task 2.2: `partial run: host a failed key reaches gets no devices and no sweep`.
2. **Saving mappings after a partial `/hosts` read.** No mapping is deleted. Pinned in Task 2.3 (`hostIds with two enabled keys returns 409 UNIFI_EXPLICIT_DELETES_REQUIRED and writes nothing`) and Task 3.3 (`cloud save sends removeMappingIds, never hostIds`).
3. **A device id reported under two hosts while a console moves into a Fabric.** The device stays on its current mapping and org, and is not swept. Pinned in Task 2.1 (`mergeKeyReads quarantines a device id seen under two hosts`) and Task 2.2 (`a quarantined device keeps its row and link`).
4. **A mapping remapped to another org while a sync is collecting.** That run writes nothing into the old org. Pinned in Task 2.3: `apply skips a mapping whose org changed since the snapshot`.
5. **Two concurrent "add key" requests at the cap, or with the same label.** The database ends with at most 25 keys and unique labels, enforced by a row lock and the unique index. Pinned in Task 3.1: `two concurrent addKey calls with one slot left produce 25 keys`.

## Gates

- **G1: removed at Gate B (2026-11-19).** The restricted-key / wrong-org question it parked is bug #12264, which exists today with one key. W2 ships the strict site-count rule unconditionally (Task 2.2), and #12264 verifies the API behaviour afterwards.
- **G2 (before W4):** W1 has been in a tagged release.

---

## Waves

| Wave | Delivers | Visible change | Depends on |
|---|---|---|---|
| **W1** | Table, verbatim backfill, registry entry, key service. The worker and routes read keys. Multi-key refusal; cloud-only scheduling. | None (parity) | — |
| **W2** | Multi-key collect + merge, failure bounds, strict site-count rule, per-key status + `key_results`, obsolete-write guards, `/hosts`, `/test` and the AI tool fanned out, `removeMappingIds` + the explicit `hostIds` refusal | Additive API fields | W1 |
| **W3** | Key CRUD + audit, keys card, per-key sync detail, explicit-delete saves, per-key health, docs + 8 locales | Users manage several keys | W2 |
| **W4** | Drop the legacy key column | None | W3, G2 |

Every wave is shippable alone. No connection can hold a second key until W3.

---

## Wave 1: keys table and single-key parity

### Task 1.1: Migration, Drizzle schema, RLS, registry

**Files:**
- Create: `apps/api/migrations/<after-newest>-unifi-integration-keys.sql`
- Modify: `apps/api/src/db/schema/unifi.ts`; also the schema barrel, if the unifi tables are re-exported there
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts` (+ `encryptedColumnRegistry.test.ts`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Create: `apps/api/src/__tests__/integration/unifiIntegrationKeys.integration.test.ts`

**Interfaces:**
- Produces the table `unifi_integration_keys`.
  - **Columns:**
    - `id uuid PK DEFAULT gen_random_uuid()`
    - `integration_id uuid NOT NULL`
    - `partner_id uuid NOT NULL REFERENCES partners(id)`
    - `label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 100)`
    - `api_key_encrypted text NOT NULL`
    - `key_last4 varchar(4)`
    - `is_enabled boolean NOT NULL DEFAULT true`
    - `status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','reauth_required','error'))`
    - `last_sync_at timestamptz`
    - `last_sync_status varchar(16) CHECK (last_sync_status IS NULL OR last_sync_status IN ('success','failed','skipped'))`
    - `last_sync_error text`
    - `last_ok_at timestamptz`
    - `hosts_seen integer`
    - `sites_seen integer`
    - `last_seen_host_ids text[]`
    - `created_by uuid REFERENCES users(id) ON DELETE SET NULL`
    - `created_at timestamptz NOT NULL DEFAULT now()`
    - `updated_at timestamptz NOT NULL DEFAULT now()`
  - **Constraints and indexes:**
    - `CONSTRAINT unifi_integration_keys_integration_fk FOREIGN KEY (integration_id, partner_id) REFERENCES unifi_integrations(id, partner_id) ON DELETE CASCADE`
    - `UNIQUE INDEX unifi_integration_keys_label_idx ON (integration_id, lower(btrim(label)))`
    - `INDEX unifi_integration_keys_integration_idx ON (integration_id, created_at, id)`
  - **Parent change:** add `CONSTRAINT unifi_integrations_id_partner_unique UNIQUE (id, partner_id)` in a `DO $$` guard.
- Produces the Drizzle table `unifiIntegrationKeys`, with camelCase fields. `lastSeenHostIds` is `text('last_seen_host_ids').array()`.
- Produces, in `encryptedColumnRegistry.ts`:
  - `export const UNIFI_KEY_COLUMN_SPEC = { table: 'unifi_integration_keys', column: 'api_key_encrypted', kind: 'text', aadTag: 'unifi_integrations.api_key_encrypted', description: 'UniFi Site Manager API key (#11808): moved verbatim from unifi_integrations.api_key_encrypted, keeps its column-bound AAD tag' } satisfies EncryptedColumnSpec`
  - the same spec added to `encryptedColumnRegistry`.

- [ ] **Step 1: Write the failing integration tests.** They run on real Postgres as `breeze_app`, except the migration re-run.
  - `backfills one key per cloud integration with the ciphertext unchanged`. Seed a cloud integration with `encryptSecret('k-123', { aad: 'unifi_integrations.api_key_encrypted' })` and `account_label = 'Main'`, then re-run the migration file to prove it is idempotent. Expect:
    - exactly one key row, with `label = 'Main'` and the parent's status (`connected` here);
    - its ciphertext byte-equal to the parent's;
    - `decryptSecret(row.apiKeyEncrypted, { aad: columnAad(UNIFI_KEY_COLUMN_SPEC) }) === 'k-123'`.
  - `copies the parent's status to the backfilled key`: parents with `reauth_required` and `error` give keys with the same status and the parent's `last_sync_error`; a parent status outside the key domain gives `pending`. *(Gate B)*
  - `labels a backfilled key Global when the account label is blank` (`'  '`).
  - `self-hosted integrations get no key row`.
  - `label unique ignoring case`: `'Macera'` then `'macera '` raises 23505.
  - `the composite FK refuses a key whose partner_id is not its integration's` (23503). Test both directions: a foreign `partner_id`, and the caller's own `partner_id` paired with another partner's `integration_id` *(advisor)*.
  - `deleting the integration cascades its keys`.
- [ ] **Step 2: Add the forge test** `unifi_integration_keys RLS: cross-partner forge enforcement (Shape 3)`, modelled on `rls-coverage.integration.test.ts:4836`. Partner A cannot insert, select, update or delete B's keys. Add the allowlist entry.
- [ ] **Step 3: Add the unit test** `unifi_integration_keys keeps the legacy unifi_integrations AAD tag (#11808)`. Assert `columnAad(UNIFI_KEY_COLUMN_SPEC) === 'unifi_integrations.api_key_encrypted'`. Then check that a value sealed by today's `upsertConnection` survives `transformEncryptedColumnValue` and still decrypts with that AAD.
- [ ] **Step 4: Run them and confirm they fail** because the table is missing. For the single-file integration invocation, see `docs/agents/testing.md`.
- [ ] **Step 5: Write the migration:**
  1. Elect system scope.
  2. Add the parent unique constraint.
  3. Create the table and its indexes, with RLS and its four policies.
  4. Backfill: `INSERT … SELECT i.id, i.partner_id, COALESCE(NULLIF(btrim(i.account_label), ''), 'Global'), i.api_key_encrypted, CASE WHEN i.status IN ('connected','reauth_required','error') THEN i.status ELSE 'pending' END, i.last_sync_error, i.last_sync_at FROM unifi_integrations i WHERE i.connection_type = 'cloud' AND i.api_key_encrypted IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unifi_integration_keys k WHERE k.integration_id = i.id)`. The key copies the **parent connection's status** (and `last_sync_error`), never a blanket `connected`: a connection that is `reauth_required` today must not show a healthy key after the migration *(Gate B)*. Leave `last_sync_status` `NULL`, because its domain differs from the parent's.
  5. Drop `unifi_integrations_cloud_key_chk` with `DROP CONSTRAINT IF EXISTS`. From here the key table holds the invariant, with D11 enforcing it in code.
- [ ] **Step 6: Add the Drizzle table and the registry entry.** Run `pnpm db:check-drift`. Expected: no drift.
- [ ] **Step 7: Run the tests. Expected: PASS.**
- [ ] **Step 8: Commit** `feat(unifi): unifi_integration_keys table with verbatim key backfill (#11808)`.

### Task 1.2: Key service (reads)

**Files:**
- Create: `apps/api/src/services/unifi/unifiKeyService.ts`
- Create: `apps/api/src/services/unifi/unifiKeyService.test.ts`

**Interfaces:**
- Consumes: `unifiIntegrationKeys`, `unifiIntegrations`, `encryptSecret`, `decryptSecret`, `columnAad`, `UNIFI_KEY_COLUMN_SPEC`, and `DbExecutor` (from `unifiConnectionService.ts`).
- Produces:
  ```ts
  export type UnifiKeyStatus = 'pending' | 'connected' | 'reauth_required' | 'error';
  export interface UnifiKeySummary {
    id: string; label: string; keyLast4: string | null; isEnabled: boolean; status: UnifiKeyStatus;
    lastSyncAt: Date | null; lastSyncStatus: 'success' | 'failed' | 'skipped' | null; lastSyncError: string | null;
    lastOkAt: Date | null; hostsSeen: number | null; sitesSeen: number | null; createdAt: Date;
  }
  export type UnifiSyncKey =
    | { id: string; label: string; apiKey: string; keyLast4: string | null; lastSeenHostIds: string[] | null }
    | { id: string; label: string; apiKey: null; decryptError: string; lastSeenHostIds: string[] | null };
  export function sealUnifiKey(apiKey: string): string;
  export function openUnifiKey(ciphertext: string): string | null;
  export function listKeys(db: DbExecutor, integrationId: string, partnerId: string): Promise<UnifiKeySummary[]>;
  export function getSyncKeys(db: DbExecutor, integrationId: string, partnerId: string): Promise<{ baseUrl: string; keys: UnifiSyncKey[] } | null>;
  ```
  - `listKeys` returns keys in `created_at, id` order and never selects `api_key_encrypted`.
  - `getSyncKeys` returns `null` unless an active **cloud** integration matches `(id, partnerId)`. Its keys are the enabled ones, in stable order.
  - **D12 reconcile:** when there is exactly one key and the legacy column holds a different plaintext, `getSyncKeys` writes the legacy ciphertext into the key row, resets `key_last4` to `NULL`, logs `[unifi] adopted a reconnect written by an older API instance`, and returns the adopted key. A legacy value that **fails to decrypt** means no adoption: return the key row unchanged, log `[unifi] legacy key unreadable; not adopted`, and do not surface it as a decrypt error or a failed sync. *(Gate B)*

- [ ] **Step 1: Write the failing tests.** Use the table-identity scripted DB from `unifiSyncService.test.ts:30-100`.
  - `listKeys never selects api_key_encrypted`.
  - `getSyncKeys returns enabled keys in created_at,id order, decrypted`.
  - `getSyncKeys returns null for a self-hosted integration`.
  - `getSyncKeys returns an undecryptable key as a decryptError entry, not omitted`.
  - `getSyncKeys adopts a newer legacy key when the connection has one key`.
  - `getSyncKeys does not adopt an undecryptable legacy value and returns the key row as an ok key` (no `decryptError`, no write). *(Gate B)*
  - `getSyncKeys never consults the legacy column when the connection has two keys`.
  - `sealUnifiKey output opens with the legacy AAD`.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiKeyService.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(unifi): key service reads for unifi_integration_keys (#11808)`.

### Task 1.3: Worker, scheduler and routes read keys (single-key parity)

**Files:**
- Modify: `apps/api/src/services/unifi/unifiConnectionService.ts`:
  - `upsertConnection` and `createSelfHostedIntegration` change.
  - `getDecryptedApiKey` and `getSyncCredentials` are deleted, once every caller has moved.
- Modify: `apps/api/src/jobs/unifiWorker.ts` (`processScheduler`, `processSyncIntegration`)
- Modify: `apps/api/src/routes/unifi/index.ts` (`GET /`, `POST /connect`, `POST /test`, `GET /hosts`)
- Modify: `apps/api/src/services/aiToolsUnifi.ts` (`hosts` action reads `getSyncKeys`)
- Test: `unifiConnectionService.test.ts`, `routes/unifi/index.test.ts`, `jobs/unifiWorker.test.ts` (create it if it does not exist), `aiToolsUnifi` tests

**Interfaces:**
- Consumes: `getSyncKeys`, `listKeys`, `sealUnifiKey` (Task 1.2).
- Produces: `upsertConnection(db, partnerId, fields)`, same signature, run inside `db.transaction`. In order:
  - It upserts the integration and **still writes `api_key_encrypted`**, which keeps a rollback across W1 safe (D12).
  - **Zero key rows:** it inserts one, with `label = fields.accountLabel?.trim() || 'Global'`, `status = 'connected'` and `key_last4`.
  - **Exactly one key row:** it replaces that row's ciphertext and `key_last4`, and sets `status = 'connected'`, `last_sync_error = NULL`, `last_seen_host_ids = NULL`.
  - **More than one:** it throws `UnifiMultiKeyError`. The route turns that into 409 `{ success: false, code: 'UNIFI_MULTI_KEY', message: 'This connection has several API keys. Manage them from the key list.' }`. This also pins `baseUrl` (D10).
- Produces: `createSelfHostedIntegration` deletes the integration's key rows in the same transaction (D6).
- Produces: `processScheduler` selects `is_active AND connection_type = 'cloud'`. `processSyncIntegration` returns without writing anything when `getSyncKeys` returns `null` for a non-cloud row. A cloud integration with zero enabled keys gets `markStatus(…, 'reauth_required', 'No enabled API key on this connection')`.
- Produces: `processSyncIntegration` in W1 with **more than one** enabled key writes a `failed` run with the error `This connection has several API keys; this server version supports one` and makes no other writes (D12). W2 replaces this branch.
- Produces: `GET /unifi` adds `keys: UnifiKeySummary[]` (`[]` for self-hosted).

- [ ] **Step 1: Write the failing tests.**
  - `upsertConnection still writes the legacy column`.
  - `upsertConnection inserts the first key labelled Global when no label is given`.
  - `upsertConnection replaces the single key's ciphertext on reconnect`.
  - `upsertConnection throws UnifiMultiKeyError with two keys`.
  - `createSelfHostedIntegration deletes the connection's key rows`.
  - Route: `POST /connect returns 409 UNIFI_MULTI_KEY when the connection has several keys`.
  - Route: `GET / includes keys without any secret field`.
  - Worker: `the scheduler queues cloud integrations only`.
  - Worker: `processSyncIntegration builds the client from the key row, not the legacy column`. Set legacy = `'old'` and key = `'new'`. Assert `createUnifiClient` receives `apiKey: 'new'`.
  - Worker: `W1 refuses a connection with two enabled keys and writes no devices`.
  - AI tool: `hosts reads the key through getSyncKeys and keeps the site-allowlist refusal`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** In W1, `/test`, `/hosts` and the AI tool use the single key. Their behaviour is otherwise unchanged.
- [ ] **Step 4: Run the touched files, plus `unifiSyncService.test.ts` and the AI-tool contract tests. Expected: PASS.**
- [ ] **Step 5: Commit** `refactor(unifi): read the Site Manager key from unifi_integration_keys (#11808)`.

**W1 PR:** `Refs #11808`. Run the **Integration Tests** job, which covers the RLS coverage contract and the forge test.

---

## Wave 2: multi-key sync engine

### Task 2.1: Per-key reads and the pure merge

**Files:**
- Create: `apps/api/src/services/unifi/unifiKeyMerge.ts`
- Create: `apps/api/src/services/unifi/unifiKeyMerge.test.ts`

**Interfaces:**
- Consumes: `UnifiClient`, `UnifiHost`, `UnifiSite`, `UnifiDeviceDto`, `UnifiIspMetrics`, `UnifiApiError`, `ispMetricsKey` (all from `unifiClient.ts`).
- Produces:
  ```ts
  export type SiteRead = Awaited<ReturnType<UnifiClient['listSitesForSync']>>;
  export type KeyRead =
    | { keyId: string; label: string; ok: true; hosts: UnifiHost[]; siteRead?: SiteRead;
        devicesByHost?: Map<string, UnifiDeviceDto[]>; metricsBySite?: Map<string, UnifiIspMetrics>; metricsError?: string }
    | { keyId: string; label: string; ok: false; error: string; authFailure: boolean; skipped?: true;
        siteRead?: SiteRead /* sites read succeeded before the failure */ };
  export interface MergedRead {
    hosts: UnifiHost[]; siteRead?: SiteRead; devicesByHost?: Map<string, UnifiDeviceDto[]>;
    metricsBySite?: Map<string, UnifiIspMetrics>; metricsError?: string;
    hostKeyIds: Map<string, string[]>; siteKeyIds: Map<string, string[]>;  // `${hostId}::${siteId}`
    coverageGapHostIds: Set<string>;      // D5(b)
    conflictingDeviceIds: Set<string>;    // D4
    failedKeys: Array<Extract<KeyRead, { ok: false }>>;
  }
  export const KEY_COLLECT_CONCURRENCY = 4;
  export const KEY_COLLECT_BUDGET_MS = 200_000;
  export function readKey(keyId: string, label: string, client: UnifiClient, opts: { mode: 'hosts' | 'mapping' | 'sync' }): Promise<KeyRead>;
  export function readKeys(keys: Array<{ id: string; label: string; client: UnifiClient | null; decryptError?: string }>,
    opts: { mode: 'hosts' | 'mapping' | 'sync'; now?: () => number; budgetMs?: number }): Promise<KeyRead[]>;
  export function mergeKeyReads(reads: KeyRead[]): MergedRead;
  ```
  - **`readKey` modes:**
    - `hosts`: calls `listHosts` only.
    - `mapping`: calls `listHosts` and `listSites`. Used by `/hosts` and the AI tool.
    - `sync`: calls hosts, then sites, then devices, all required. A metrics failure only sets `metricsError`.
  - **`readKey` failures:** `authFailure` is `err instanceof UnifiApiError && (err.status === 401 || err.status === 403)`.
  - **`readKeys`:** a `null` client (decrypt failure) becomes `ok: false`. Results come back in input order. A key not started before the budget runs out gets `skipped: true`.
  - **`mergeKeyReads`** applies D4 and D5(b). Input order is precedence.

- [ ] **Step 1: Write the failing tests.** All are pure.
  - `readKey marks 401 and 403 as auth failures and a TypeError as not`.
  - `readKey in hosts mode does not call sites, devices or metrics`.
  - `readKey keeps a key ok when only metrics fail`.
  - `readKey keeps siteRead when the devices read fails after sites succeeded`.
  - `readKeys returns input order when the later key finishes first`.
  - `readKeys never runs more than 4 keys at once`. Count with deferred fakes.
  - `readKeys records keys not started before the budget as skipped`. Use an injected `now`.
  - `readKeys turns a decrypt failure into a failed read without calling UniFi`.
  - `mergeKeyReads de-duplicates a host and a site seen by two keys; first key's payload wins`. `siteKeyIds` holds both keys.
  - `mergeKeyReads keeps sites with the same id on different hosts apart`. Two hosts each with site `default` give two sites.
  - `mergeKeyReads unions devices of one host across keys by unifiDeviceId`.
  - `mergeKeyReads quarantines a device id seen under two hosts`. The id is absent from both host lists and present in `conflictingDeviceIds`.
  - `mergeKeyReads marks a coverage gap when a key lists a host but returns no device group for it`.
  - `mergeKeyReads drops all metrics when any ok key's metrics read failed`.
  - `mergeKeyReads drops a bare-site-id metrics entry supplied by two keys`.
  - `mergeKeyReads counts a failed key's siteRead for the multi-site guard but not its devices`.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm --filter @breeze/api exec vitest run src/services/unifi/unifiKeyMerge.test.ts`.
- [ ] **Step 3: Implement.** Write a small in-file pool loop; add no new dependency.
- [ ] **Step 4: Run. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(unifi): per-key Site Manager reads and a deterministic merge (#11808)`.

### Task 2.2: `collectSyncData` on merged reads with failure bounds

**Files:**
- Modify: `apps/api/src/services/unifi/unifiSyncService.ts`
- Test: `apps/api/src/services/unifi/unifiSyncService.test.ts`

**Interfaces:**
- Consumes: `readKeys`, `mergeKeyReads`, `KeyRead`, `MergedRead` (Task 2.1) and `UnifiSyncKey` (Task 1.2).
- Produces:
  ```ts
  export interface KeyRunResult {
    keyId: string; label: string; status: 'success' | 'failed' | 'skipped'; authFailure: boolean;
    hostsSeen: number | null; sitesSeen: number | null; hostIds: string[] | null; error: string | null;
  }
  export function collectSyncData(
    keys: Array<{ id: string; label: string; client: UnifiClient | null; decryptError?: string; lastSeenHostIds: string[] | null }>,
    mappings: Array<{ id: string; unifiHostId: string; unifiSiteId: string }>,
    opts?: { now?: () => number; budgetMs?: number },
  ): Promise<CollectedSync>;
  // CollectedSync gains: keyResults: KeyRunResult[]; uncertainHostIds: Set<string> | 'all';
  //   protectedDeviceIds: Set<string> (= merged.conflictingDeviceIds); allKeysSucceeded: boolean
  ```
  - **`fatalError`** is set when `keys.length === 0` (`No enabled API key on this connection`) or when every key failed. The message lists each key as `"<label>": <error>`.
  - **`uncertainHostIds`** follows D5:
    - `'all'` if any failed key has neither a `siteRead` nor a `lastSeenHostIds`;
    - otherwise, the union of each failed key's reach (its `siteRead` hosts, else its snapshot) and `merged.coverageGapHostIds`.
  - **Uncertain-host check:** it runs first for each mapping. A mapping whose host is uncertain gets the error `site <siteId>: API key "<label>" failed this run and may reach host <hostId>, so its devices were not synced`. A coverage gap instead reads `… returned no device list for host <hostId> …`. In both cases `devices` is `undefined` and the resolved metrics stay as they are.
  - **Strict site-count rule** *(Gate B; ships before #12264 is answered)*: devices of a multi-site-capable host are attributed only when the site count from every key that lists the host agrees and, where the `/v1/hosts` payload carries the console's own site count, equals it. Otherwise the mapping gets the multi-site error. Confirm from a recorded `/v1/hosts` fixture whether that count exists (**not checked**); if it does not, the rule is "every key agrees" and #12264 stays open for the single-key case.
  - **Existing guards:** they run next, unchanged, on `merged.siteRead` and `merged.devicesByHost`. A site missing while some key failed reads `… is not listed by any working API key (failed: "<label>", …)`.
  - **Counters:** `hostsSeen = merged.hosts.length`. `sitesUnmapped` is recorded only when `allKeysSucceeded` holds and the merged site list is complete.
- `applySyncData`: the stale sweep skips every row whose `unifiDeviceId` is in `collected.protectedDeviceIds`, as well as today's `failedMappingIds`.

- [ ] **Step 1: Write the failing tests.** Use one `fakeClient` per key.
  - `two healthy keys: a site seen by both syncs once, each device written once`.
  - `partial run: host a failed key reaches gets no devices and no sweep` (Review Focus 1). Key A succeeds with `h1/s1 {d1}`. Key B fails with `lastSeenHostIds ['h1']`. Existing devices are `d1, d2`. Expect no `unifiDevices` writes for that mapping, no stale update for `d2`, an error that names `"B"`, and `status: 'partial'`.
  - `partial run: a failed key whose sites read succeeded bounds the failure to the hosts it listed`. B's sites list `h1` and its devices read fails. A mapping on `h2` syncs normally.
  - `partial run: host no failed key reaches syncs and sweeps normally`.
  - `partial run: a failed key that never succeeded makes every host uncertain`.
  - `coverage gap: a host one key lists without a device group is not swept`.
  - `a quarantined device keeps its row and link` (Review Focus 3). Device `d1` sits on mapping `m1`, and keys report it under `h1` and `h2`. Expect no write to `d1` and no stale update.
  - `multi-site check uses the merged site list`. A lists `h1/s1`, B lists `h1/s2`, and both succeed. The mapping on `h1/s1` gets the multi-site error.
  - `strict rule: keys disagreeing on a host's site count give the multi-site error`.
  - `strict rule: a key's site count below the console's /v1/hosts site count gives the multi-site error` (only if the field exists; otherwise record that it does not).
  - `every key failed: run failed, nothing written, error lists each key`.
  - `zero enabled keys: fatal fixed message, no client calls`.
  - `single key: identical SyncRunResult to the pre-change engine`. Re-run the existing fixtures through the new signature.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** In `syncIntegration` (the test wrapper), the `client` dependency becomes `keys`.
- [ ] **Step 4: Run `unifiSyncService.test.ts` and `unifiKeyMerge.test.ts`. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(unifi): merge every key's reads, bounding a failed key to the consoles it reaches (#11808)`.

### Task 2.3: Worker, per-key status, `key_results`, obsolete-write guards

**Files:**
- Create: `apps/api/migrations/<after-newest>-unifi-sync-runs-key-results.sql`
- Modify: `apps/api/src/db/schema/unifi.ts` (`unifiSyncRuns.keyResults: jsonb('key_results')`)
- Modify: `apps/api/src/services/unifi/unifiKeyService.ts` (`recordKeyResults`)
- Modify: `apps/api/src/services/unifi/unifiSyncService.ts` (`applySyncData`)
- Modify: `apps/api/src/jobs/unifiWorker.ts`
- Test: `unifiKeyService.test.ts`, `unifiSyncService.test.ts`, `unifiWorker.test.ts`, and a new `apps/api/src/__tests__/integration/unifiMultiKeySync.integration.test.ts`

**Interfaces:**
- Migration: `ALTER TABLE unifi_sync_runs ADD COLUMN IF NOT EXISTS key_results jsonb`. The table is partner-axis with no `org_id`, so no export policy is needed. Confirm with a grep.
- Produces `recordKeyResults(db: DbExecutor, a: { integrationId: string; partnerId: string; runStartedAt: Date; results: KeyRunResult[]; keyLast4ById: Map<string, string> }): Promise<void>`.
  - It runs one `UPDATE … WHERE id = $k AND integration_id = $i AND partner_id = $p AND (last_sync_at IS NULL OR last_sync_at < $runStartedAt)` per result.
  - A 0-row match (key deleted, or a newer run already recorded) is skipped, **not thrown**.
  - **success:** `status='connected'`, `last_sync_status='success'`, `last_ok_at=now`, `last_sync_error=NULL`. It also writes the counts and `last_seen_host_ids = hostIds`, and fills `key_last4` when it is `NULL`.
  - **failed:** `status = authFailure ? 'reauth_required' : 'error'` and `last_sync_status='failed'`, with the error.
  - **skipped:** `last_sync_status='skipped'` with the error; the status is left alone.
  - All three set `last_sync_at = $runStartedAt`.
- `applySyncData` gains a `phaseOneMappings` parameter. Inside its transaction, before any device write, it re-reads `unifi_site_mappings` for the integration. A mapping that is gone, or whose `org_id`, `site_id` or `updated_at` differs from the snapshot, gets the error `site <siteId>: mapping changed during the sync; its devices were not synced` and joins `failedMappingIds`. The run row also stores `key_results`, each entry being a `KeyRunResult` without `hostIds` or `authFailure`.
- **Worker:**
  - It builds one client per key (`null` on a decrypt error), calls `collectSyncData` outside any DB context, then applies.
  - In the status context it calls `recordKeyResults`, then `markSynced`, then sets the integration status per D6. Auth handling uses `keyResults.every(r => r.status !== 'success' && r.authFailure)`; the message regex goes.
  - The W1 multi-key refusal is removed.
- **PUT /unifi/mappings (D9, server half),** in this task because the worker change is what enables a second key in practice:
  - Accept `removeMappingIds?: z.array(z.string().guid()).max(500)`.
  - A listed id that does not belong to the connection is refused with 400 before any write. Each id must also pass the org and site gates.
  - When the connection has more than one enabled key, a body with `hostIds` returns 409 `UNIFI_EXPLICIT_DELETES_REQUIRED` before any write (D9). The web from W3 never sends `hostIds` for a cloud save, so only stale clients and direct API callers see it.

- [ ] **Step 1: Write the failing tests.**
  - `recordKeyResults skips a key deleted mid-run`.
  - `recordKeyResults never overwrites a newer run's result`.
  - `recordKeyResults fills key_last4 only when null`.
  - `apply skips a mapping whose org changed since the snapshot` (Review Focus 4).
  - `apply stores key_results without host ids`.
  - `worker: every key auth-failed (401 and 403) -> integration reauth_required`.
  - `worker: one of two keys failed -> integration connected, partial, error names the key`.
  - `PUT /mappings deletes only the listed removeMappingIds`.
  - `PUT /mappings refuses a removeMappingId of another connection`.
  - `hostIds with two enabled keys returns 409 UNIFI_EXPLICIT_DELETES_REQUIRED and writes nothing` (Review Focus 2, API half).
  - Integration test `unifiMultiKeySync.integration.test.ts`, on real Postgres. Seed two keys and run `applySyncData` with a partial `CollectedSync`. Assert that no `unifi_devices` row on an uncertain host changes, that a remapped mapping gets no devices, and that both key rows carry their statuses.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Write the migration, then the schema, then the code.** Run `pnpm db:check-drift`.
- [ ] **Step 4: Run. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(unifi): per-key sync status, key_results and stale-run guards (#11808)`.

### Task 2.4: `/hosts`, `/test` and the AI tool fan out

**Files:**
- Modify: `apps/api/src/routes/unifi/index.ts` (`GET /hosts`, `POST /test`)
- Modify: `apps/api/src/services/aiToolsUnifi.ts` (`hosts`)
- Modify: `apps/api/src/services/unifi/unifiMappingHosts.ts`
- Create: `apps/api/src/services/unifi/unifiHostsAcrossKeys.ts`
- Test: `routes/unifi/index.test.ts`, `unifiMappingHosts.test.ts`, `unifiHostsAcrossKeys.test.ts`, `aiToolsUnifi` tests

**Interfaces:**
- Produces `readHostsAcrossKeys(keys: UnifiSyncKey[], baseUrl: string): Promise<{ hosts: MappingHostRowWithKeys[]; omitted: MappingHostList['omitted']; keys: Array<{ id: string; label: string; ok: boolean; error?: string }>; complete: boolean }>`.
  - It calls `readKeys` in `mapping` mode, then `mergeKeyReads`, then `buildMappingHostList`.
  - The caller must hold no DB context.
  - If every key failed, it throws the first key's error, so the route keeps today's 502.
- `buildMappingHostList(hosts, sites, attribution?: { hostKeyIds; siteKeyIds })`. The optional third parameter attaches `keyIds` to each host and to each site.
- `GET /unifi/hosts` and the AI tool `hosts` action both call `readHostsAcrossKeys`. The AI tool keeps its site-allowlist refusal and its `bounded(...)` output.
- `POST /unifi/test` returns `{ success: boolean /* every enabled key ok */, hostsFound: number /* distinct */, keys: Array<{ id; label; success: boolean; hostsFound?: number; message?: string }> }`.

- [ ] **Step 1: Write the failing tests.**
  - `GET /hosts merges two keys and tags each host and site with keyIds`.
  - `GET /hosts returns complete:false and the failed key when one key fails`.
  - `GET /hosts returns 502 when every key fails`.
  - `GET /hosts reads keys inside the request context and calls UniFi outside it`. Mirror `index.test.ts:201`.
  - `POST /test reports per-key results`.
  - `AI hosts action fans out and still refuses a site-restricted session`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, plus the AI-tool contract tests. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(unifi): /hosts, /test and the AI hosts view read every key (#11808)`.

**W2 PR:** `Refs #11808`, `Refs #12264`. State that the strict site-count rule ships ahead of #12264's answer. Run **Integration Tests**.

---

## Wave 3: key management, UI and per-key health

### Task 3.1: Key CRUD in the service

**Files:**
- Modify: `apps/api/src/services/unifi/unifiKeyService.ts`. This includes removing the D12 legacy reconcile from `getSyncKeys`: from W3 on, the key row is the only source.
- Test: `unifiKeyService.test.ts`, `unifiIntegrationKeys.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const UNIFI_MAX_KEYS = 25;
  export type UnifiKeyErrorCode = 'UNIFI_KEY_LIMIT' | 'UNIFI_KEY_LABEL_TAKEN' | 'UNIFI_LAST_ENABLED_KEY' | 'UNIFI_NOT_CLOUD' | 'UNIFI_KEY_NOT_FOUND';
  export class UnifiKeyError extends Error { readonly code: UnifiKeyErrorCode }
  export function addKey(db: DbExecutor, a: { integrationId: string; partnerId: string; label: string; apiKey: string; seenHostIds: string[]; createdBy: string | null }): Promise<UnifiKeySummary>;
  export function updateKey(db: DbExecutor, a: { integrationId: string; partnerId: string; keyId: string; label?: string; isEnabled?: boolean; apiKey?: string; seenHostIds?: string[] }): Promise<UnifiKeySummary>;
  export function deleteKey(db: DbExecutor, a: { integrationId: string; partnerId: string; keyId: string }): Promise<boolean>;
  ```
  - `deleteKey` returns `false` when the key is already gone.
  - `addKey` stores `seenHostIds` as `last_seen_host_ids`, so a new key's first failure is bounded (D5).
  - Replacing a key with `apiKey` re-seals it, sets `key_last4`, sets `status='pending'`, clears `last_sync_error`, and sets `last_seen_host_ids = seenHostIds`.
  - **Concurrency:** all three run in `db.transaction`. Each starts with `SELECT … FROM unifi_integrations WHERE id=$i AND partner_id=$p AND is_active FOR UPDATE`, which serializes the cap, label and last-enabled checks. A 23505 from the label index maps to `UNIFI_KEY_LABEL_TAKEN`. Labels are trimmed.
  - **Errors:** a self-hosted integration throws `UNIFI_NOT_CLOUD`.

- [ ] **Step 1: Write the failing tests.**
  - `addKey locks the integration row before counting`.
  - `addKey refuses the 26th key with UNIFI_KEY_LIMIT`.
  - `addKey maps 23505 to UNIFI_KEY_LABEL_TAKEN`.
  - `addKey refuses a self-hosted integration`.
  - `updateKey refuses to disable the last enabled key`.
  - `deleteKey refuses the last key`, and `deleteKey returns false for an unknown key`.
  - `replacing a key resets status and stores the new host snapshot`.
  - `getSyncKeys no longer adopts the legacy column`.
  - Integration: `two concurrent addKey calls with one slot left produce 25 keys` (Review Focus 5). Race two system contexts.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(unifi): add, update and remove Site Manager keys (#11808)`.

### Task 3.2: Key routes and audit

**Files:**
- Create: `apps/api/src/routes/unifi/keys.ts`. It is a sub-router mounted from `routes/unifi/index.ts`, because that file is near the ~500-line guideline.
- Create: `apps/api/src/routes/unifi/keys.test.ts`
- Modify: `apps/api/src/services/unifi/unifiMappingWrites.ts` (`writeUnifiKeyAudit`)
- Modify: `apps/web/src/locales/*/admin.json` (8 locales, audit action labels)

**Interfaces:**
- **Routes.** Every write route carries `partnerScopes, writePerm, requireMfa()` and uses the existing `resolvePartnerId` and `getConnection`.
  - `GET /unifi/keys` → `{ keys: UnifiKeySummary[] }`, with `partnerScopes, readPerm`.
  - `POST /unifi/keys`, body `{ label: z.string().trim().min(1).max(100), apiKey: z.string().min(1).max(500) }`.
    1. Validates with `listHosts` against the connection's stored `baseUrl`, outside any DB context. A 401/403 returns 400 `Could not validate the UniFi API key.`; any other failure returns 502, as `/connect` does.
    2. Calls `addKey` with `seenHostIds` taken from that read.
    3. Calls `enqueueUnifiSync(conn.id, partnerId, 'manual')`.
    4. Returns 201 `{ key }`.
  - `PATCH /unifi/keys/:keyId`, body `{ label?, isEnabled?, apiKey? }`; `.refine` requires at least one field. A new `apiKey` is validated the same way first.
  - `DELETE /unifi/keys/:keyId` → `{ success: true }`, also when the key is already gone.
  - `POST /unifi/keys/:keyId/test` → `{ success, hostsFound, sitesFound, message? }`.
  - **Errors:** `UnifiKeyError` maps to 409 `{ success: false, code, message }`, except `UNIFI_KEY_NOT_FOUND` (404) and `UNIFI_NOT_CLOUD` (400).
- **Audit actions:** `unifi.key.add`, `unifi.key.update`, `unifi.key.remove`. Details: `{ integrationId, keyId, label, previousLabel?, changed: Array<'label' | 'enabled' | 'secret'> }`. Never a key or its last four.

- [ ] **Step 1: Write the failing tests.**
  - `POST /keys validates outside the request DB context`.
  - `POST /keys returns 400 on a 401 from UniFi and stores nothing`.
  - `POST /keys returns 409 UNIFI_KEY_LABEL_TAKEN`.
  - `PATCH /keys rejects an empty body`.
  - `DELETE /keys/:id is idempotent`.
  - `every write route requires MFA`.
  - `the audit row never contains the key or its last four`.
  - `responses never include apiKeyEncrypted`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** Add the audit labels to all 8 `admin.json` files.
- [ ] **Step 4: Run `keys.test.ts`, `index.test.ts` and the locale tests. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(unifi): API key management routes with audit (#11808)`.

### Task 3.3: Web keys card, explicit-delete saves, per-key sync detail

**Files:**
- Create: `apps/web/src/components/integrations/unifi/ApiKeysCard.tsx` (+ `ApiKeysCard.test.tsx`)
- Create: `apps/web/src/components/integrations/unifi/useUnifiKeys.ts`. This is a separate hook because `useUnifiIntegration.ts` is already 870 lines.
- Modify: `unifiTypes.ts`. Add `UnifiKeySummary`, `UnifiStatus.keys`, `keyIds` on hosts and sites, `HostsResponse.complete`, and `SyncRun.keyResults`. Update the response parsers too, not only the types.
- Modify: `useUnifiIntegration.ts`. A cloud save computes `removeMappingIds` from the saved mappings the user cleared and **never sends `hostIds`**. The self-hosted save is unchanged. A 409 `UNIFI_EXPLICIT_DELETES_REQUIRED` (a stale tab) is shown as an error asking for a reload, never swallowed.
- Modify: `SiteMappingCard.tsx` (a "via <label>" chip per site, and `unifi-hosts-incomplete-banner` when `complete === false`)
- Modify: `SyncHistoryCard.tsx` (expandable per-key results)
- Modify: `ConnectedSummaryCard.tsx`. The reauth banner points at the keys card instead of Disconnect.
- Modify: `apps/web/src/components/integrations/UnifiIntegration.tsx` (render `ApiKeysCard` for cloud)
- Modify: `apps/web/src/locales/*/integrations.json` (8 locales)
- Test: `UnifiIntegration.test.tsx`

**Interfaces:**
- `ApiKeysCard` props: `{ keys: UnifiKeySummary[]; hosts: UnifiHostOption[]; mappings: SavedMapping[]; hostsComplete: boolean; onChanged: () => void }`.
  - Each row shows the label, `••••<last4>` (or `••••` while it is `null`), a status badge, the last successful sync, and the hosts and sites seen.
  - Each row also shows **unique sites**: sites whose `keyIds` hold only this key. The count is labelled incomplete when `hostsComplete` is false.
  - Row actions: Rename, Replace key, Disable/Enable, Test, Remove.
  - The add form takes a label and a key.
  - Remove and Disable confirm first, listing the mapped sites visible only through this key; those sites stop syncing.
- `data-testid`s: `unifi-keys-card`, `unifi-key-row-<id>`, `unifi-key-add`, `unifi-key-remove-<id>`, `unifi-hosts-incomplete-banner`.
- Every mutation goes through `runAction`, using the CLAUDE.md catch pattern.

- [ ] **Step 1: Write the failing tests.**
  - `cloud save sends removeMappingIds, never hostIds` (Review Focus 2, web half).
  - `self-hosted save still sends hostIds`.
  - `the hosts parser keeps keyIds and complete`. Test the parser itself: a fetch-mocked component test misses dropped fields.
  - `ApiKeysCard counts unique sites per key and marks the count incomplete on a partial read`.
  - `removing a key lists the mapped sites only that key sees`.
  - `a rejected key shows the reauth badge`.
- [ ] **Step 2: Run them and confirm they fail.** Run `pnpm --filter @breeze/web exec vitest run src/components/integrations/unifi/ApiKeysCard.test.tsx src/components/integrations/UnifiIntegration.test.tsx`.
- [ ] **Step 3: Implement.** Add the `en` keys and the other 7 locales.
- [ ] **Step 4: Run the web tests plus `keyUsage.test.ts` and the locale parity tests. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(web): manage several UniFi Site Manager keys per connection (#11808)`.

### Task 3.4: Per-key connection health

**Files:**
- Modify: `apps/api/src/services/connectionHealth/sources/unifi.ts`
- Modify: `apps/api/src/services/integrationStates.ts` (`unifiKeyHealth`)
- Test: `connectionHealth/sources/sources.test.ts`, `__tests__/integration/connectionHealthSourceIndexes.integration.test.ts`

**Interfaces:**
- Produces `unifiKeyHealth(row: { integrationActive: boolean; isEnabled: boolean; status: string; lastSyncStatus: string | null }): HealthVerdict`, mapping a key row to a verdict:

  | Key row | Verdict |
  |---|---|
  | integration inactive, or key disabled | `RETIRED` |
  | `status = 'reauth_required'` | `permanent('reauth_required')` |
  | `status = 'error'`, or `lastSyncStatus = 'failed'` | `transient('sync_failed')` |
  | `status = 'connected'` and `lastSyncStatus = 'success'` | `HEALTHY` |
  | anything else | `UNKNOWN` |
- **The source** keeps the integration rows exactly as they are: same `sourceId`, same verdict, same stale arm. It adds one key row per key, read from the keys table joined to its integration.
  - `tables: ['unifi_integrations', 'unifi_integration_keys']`.
  - A key observation has `sourceId` = the key id, `displayName` = `` `UniFi: ${label}` ``, and `rawDetail` = that key's `last_sync_error`.
  - A deleted key stops resolving, and its tracked incident retires. **Not checked:** how `connectionHealth/transitions.ts` treats a vanished tracked id. Step 1 pins it.

- [ ] **Step 1: Write the failing tests.**
  - `one failing key of two is broken while the integration stays healthy`.
  - `a disabled key retires`.
  - `a deleted key's tracked incident resolves`. Read `transitions.ts` first. If a vanished id does not resolve, emit a retired observation for tracked ids whose key is gone.
  - `the integration observation keeps its source id`.
  - Index contract: EXPLAIN-check the new broken query, or add it to the not-index-backed list with a comment.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(connection-health): one UniFi observation per API key (#11808)`.

### Task 3.5: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/features/unifi-integration.mdx`. Replace the "One key per partner" caution (`:71`) and the copy at `:18`, `:32` and `:68`.

- [ ] **Step 1:** Rewrite the cloud section to cover:
  - one connection, with one key per scope (Independent sites, plus one per Fabric);
  - how to add, replace and remove a key;
  - how a failing key shows;
  - that a site seen by two keys syncs once;
  - that saving mappings never deletes a site hidden by a failing key.
- [ ] **Step 2:** Run the `apps/docs` build that CI runs. Expected: PASS.
- [ ] **Step 3: Commit** `docs(unifi): several Site Manager keys per connection (#11808)`.

**W3 PR:** `Refs #11808`. Run the `feature-testing` skill on a wt-stack with two keys. For the second key, point at a fake base URL that returns 401, so the partial run, the incomplete banner and the explicit-delete save all show. The PR body documents the pre-W1 rollback caveat (D12).

---

## Wave 4: drop the legacy column (gate G2)

### Task 4.1: Remove `unifi_integrations.api_key_encrypted`

**Files:**
- Create: `apps/api/migrations/<after-newest>-unifi-integrations-drop-legacy-key.sql`
- Modify: `apps/api/src/db/schema/unifi.ts` and `apps/api/src/services/unifi/unifiConnectionService.ts`. Also `apps/api/scripts/migrationReplayTenantFixture.ts`, if it names the column.

- [ ] **Step 1: Write the failing test** `upsertConnection writes no legacy key column`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3:** Write the migration (`ALTER TABLE unifi_integrations DROP COLUMN IF EXISTS api_key_encrypted;`). Remove the field and the write. Run `pnpm db:check-drift`.
- [ ] **Step 4:** Grep `apps/api/src` and `apps/api/scripts` for `unifi_integrations` uses of `api_key_encrypted`. Expected: none. Run the UniFi tests. Expected: PASS.
- [ ] **Step 5: Commit** `chore(unifi): drop the legacy single-key column (#11808)`.

---

## Gate B changes (Todd, 2026-11-19)

1. **Backfill copies the parent connection's status** (and `last_sync_error`), not a blanket `connected`. Task 1.1.
2. **A legacy column that fails to decrypt during the D12 reconcile is "no adoption"**, not a failed sync. D12, Task 1.2.
3. **With two keys, a `hostIds` delete returns an explicit signal** (409 `UNIFI_EXPLICIT_DELETES_REQUIRED`, nothing written) instead of being silently ignored. D9, Tasks 2.3 and 3.3.
4. **G1 removed.** The restricted-key / wrong-org question is bug #12264. The strict site-count rule ships first, in W2 (Task 2.2).

Open Decisions 1–8 below were accepted as recommended.

## Open Decisions

1. **D5 failure bound: per-host reach vs. one blunt rule.** The blunt alternative suspends all device attribution and sweeping whenever any key fails. *Recommend per-host reach.* The blunt rule lets one dead Fabric key stop every other customer's device sync, which defeats the isolation the issue asks for. Per-host reach costs one `text[]` per key, plus the coverage-gap set.
2. **Explicit deletes (D9) vs. keeping `hostIds` and just warning on partial reads.** *Recommend explicit deletes.* A warning can be clicked past, and a deleted mapping takes its devices with it. Explicit ids also make the self-hosted path easy to move later. #11503's accept route never deletes, so it is unaffected.
3. **AAD: keep the column-bound legacy tag (D3) vs. switch to row-bound AAD.** *Recommend the legacy tag.* It gives the same protection as today, needs no backfill job, and leaves no window without a key. Row binding would stop a database writer from swapping ciphertexts between two of a partner's key rows. Today's column has that same exposure, so row binding can come later as a rotation.
4. **Key cap of 25 per connection.** *Recommend 25.* Each key costs up to four reads per 30-minute sync, and 25 keys fit the 200 s budget at concurrency 4. Not checked: whether Site Manager rate-limits per key or per account. If per account, the total is still about 100 reads per 30 minutes.
5. **Store `key_last4`?** *Recommend yes.* Without it, two similarly labelled keys are hard to tell apart when replacing one. Four characters of a high-entropy key reveal nothing useful, and they never appear in audit rows or logs.
6. **Last enabled key: refuse (D11) vs. allow a zero-key connection.** *Recommend refuse.* Disconnect already covers "remove everything", and a zero-key connection only produces failed syncs.
7. **Duplicate keys: no fingerprint vs. a stored HMAC fingerprint.** *Recommend no fingerprint.* The merge already de-duplicates, and the card shows a key with 0 unique sites. Identical visible sites do not prove identical device scope anyway. A fingerprint is derived secret material that would need its own key management.
8. **Per-key health in W3 alongside the integration observation (D7) vs. per-key only, later.** *Recommend W3 plus the integration observation.* No second key should exist without an alert path. Keeping the integration observation keeps existing incidents and still catches apply failures that no key-level state shows.

## Self-review notes

- **Requirement coverage:**
  - data model: D1, Task 1.1;
  - migrating the single key: D3, Task 1.1;
  - fan-out, merge and de-dupe: D4, Tasks 2.1–2.2;
  - per-key health and status in the UI: Tasks 2.3, 3.3 and 3.4;
  - partial-failure semantics: D5, D6, Tasks 2.2–2.3;
  - tests: every task;
  - independently shippable waves: the Waves table;
  - Open Decisions: listed above, numbered with recommendations.
- **Repo rules:** the table is partner-axis and the connection is partner-owned, so it is Partner-wide first and needs no `org_id` justification. RLS lands in the creating migration. The cascade and export lists are checked, and no org-cascade column is added. Migration naming is covered in Global Constraints.
- **Out of scope:**
  - cloud and self-hosted on one partner (still either/or);
  - adding `unifi_collectors.local_api_key_encrypted` to the rotation registry (fact 2; file as a follow-up);
  - #11503's suggestions.
