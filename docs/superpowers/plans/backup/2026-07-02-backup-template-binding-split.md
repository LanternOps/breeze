# Partner-Wide Backup: Template/Binding Split — Design (#2132)

> Part of the partner-wide-first epic (#2135). Backup is one of two features
> (`backup`, `onedrive_helper`) excluded from the dual-ownership playbook because
> `backup_configs` carries per-org storage credentials. This doc designs the split
> that lets partner-wide config policies drive backup anyway: a partner-ownable
> **TEMPLATE** (schedule/retention/mode — no secrets) resolved per-org against an
> org-owned storage **BINDING** (provider + credentials). Devices in orgs without a
> binding surface as "backup not configured" instead of being silently skipped.
>
> Status: **design — not implemented**. Research notes: session 2026-07-02.

---

## 1. Current state (what makes backup special)

- `backup_configs` (`apps/api/src/db/schema/backup.ts:60`) conflates both halves in
  one org-owned row: template-ish fields (`type`, legacy `schedule`/`retention`,
  `compression`, `encryption`) AND the binding (`provider`, `providerConfig` jsonb
  with plaintext bucket/keys, `providerCapabilities`, `isActive`).
- The de facto template already exists elsewhere: `config_policy_backup_settings`
  (`schema/configurationPolicies.ts:251`) holds `schedule`, `retention`, `paths`,
  `backupMode`, `targets`, 1:1 with a `config_policy_feature_links` row — but is
  forced `org_id NOT NULL` purely as an artifact of feature-link ownership. The
  feature link's `featurePolicyId` points at `backup_configs.id` (the binding!).
- `backupWorker.processCheckSchedules` fans out per org with an active backup
  feature link, resolves per-device via `resolveAllBackupAssignedDevices(orgId)`,
  and **warn-and-skips** devices whose resolution yields no `configId`
  (`jobs/backupWorker.ts:161`) — the silent-skip behavior #2132 wants replaced.
- Partner-wide is blocked in three places today: `ORG_SCOPED_ONLY_FEATURES`
  (`routes/configurationPolicies/featureLinks.ts:45`), a throw in
  `decomposeInlineSettings` case `'backup'` (`services/configurationPolicy.ts:576`),
  and `backup` absent from `PARTNER_LINKABLE_FEATURE_TYPES`.
- Execution tables (`backup_jobs`, `backup_snapshots`, `backup_chains`,
  `restore_jobs`, `c2c_backup_configs.storage_config_id`, BMR/recovery services,
  retention, AI tools, compliance report) all FK or query `backup_configs`
  directly, independent of the config-policy system. **Restructuring
  `backup_configs` is therefore off the table** — it stays, as the binding.

## 2. Design

### 2.1 New table: `backup_templates` (the partner-linkable template)

Dual-ownership per the epic playbook (`org_id XOR partner_id`, `_one_owner_chk`
CHECK, dual-axis RLS, partner index — copy a `2026-07-01-*-partner-ownership.sql`
migration):

```
backup_templates
  id              uuid PK
  org_id          uuid NULL FK organizations   -- XOR
  partner_id      uuid NULL FK partners        -- XOR
  name            varchar(200) NOT NULL
  backup_mode     backup_mode enum NOT NULL    -- file | hyperv | mssql | system_image
  schedule        jsonb NOT NULL
  retention       jsonb NOT NULL
  paths           jsonb
  targets         jsonb
  compression     boolean NOT NULL DEFAULT true
  require_encryption boolean NOT NULL DEFAULT false
  created_at / updated_at
```

Notes:
- `backup_mode` (the enum `config_policy_backup_settings` uses) is the operative
  "kind of backup" — `backup_configs.type` is not used for dispatch decisions and
  is left alone (deprecate later, out of scope).
- `compression` moves to the template (behavior intent). `require_encryption` is
  the template's *intent*; the binding's `providerCapabilities` is the *capability*
  it is validated against at dispatch (mismatch = per-device failure state, §2.4).
- Registered in `PARTNER_LINKABLE_FEATURE_TYPES` + the dual-axis branch of
  `validateFeaturePolicyExists`; removed from `FEATURE_TABLE_MAP` org-only path and
  from `ORG_SCOPED_ONLY_FEATURES`. `config_policy_feature_links.featurePolicyId`
  for `backup` links now points at `backup_templates.id`, **not** `backup_configs.id`.
- Writes gated on `canManagePartnerWidePolicies` for partner-owned rows; create
  routes take `ownerScope`; update schema `.omit({ ownerScope: true })` — the
  standard playbook.

### 2.2 `backup_configs` becomes the BINDING — minimal change

Stays org-owned (`org_id NOT NULL`), single-axis org RLS, all existing FKs intact
(`backup_jobs.configId`, `backup_snapshots.configId`, `backup_chains`, c2c org-match
trigger, BMR/recovery reads). Additions:

- `is_default boolean NOT NULL DEFAULT false` + partial unique index
  `ON backup_configs (org_id) WHERE is_default AND is_active` — each org designates
  one default storage destination.
- Legacy `schedule`/`retention` columns: stop writing them; the two remaining
  fallback readers (`recoveryBootstrap.ts:210`, `aiToolsBackup.ts`) are migrated to
  template-based resolution. Columns dropped in a later cleanup migration.
- `encryption_key` (text) is dead (no readers/writers) — drop in the same cleanup.

### 2.3 Binding resolution: org default, mapping table later if needed

**v1 rule: template → device's org → that org's default active binding.** One
storage destination per org matches the MSP reality (one storage account per
client) and keeps the resolver trivial. A per-template override table
(`backup_template_bindings(template_id, org_id, config_id)` unique on
`(template_id, org_id)`) is the designed escape hatch if a partner ever needs
"SQL backups to a different bucket" — the resolver gets a single seam
(`resolveBindingForOrg(templateId, orgId)`) so adding the override later is
additive, not a rework.

### 2.4 Worker/dispatch changes + "backup not configured"

`processCheckSchedules` (partner fan-out follows the patch-rings precedent,
`services/configPolicyPatching.ts` — partner template, per-device-org execution):

1. Enumerate orgs with an active backup feature link **including partner-wide
   policies fanned out to the partner's orgs** (never `eq(orgId, ...)` alone).
2. Per device: resolve template (feature-link hierarchy, unchanged mechanics) →
   resolve binding via `resolveBindingForOrg`.
3. Template resolved but **no binding** → do NOT create a job; record the device in
   the org's coverage-gap set. No more warn-and-skip.
4. Template + binding → create `backup_jobs` row exactly as today
   (`configId` = the resolved binding id — execution rows keep the DEVICE org,
   matching the sensitive-data precedent from phase 2).
5. Dispatch validates `require_encryption` against the binding's
   `providerCapabilities`; failure = failed job with an explicit error, not a skip.

Because partner-wide feature links resolve inside worker paths, the resolver runs
under a **system DB context** (the heartbeat probe-config pattern, #1105) — an
org-scoped RLS context cannot see partner-owned template rows.

**Surfacing** (extend, don't invent): `GET /backup/status/:deviceId`
(`routes/backup/dashboard.ts:252`) grows a reason discriminator —
`coverage: 'protected' | 'no_template' | 'no_binding'` (keep `protected: boolean`
for back-compat). Org dashboard adds an `unboundDevices` count next to
`protectedDevices`. `DeviceBackupTab.tsx` renders "Backup policy assigned — no
storage destination configured for this organization" with a CTA to the org's
destination settings; `BackupDashboard.tsx` shows the gap count. A synthetic
"backup not configured" alert-rule condition is possible later but not v1.

### 2.5 UI

- **Policy editor** (`featureTabs/BackupTab.tsx`): stops picking a `backup_configs`
  row; edits the linked `backup_templates` row (schedule/retention/mode/paths/
  targets/compression/require_encryption). Standard create-only ownerScope selector
  + "All orgs" badge (pattern: `components/software/PolicyForm.tsx`). Works on
  partner-wide policies — the 400 gate is removed.
- **Org settings → Backup destination**: existing backup-config CRUD UI reframed as
  the org's storage destination(s), with a "default destination" toggle. Secrets
  redaction behavior (`redactProviderConfig`/`preserveSecretFields`) unchanged.

### 2.6 Migration & back-compat

One migration (idempotent, playbook shape) + a code cutover in the same PR:

1. Create `backup_templates` + RLS + CHECK; add `backup_configs.is_default` and
   backfill `is_default = true` for each org's single active config (oldest active
   row wins when an org has several; `RAISE WARNING` with counts).
2. For every existing backup feature link: synthesize a `backup_templates` row
   (org-owned) from its `config_policy_backup_settings` row (fallback: the linked
   `backup_configs.schedule/retention` legacy columns), repoint
   `featurePolicyId` → new template id. Report row counts.
3. `config_policy_backup_settings` stops being written for new links (template owns
   the fields); rows retained for forensic/back-compat, dropped in a later cleanup.
   `decomposeInlineSettings`/`assembleInlineSettings` case `'backup'` route to the
   template table.
4. Existing per-device behavior is preserved by construction: every org that had a
   working link ends with template + default binding = same jobs as before.

### 2.7 Explicitly out of scope (follow-up issues)

- **Encrypting `providerConfig` at rest.** It is plaintext jsonb today; the
  `secretCrypto.ts` AES-256-GCM column pattern (used by `psa_connections.credentials`)
  is the right target, but re-encrypting existing rows is separable scope. File as
  its own issue — the binding table boundary makes it a clean drop-in later.
- Dropping `backup_configs.type`, legacy `schedule`/`retention`, `encryption_key`;
  deleting deprecated `backup_policies`.
- Per-template binding overrides (§2.3 escape hatch).
- `onedrive_helper` gets the same treatment in a separate design if wanted.

## 3. Tests (per playbook)

- `DUAL_AXIS_TENANT_TABLES` registration for `backup_templates` +
  `backupTemplatesPartnerRls.integration.test.ts` (cross-partner forge 42501, XOR
  23514, org isolation).
- **Fan-out integration test** against real Postgres: partner-owned template +
  org A with default binding + org B without → scheduler creates a job for A's
  device (org = device's org), creates NO job for B's device, and B's device
  reports `coverage: 'no_binding'`.
- Unit: `resolveBindingForOrg` (default selection, inactive excluded, none),
  require_encryption vs capabilities validation, migration backfill idempotency.

## 4. Open questions for review

1. Is one default binding per org acceptable for v1 (§2.3), or do we want the
   override mapping table from day one?
2. Keep `config_policy_backup_settings` rows for back-compat (§2.6.3) or migrate +
   drop the table in the same release?
3. Should `no_binding` devices also raise a synthetic alert in v1, or is
   dashboard/status surfacing enough?
