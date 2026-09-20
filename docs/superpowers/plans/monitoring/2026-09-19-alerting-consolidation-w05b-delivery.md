---
tracking_issue: LanternOps/breeze#6367
wave_issue: (set by feature-lifecycle after registration)
branch: (set by feature-lifecycle after registration)
---

# Alerting Consolidation — W05b Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every notification traces to one delivery decision a technician can read on screen: one resolver (`resolveDelivery`) used by the dispatcher, by the monitor editor's Notify preview and by an AI tool; an explicit, editable "Everything else" routing row per partner (and optionally per org) replaces the hidden all-enabled-channels fallback; routing rows gain `monitorKinds` and an escalation policy; escalation policies get CRUD; `/alerts/delivery` replaces `/alerts/channels`.

**Architecture:** A pure-ish service module `services/delivery/resolveDelivery.ts` owns the precedence (monitor none → monitor channels → transitional legacy override → routing rows → org default row → partner default row → none) and is the only place that reads `notification_routing_rules` for a delivery decision. The dispatcher (`notificationDispatcher.ts`) builds a `ResolveDeliveryInput` from the alert and calls it; `GET /alerts/delivery/resolve` calls it under the request's RLS context; the `manage_delivery` AI tool calls it too. A migration writes the default rows from the exact current fallback query so day one is behavior-identical, and from then on a new channel is opt-in. The web `/alerts/delivery` page composes three list sections (Channels · Routing · Escalation policies), each saved through a row drawer via `runAction`.

**Tech Stack:** Hono + Drizzle + Zod (API), hand-written SQL migration, Vitest (unit, RLS, integration against real Postgres via `pnpm test-stack up`), Astro + React + react-i18next (web, 8 locales), Starlight MDX (docs).

**Spec:** docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md — §End state "Navigation" (tab strip), §End state "Monitors" (Notify card), §End state "Delivery", §Data model "Routing", §Delivery resolution (all of it, including "Transitional" and "Migration"), §Tenancy and safety (default rows dual-owned, write-coverage allowlists), §AI / MCP tools (`manage_notification_channels` row), §Docs and release notes, §Waves W05b row.

## Ordering assumptions (read first)

1. **Base:** `main` at `b8dd148bd8` or later. All file:line references below were verified against that commit on 2026-09-19; re-verify with `rg -n` before editing if the base has moved.
2. **W05a is independent and may land before or after this wave.** Two touch points overlap:
   - W05a removes `conditionTypes`/`deviceTags` from `apps/api/src/routes/alerts/routing.ts:26-45`. Task 3 below writes the *end-state* schema (severities + monitorKinds + siteIds, `.strict()`), so it is correct whether W05a landed first or not. If W05a landed, the diff is smaller; do not re-add the fields.
   - W05a deletes the `/monitoring/*` redirect stubs, including `apps/web/src/pages/monitoring/delivery.astro` (today: `return Astro.redirect('/alerts/channels');` — a 302, not 301). Task 9: if the file still exists, repoint it to `/alerts/delivery`; if W05a deleted it, skip.
3. **W05c1 depends on this wave** for: `resolveDelivery` (D6: the converter compares resolved eligible channels AND escalation before/after for every affected device/site, including kind-less legacy → kind-specific routing; delivery rails/channels/policies participate in preview freshness), `notification_routing_rules.escalation_policy_id`, and the `legacy_override` branch (W05c1 Task 8 adds `retired_at IS NULL` to BOTH Task 4 lookups (`alertRules` and `configPolicyAlertRules`) and tests dispatch queued before retirement; W05d removes the override and every `legacyEscalation` fallback, description, and test branch). Keep the exported names exactly as in **Interfaces** — W05c1/W05c2/W05d import them.
4. **Three PRs, in order.** PR 1 (Tasks 1–8) is API-only and ships the migration; PR 2 (Tasks 9–12) is the web page and redirects and can be reviewed in parallel but must merge after PR 1 (the routing drawer posts `monitorKinds`/`escalationPolicyId`, which PR 1's schema accepts); PR 3 (Tasks 13–16) adds the preview endpoint, Notify card, AI tool and docs, and extends PR 1's integration suite to the spec gate. Task 17 is the verification pass run before *each* PR.
5. **The spec gate** ("one integration test proving dispatch and preview agree for org-row, partner-row, default-row and inbox-only cases against real Postgres") is `apps/api/src/__tests__/integration/deliveryResolution.integration.test.ts`: created in Task 7 (dispatcher ⇄ resolver), extended in Task 13 (⇄ endpoint). The migration-replay half of the gate is `deliveryDefaultRowsMigration.integration.test.ts` (Task 1). Write/run Task 7’s Step 1 gate before implementing Tasks 2/4, then return to Task 7 for its green pass; task numbers and PR boundaries stay unchanged.
6. **Prerequisite defects #6342/#6343/#6344 do not gate this wave** (they gate W05c).
7. **D21 supersedes D1’s skip vocabulary and DB eligibility boundary.** The additive SELECT-only partner branches for channels, routing and escalation already shipped in `2026-10-10-120000-notification-maintenance-partner-wide-select.sql:75-90`; `PARTNER_WIDE_SELECT_BRANCH_EXEMPT` is empty in `rls-coverage.integration.test.ts`. W05b adds no policy and changes no RLS allowlist. Resolver and inherited-rail services use their supplied executor under its existing context.

## Global Constraints

- **Tenancy (CLAUDE.md "Tenant Isolation / RLS", "Partner-Wide First").** No new tables. `notification_routing_rules` gains two columns on a table already registered in `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:579`) and `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:404`). **The export-policy row fires on a new column:** both `escalation_policy_id` and `is_default` must be added to the `included` bucket in the same PR (Task 1) or `tenant-export-policy.integration.test.ts` goes red under Integration Tests. RLS on the table is unchanged: `notification_routing_rules_isolation` (FOR ALL, `2026-07-01-notification-rails-partner-ownership.sql`) plus the SELECT-only partner-wide branch `notification_routing_rules_partner_wide_select` (`2026-10-10-120000-notification-maintenance-partner-wide-select.sql`). The branch is what lets an org token's preview endpoint see the partner's "Everything else" row — do not escalate to system context in the route.
- **Migration rules (CLAUDE.md "Schema Migration Workflow").** File `apps/api/migrations/2026-10-23-100000-delivery-routing-default-rows.sql` (assigned name; newest shipped at planning time is `2026-10-21-110100-…`). **Before pushing, run `git fetch origin && git ls-tree -r --name-only origin/main apps/api/migrations | grep -E '^apps/api/migrations/[0-9]{4}-[^/]+\.sql$' | sort | tail -1` and run `scripts/check-migration-naming.sh --against-ref origin/main`; rename if anything newer landed.** Idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, `NOT EXISTS` guards on every INSERT); no inner `BEGIN`/`COMMIT`; elect system scope in the migration's first statement solely for its row writes and counts (FORCE RLS otherwise denies those writes; enforced by `apps/api/src/db/migrationRlsScope.test.ts`); every write reports `GET DIAGNOSTICS ... ROW_COUNT` via `RAISE WARNING` so the counts land in Postgres logs (spec: "Report both counts"). Never edit it after it ships.
- **D21 delivery boundary.** Runtime code never elevates its own scope. Ordinary RLS-scoped executor reads and the same explicit owner predicate apply in system dispatch and org preview: `channel.orgId === input.orgId || (channel.orgId === null && channel.partnerId === orgPartnerId)` (a null org partner never matches). Only visible, owner-valid, enabled channels enter `channelIds`; others have `disabled` or `unavailable` skip reasons. Check ownership before enabled state; missing, foreign and invisible IDs are indistinguishable. Inherited rails use service-level column projections for the exact Task 8 DTOs, never whole-row redaction. Moving channel configuration to an RLS-protected child table is tracked separately and out of scope. The migration’s row-write scope election is the sole exception to runtime scope preservation.
- **Write-coverage contract tests.** `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` is textual: any file under `src/routes/**` or `src/services/**` that mutates a partner-axis table must mention `canManagePartnerWidePolicies`. The new writers (`services/delivery/routingRuleWrites.ts`, `services/aiToolsDelivery.ts`) gate partner-wide writes on that helper themselves, so no allowlist entry is needed; if the test still flags a file, gate it — do not allowlist. `site-ceiling-write-coverage.test.ts` names `notificationChannels` but not routing rules/escalation policies; the AI tool gates mutations on `canMutateOrgWideGovernance` anyway (same posture as `manage_notification_channels`).
- **Web mutations go through `runAction`** (`apps/web/src/lib/runAction.ts`); catch pattern per CLAUDE.md. `no-silent-mutations.test.ts` guards this.
- **Web i18n.** Every new key needs real translations in all eight locale folders: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR` (`apps/web/src/locales/`). Parity is enforced; per-locale/namespace duplicate caps live in `apps/web/src/lib/i18n/translationCoverage.test.ts` — if a new value trips a cap, translate it instead of bumping the cap. PR description must carry the two machine-draft lines from `apps/web/src/locales/README.md`.
- **Settings rules (CLAUDE.md "Settings — one concept, one home").** Delivery is edited in one place: `/alerts/delivery`. Routing/escalation are lists → row-drawer Save; channels keep their existing modal (unchanged component). The Notify card *shows* the resolved inherited value and where it comes from (rule 4) and links to `/alerts/delivery`; it never edits routing. PR descriptions for PR 2 and PR 3 state: home `/alerts/delivery`, levels partner default → org override, resolver `resolveDelivery`, places configured before = 2 (`/alerts/channels` page + monitor editor override), after = 2 (same two, one resolver).
- **Test commands.** Unit: `cd apps/api && npx vitest run <path>`; web: `cd apps/web && npx vitest run <path>`; integration: `pnpm test-stack up` once, then `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>`; `pnpm test-stack down` when finished. Never `pnpm --filter X test -- --run` (the `--` breaks vitest). Path filters are substring matches — list dotted siblings explicitly.
- **File size.** `notificationDispatcher.ts` is 1587 lines, `NotificationChannelsPage.tsx` 928, `aiToolsAlerts.ts` 677. New code goes in new files (`services/delivery/*`, `components/alerts/delivery/*`, `aiToolsDelivery.ts`); the dispatcher and the alerts tool file only shrink.

## File Structure (what changes where)

| File | Change |
|---|---|
| `apps/api/migrations/2026-10-23-100000-delivery-routing-default-rows.sql` | **Create.** Columns, partial unique indexes, warning counts and default rows only; no new policies or eligibility routine. |
| `apps/api/src/db/schema/alerts.ts:228-243` | Modify: `escalationPolicyId`, `isDefault`, two partial unique indexes, typed `conditions`. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts:404` | Modify: add `escalation_policy_id`, `is_default` to `included`. |
| `apps/api/src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts` | **Create.** Replay proves default rows equal the pre-migration fallback set. |
| `apps/api/src/services/delivery/railOwnership.ts` | **Create.** `partnerIdForOrg`, `railOwnershipCondition` moved out of the dispatcher. |
| `apps/api/src/services/delivery/resolveDelivery.ts` (+ `.test.ts`) | **Create.** Ordinary executor reads plus explicit owner predicate; eligible channel IDs and disabled/unavailable skips; cross-wave resolver for dispatch, preview and conversion equivalence. |
| `apps/api/src/services/delivery/routingRuleWrites.ts` (+ `.test.ts`) | **Create.** Default-row constants, `assertDefaultRowPatch`, `upsertDefaultRow`, `escalationPolicyCompatible`. Shared by the route and the AI tool. |
| `apps/api/src/routes/alerts/routing.ts` | Modify: schema (drop `conditionTypes`/`deviceTags`, add `monitorKinds`, `escalationPolicyId`), default-row rules on PATCH/DELETE, `PUT /routing-rules/default`; export site-access helpers in Task 8 (PR 1). |
| `apps/api/src/routes/alerts/routing.defaultRow.test.ts` | **Create.** |
| `apps/api/src/routes/alerts/routing.writes.test.ts` | Modify: ordinary POST explicitly inserts `isDefault: false`. |
| `apps/api/src/routes/alerts/policies.steps.test.ts` | Create: user/channel targets and bounded repeat schema regressions. |
| `apps/api/src/services/delivery/escalationExecution.ts` (+ `.test.ts`) | Create: bounded occurrences, scoped user targets, durable in-app execution. |
| `apps/api/src/routes/alerts/policies.ts:157-165,210-229,244-273` | Modify: user target validation and governance guards. |
| `apps/api/src/services/delivery/inheritedRails.ts` (+ `.test.ts`) | Create: exact inherited DTO column projections, site filtering, supplied executor scope. |
| `apps/api/src/routes/alerts/deliveryRails.ts` (+ `.test.ts`) | Create: site-filtered inherited routing, inherited escalation, safe channel metadata, target user reads. |
| `apps/api/src/routes/alerts/schemas.ts:180-191` | Modify: typed `steps` on create/update policy schemas. |
| `apps/api/src/routes/alerts/policies.authz.test.ts:175,187` | Modify: fixtures use a valid step. |
| `apps/api/src/services/notificationDispatcher.ts:264-376, 441-446, 1250-1300, 126-160` | Modify: resolver wiring; delete fallback and `resolveRoutingRules`; import rail helpers; schedule/cancel user targets and repeat occurrences. |
| `apps/api/src/services/notificationDispatcher.routingSites.test.ts` | Rewrite against `resolveDelivery`; rename to `services/delivery/resolveDelivery.sites.test.ts`. |
| `apps/api/src/services/notificationDispatcher.monitorDelivery.test.ts:204-224`, `notificationDispatcher.configPolicyOverrides.test.ts:172-192` | Modify: the two "falls back to org channels" cases now expect a default row / inbox only. |
| `apps/api/src/__tests__/integration/notificationRailsPartnerRls.integration.test.ts:384-407` | Modify: the "no-rules fallback" case seeds a partner default row. |
| `apps/api/src/__tests__/integration/deliveryResolution.integration.test.ts` | **Create** (Task 7), **extend** (Tasks 8 and 13). Inherited RLS reads and the spec gate. |
| `apps/web/src/components/alerts/AlertsTabStrip.tsx:6-12,42-47` (+ `.test.tsx`) | Modify: `channels` → `delivery`. |
| `apps/web/src/pages/alerts/delivery.astro` | **Create.** |
| `apps/web/src/pages/alerts/channels/index.astro`, `apps/web/src/pages/alerts/routing-rules.astro` | 301 stubs. |
| `apps/web/src/pages/monitoring/delivery.astro` | Repoint to `/alerts/delivery` if still present (see Ordering 2). |
| `apps/web/src/components/alerts/AlertRuleForm.tsx:675` | Modify: `href="/alerts/delivery"`. |
| `apps/web/src/components/alerts/delivery/useDeliveryResource.ts` (+ `.test.tsx`) | Create: independent loading/error/Retry and stale-response protection. |
| `apps/web/src/components/alerts/DeliveryPage.test.tsx` | Create: failed rails never synthesize defaults or enable edits. |
| `apps/web/src/components/alerts/DeliveryPage.tsx` | **Create.** Composition. |
| `apps/web/src/components/alerts/delivery/deliveryActions.ts` (+ `.test.ts`) | **Create** (moved `run*` helpers from `NotificationChannelsPage.tsx:19-114` + new ones). |
| `apps/web/src/components/alerts/delivery/ChannelsSection.tsx` | **Create** (lifted from `NotificationChannelsPage.tsx:132-470,536-543,666-745`). |
| `apps/web/src/components/alerts/delivery/RoutingSection.tsx`, `RoutingRuleDrawer.tsx` (+ tests) | **Create.** |
| `apps/web/src/components/alerts/delivery/EscalationPoliciesSection.tsx`, `EscalationPolicyDrawer.tsx` (+ tests) | **Create.** |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:39,693` | Modify: retarget the one mutation-owner entry on each move; retain 146 guarded files. |
| `apps/web/src/components/alerts/NotificationChannelsPage.tsx`, `.test.tsx` | **Delete.** |
| `apps/web/src/components/alerts/index.ts:45` | Modify: export `DeliveryPage` instead. |
| `apps/web/src/locales/*/alerts.json`, `pages.json`, `monitoring.json` (8 locales) | New keys (Tasks 9, 11, 12, 14). |
| `apps/api/src/routes/alerts/delivery.ts` (+ `.test.ts`), `routes/alerts/index.ts` | **Create** `GET /alerts/delivery/resolve`; mount before `alertsRoutes`. |
| `apps/api/src/services/delivery/describeDelivery.ts` (+ `.test.ts`) | **Create.** Names + display string for the preview. |
| `apps/web/src/components/monitoring/MonitorEditor.tsx:179-352,777-888` (+ `.test.tsx`) | Modify: load inherited delivery choices from rails, preserve saved overrides, and show the resolved Notify answer. |
| `apps/api/src/services/aiToolsDelivery.ts` (+ `.test.ts`), `aiTools.ts:68,318`, `aiAgentSdkTools.ts:163,279,2507`, `aiToolSchemas.ts:1580`, `aiGuardrails.ts:142,1263,1613`, `aiAgents/agentToolCatalog.ts:84`, `aiAgentSdkTools.registryParity.contract.test.ts:88`, `aiAgentSystemPrompt.ts:108` | **Create** `manage_delivery` and register it on every pinned surface. |
| `apps/docs/src/content/docs/features/notifications.mdx:352-406,611-616`, `features/alerts.mdx:192,212` | Modify. |

---

## PR 1 — API: migration, resolver, dispatcher (Tasks 1–8)

### Task 1: Routing columns + default-row migration + export policy + replay test

**Files:**
- Create: `apps/api/migrations/2026-10-23-100000-delivery-routing-default-rows.sql`
- Modify: `apps/api/src/db/schema/alerts.ts:228-243` (`notificationRoutingRules`), the `drizzle-orm` import at the top of that file (add `sql` if absent)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:404`
- Test: `apps/api/src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts`

**Interfaces:**
- Produces (DB): `notification_routing_rules.escalation_policy_id uuid NULL REFERENCES escalation_policies(id) ON DELETE SET NULL`, `notification_routing_rules.is_default boolean NOT NULL DEFAULT false`, partial unique indexes `notification_routing_rules_org_default_uidx (org_id) WHERE is_default AND partner_id IS NULL` and `notification_routing_rules_partner_default_uidx (partner_id) WHERE is_default AND org_id IS NULL`.
- Produces (Drizzle): `notificationRoutingRules.escalationPolicyId`, `notificationRoutingRules.isDefault`, `conditions` typed as `RoutingRuleConditions = { severities?: string[]; monitorKinds?: string[]; siteIds?: string[] }` (exported from the schema file).
- Consumes: `2026-07-01-notification-rails-partner-ownership.sql` (the XOR CHECK and FOR ALL policy), `notificationDispatcher.ts:362-371` (the fallback query this migration reproduces).

- [ ] **Step 1: Write the failing test** — `apps/api/src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts`

```ts
/**
 * Replays 2026-10-23-100000-delivery-routing-default-rows.sql against a
 * fixture partner and asserts the rows it writes equal the PRE-migration
 * all-enabled-channels fallback (notificationDispatcher.ts:362-371 on main
 * at b8dd148bd8): org's enabled channels + its partner's enabled partner-wide
 * channels, `enabled = true` on both axes. This is the "day one is
 * behavior-identical" half of the W05b spec gate.
 *
 * CI databases are migrated schema-fresh in globalSetup, so the file's
 * data-moving DO blocks otherwise run against zero rows; this suite seeds
 * the real pre-migration shape and re-runs the file from disk.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { notificationChannels, notificationRoutingRules } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-10-23-100000-delivery-routing-default-rows.sql',
);
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function replayMigration() {
  // Superuser client: the file elects breeze.scope=system itself.
  await getTestDb().execute(sql.raw(readFileSync(MIGRATION_FILE, 'utf8')));
}

const created = { channels: [] as string[], rules: [] as string[] };

afterEach(async () => {
  const db = getTestDb();
  for (const id of created.rules) await db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, id));
  for (const id of created.channels) await db.delete(notificationChannels).where(eq(notificationChannels.id, id));
  created.rules.length = 0;
  created.channels.length = 0;
});

async function seedChannel(owner: { orgId: string | null; partnerId: string | null }, name: string, enabled: boolean) {
  const [row] = await getTestDb()
    .insert(notificationChannels)
    .values({ ...owner, name, type: 'slack', config: { webhookUrl: 'https://hooks.slack.example/x' }, enabled })
    .returning({ id: notificationChannels.id });
  created.channels.push(row!.id);
  return row!.id;
}

async function defaultRowFor(where: ReturnType<typeof and>) {
  const rows = await getTestDb()
    .select()
    .from(notificationRoutingRules)
    .where(and(where, eq(notificationRoutingRules.isDefault, true)));
  for (const r of rows) if (!created.rules.includes(r.id)) created.rules.push(r.id);
  return rows;
}

describe('2026-10-23-100000-delivery-routing-default-rows.sql', () => {
  runDb('writes one partner row with the enabled partner-wide channels and one org row equal to the old fallback set', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const orgNoChannels = await createOrganization({ partnerId: partner.id });

    const partnerOn = await seedChannel({ orgId: null, partnerId: partner.id }, 'Partner NOC', true);
    await seedChannel({ orgId: null, partnerId: partner.id }, 'Partner disabled', false);
    const orgOn = await seedChannel({ orgId: org.id, partnerId: null }, 'Org email', true);
    await seedChannel({ orgId: org.id, partnerId: null }, 'Org disabled', false);

    await replayMigration();

    const [partnerRow] = await defaultRowFor(and(eq(notificationRoutingRules.partnerId, partner.id), isNull(notificationRoutingRules.orgId))!);
    expect(partnerRow).toBeDefined();
    expect(partnerRow!.name).toBe('Everything else');
    expect(partnerRow!.enabled).toBe(true);
    expect(partnerRow!.conditions).toEqual({});
    expect([...(partnerRow!.channelIds as string[])].sort()).toEqual([partnerOn].sort());

    const [orgRow] = await defaultRowFor(eq(notificationRoutingRules.orgId, org.id)!);
    expect(orgRow).toBeDefined();
    // Exactly the old fallback: org enabled channels + partner enabled partner-wide channels.
    expect([...(orgRow!.channelIds as string[])].sort()).toEqual([orgOn, partnerOn].sort());

    // An org with no enabled org-owned channel gets NO org row (the partner row covers it).
    expect(await defaultRowFor(eq(notificationRoutingRules.orgId, orgNoChannels.id)!)).toHaveLength(0);
  });

  runDb('is a no-op on replay and never duplicates a default row', async () => {
    const partner = await createPartner();
    await seedChannel({ orgId: null, partnerId: partner.id }, 'Partner NOC', true);
    await replayMigration();
    await replayMigration();
    const rows = await defaultRowFor(and(eq(notificationRoutingRules.partnerId, partner.id), isNull(notificationRoutingRules.orgId))!);
    expect(rows).toHaveLength(1);
  });

  runDb('a partner with only DISABLED partner-wide channels gets no partner row', async () => {
    const partner = await createPartner();
    await seedChannel({ orgId: null, partnerId: partner.id }, 'Partner disabled', false);
    await replayMigration();
    expect(await defaultRowFor(and(eq(notificationRoutingRules.partnerId, partner.id), isNull(notificationRoutingRules.orgId))!)).toHaveLength(0);
  });

  runDb('the partial unique indexes reject a second default row per axis', async () => {
    const partner = await createPartner();
    await seedChannel({ orgId: null, partnerId: partner.id }, 'Partner NOC', true);
    await replayMigration();
    await expect(
      getTestDb().insert(notificationRoutingRules).values({
        orgId: null, partnerId: partner.id, name: 'dup', priority: 1, conditions: {}, channelIds: [], enabled: true, isDefault: true,
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts
```
Expected: `ENOENT: no such file or directory ... 2026-10-23-100000-delivery-routing-default-rows.sql` (first test) and TypeScript errors `Property 'isDefault' does not exist`.

- [ ] **Step 3: Implement** — migration file:

```sql
-- W05b (alerting consolidation): explicit "Everything else" routing rows replace
-- the dispatcher's hidden all-enabled-channels fallback.
-- Spec: docs/superpowers/specs/monitoring/2026-09-19-alerting-consolidation-design.md
--       §Data model "Routing", §Delivery resolution "Migration".
--
-- SYSTEM SCOPE IS ELECTED FIRST AND IT IS LOAD-BEARING. notification_routing_rules
-- is FORCE ROW LEVEL SECURITY with one FOR ALL policy
-- (2026-07-01-notification-rails-partner-ownership.sql). Without this line the
-- count SELECT reads zero rows and the INSERTs abort with 42501. `is_local => true`
-- scopes it to autoMigrate's per-file transaction. Enforced by
-- apps/api/src/db/migrationRlsScope.test.ts.
--
-- The two INSERTs reproduce EXACTLY the fallback query the dispatcher ran on
-- main@b8dd148bd8 (notificationDispatcher.ts:362-371): railOwnershipCondition
-- (org_id = O OR (org_id IS NULL AND partner_id = O.partner_id)) AND enabled = true.
-- Day one is behavior-identical; from then on a new channel is opt-in.
--
-- Idempotent: IF NOT EXISTS everywhere, NOT EXISTS guards on both INSERTs.
-- No inner BEGIN/COMMIT (autoMigrate wraps each file). Counts RAISE WARNING so
-- they land in Postgres logs (log_min_messages defaults to warning).

SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
ALTER TABLE notification_routing_rules
  ADD COLUMN IF NOT EXISTS escalation_policy_id uuid REFERENCES escalation_policies(id) ON DELETE SET NULL;
ALTER TABLE notification_routing_rules
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. One "Everything else" row per axis.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS notification_routing_rules_org_default_uidx
  ON notification_routing_rules (org_id)
  WHERE is_default AND partner_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notification_routing_rules_partner_default_uidx
  ON notification_routing_rules (partner_id)
  WHERE is_default AND org_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Report rows still carrying the never-evaluated keys. Left as-is: the
--    resolver ignores unknown keys and the API now rejects them on write.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM notification_routing_rules
   WHERE conditions ? 'conditionTypes' OR conditions ? 'deviceTags';
  IF n > 0 THEN
    RAISE WARNING 'notification_routing_rules: % row(s) carry conditionTypes/deviceTags (never evaluated; left in place)', n;
  ELSE
    RAISE NOTICE 'notification_routing_rules: no rows carry conditionTypes/deviceTags';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Partner rows: every partner with >= 1 ENABLED partner-wide channel.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  INSERT INTO notification_routing_rules
    (org_id, partner_id, name, priority, conditions, channel_ids, enabled, is_default)
  SELECT NULL, c.partner_id, 'Everything else', 1000000, '{}'::jsonb,
         jsonb_agg(c.id::text ORDER BY c.created_at, c.id), true, true
    FROM notification_channels c
   WHERE c.org_id IS NULL
     AND c.partner_id IS NOT NULL
     AND c.enabled = true
     AND NOT EXISTS (
       SELECT 1 FROM notification_routing_rules r
        WHERE r.partner_id = c.partner_id AND r.org_id IS NULL AND r.is_default
     )
   GROUP BY c.partner_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'delivery default rows: inserted % partner "Everything else" row(s)', n;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Org rows: every org with >= 1 ENABLED org-owned channel. Channel set =
--    org's enabled channels + its partner's enabled partner-wide channels —
--    the exact old fallback. Orgs with no org-owned channel get no row: the
--    partner row already yields the identical set for them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  INSERT INTO notification_routing_rules
    (org_id, partner_id, name, priority, conditions, channel_ids, enabled, is_default)
  SELECT o.id, NULL, 'Everything else', 1000000, '{}'::jsonb,
         (
           SELECT jsonb_agg(c.id::text ORDER BY (c.org_id IS NULL), c.created_at, c.id)
             FROM notification_channels c
            WHERE c.enabled = true
              AND (c.org_id = o.id OR (c.org_id IS NULL AND c.partner_id = o.partner_id))
         ),
         true, true
    FROM organizations o
   WHERE EXISTS (
           SELECT 1 FROM notification_channels oc
            WHERE oc.org_id = o.id AND oc.enabled = true
         )
     AND NOT EXISTS (
           SELECT 1 FROM notification_routing_rules r
            WHERE r.org_id = o.id AND r.is_default
         );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'delivery default rows: inserted % org "Everything else" row(s)', n;
END $$;
```

Drizzle schema (`apps/api/src/db/schema/alerts.ts`, replace the `notificationRoutingRules` block at lines 228-243; ensure `sql` is imported from `drizzle-orm` and `uniqueIndex` from `drizzle-orm/pg-core` — both already appear in this file):

```ts
/** Evaluated by services/delivery/resolveDelivery.ts. Unknown keys are ignored. */
export interface RoutingRuleConditions {
  severities?: string[];
  monitorKinds?: string[];
  siteIds?: string[];
}

export const notificationRoutingRules = pgTable('notification_routing_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id),
  partnerId: uuid('partner_id').references(() => partners.id),
  name: varchar('name', { length: 255 }).notNull(),
  priority: integer('priority').notNull(),
  conditions: jsonb('conditions').notNull().$type<RoutingRuleConditions>(),
  channelIds: jsonb('channel_ids').notNull().$type<string[]>(),
  enabled: boolean('enabled').notNull().default(true),
  // W05b (alerting consolidation): the winning row may name an escalation
  // policy; one is_default "Everything else" row per axis replaces the
  // dispatcher's all-enabled-channels fallback (migration 2026-10-23-100000-delivery-routing-default-rows.sql).
  escalationPolicyId: uuid('escalation_policy_id').references(() => escalationPolicies.id, { onDelete: 'set null' }),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
}, (table) => ({
  orgIdIdx: index('notification_routing_rules_org_id_idx').on(table.orgId),
  priorityIdx: index('notification_routing_rules_priority_idx').on(table.orgId, table.priority),
  partnerIdIdx: index('notification_routing_rules_partner_id_idx').on(table.partnerId),
  orgDefaultUidx: uniqueIndex('notification_routing_rules_org_default_uidx')
    .on(table.orgId)
    .where(sql`${table.isDefault} AND ${table.partnerId} IS NULL`),
  partnerDefaultUidx: uniqueIndex('notification_routing_rules_partner_default_uidx')
    .on(table.partnerId)
    .where(sql`${table.isDefault} AND ${table.orgId} IS NULL`),
}));
```

Export policy (`tenantExportPolicyRegistry.ts:404`, one line):

```ts
  "notification_routing_rules": tablePolicy("org_id", {"included":["id","org_id","partner_id","name","priority","enabled","escalation_policy_id","is_default","created_at","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":["conditions","channel_ids"]}),
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts
cd ../.. && pnpm db:check-drift
```
All green. If `db:check-drift` reports the partial index predicate text, adjust the migration's `WHERE` clause to the exact text drizzle-kit renders (quoting only) — never the other way round once shipped.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-23-100000-delivery-routing-default-rows.sql apps/api/src/db/schema/alerts.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts
git commit -m "feat(api): routing escalation_policy_id + is_default, default 'Everything else' rows from the fallback set (W05b)"
```

---

### Task 2: `railOwnership.ts` + `resolveDelivery.ts` with unit tests

**Files:**
- Create: `apps/api/src/services/delivery/railOwnership.ts`
- Create: `apps/api/src/services/delivery/resolveDelivery.ts`
- Test: `apps/api/src/services/delivery/resolveDelivery.test.ts`

**Interfaces:**
- Produces (cross-wave contract, exact names — W05c1/W05c2/W05d import these):
  ```ts
  export type DeliverySource = 'monitor_none' | 'monitor_channels' | 'legacy_override' | 'routing_rule' | 'default_row' | 'none';
  export interface ResolveDeliveryInput { orgId: string; severity: AlertSeverity; monitorId?: string | null; kind?: MonitorKind | null; siteId?: string | null; legacyOverride?: { channelIds?: string[] | null; escalationPolicyId?: string | null } | null; }
  export interface ResolvedDelivery { channelIds: string[]; skippedChannelIds: Array<{ id: string; reason: 'disabled' | 'unavailable' }>; escalationPolicyId: string | null; source: DeliverySource; routingRuleId?: string; routingRuleName?: string; }
  export async function resolveDelivery(input: ResolveDeliveryInput, executor?: DbExecutor): Promise<ResolvedDelivery>;
  export function routingRuleMatches(conditions: RoutingRuleConditions | null | undefined, facts: { severity: string; kind: string | null; siteId: string | null }): boolean;
  export function orderRoutingRows<T extends { isDefault: boolean; priority: number; orgId: string | null }>(rows: T[]): T[];
  ```
  `DbExecutor` = `typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]` (same local alias as `monitorResolver.ts:71`; not exported by `db/index.ts`).
- Produces: `railOwnership.ts` → `partnerIdForOrg(orgId, executor?)`, `railOwnershipCondition(orgCol, partnerCol, orgId, orgPartnerId)` (bodies moved verbatim from `notificationDispatcher.ts:134-160`).
- Consumes: ordinary RLS-scoped reads on the supplied `DbExecutor`; `notificationChannels`, `notificationRoutingRules`, `monitorDefinitions`, `organizations` (schema), `AlertSeverity` from `@breeze/shared` (`packages/shared/src/types/index.ts:498`), `MonitorKind` from `@breeze/shared` (`packages/shared/src/validators/monitors.ts:41`).

Precedence (spec §Delivery resolution), first hit wins:
1. monitor `deliveryMode = 'none'` → `[]`, `monitor_none`, escalation **null** (spec: monitor escalation applies only when mode ≠ none).
2. monitor `deliveryMode = 'channels'` → its channels, `monitor_channels`, escalation = monitor's.
3. transitional legacy override with ≥1 channel → `legacy_override`, escalation = monitor's ?? override's.
4. routing rows: `enabled`, non-default first, `priority ASC`, org rows before partner rows at equal priority; match `severities` / `monitorKinds` / `siteIds`; **site and kind both fail closed** (a kind-scoped row never catches a kind-less alert; today's site semantics unchanged). Rows with no channels are skipped (API forbids them for non-default rows).
5. org `is_default` row, else partner `is_default` row → `default_row` (channels may be `[]` = inbox only). Escalation = monitor's ?? row's ?? override's.
6. nothing → `[]`, `none`, escalation = monitor's ?? override's.

- [ ] **Step 1: Write the failing test** — `apps/api/src/services/delivery/resolveDelivery.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same select-queue harness as notificationDispatcher.routingSites.test.ts:
// each `db.select()` chain resolves to the next queued array.
const { selectQueue, channelRows } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  channelRows: [] as Array<{ id: string; orgId: string | null; partnerId: string | null; enabled: boolean }>,
}));
vi.mock('../../db', async () => {
  const { notificationChannels } = await import('../../db/schema');
  const makeSelect = () => {
    let isChannelRead = false;
    const chain: any = {
      from: (table: unknown) => { isChannelRead = table === notificationChannels; return chain; },
      where: () => chain, orderBy: () => chain, limit: () => chain,
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(isChannelRead ? channelRows : selectQueue.shift() ?? []).then(resolve, reject),
    };
    return chain;
  };
  return { db: { select: vi.fn(() => makeSelect()) } };
});

// Channel metadata uses the ordinary SELECT mock, keyed by table.
import { orderRoutingRows, resolveDelivery, routingRuleMatches } from './resolveDelivery';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const CH_ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const CH_PARTNER = 'aaaaaaaa-0000-4000-8000-000000000002';
const CH_MON = 'aaaaaaaa-0000-4000-8000-000000000003';
const ESC_MON = 'bbbbbbbb-0000-4000-8000-000000000001';
const ESC_ROW = 'bbbbbbbb-0000-4000-8000-000000000002';
const ESC_LEGACY = 'bbbbbbbb-0000-4000-8000-000000000003';

const orgLookup = () => [{ partnerId: PARTNER }];
const row = (over: Record<string, unknown>) => ({
  id: 'r-' + Math.random().toString(36).slice(2, 8), orgId: ORG, partnerId: null, name: 'row', priority: 10,
  conditions: {}, channelIds: [CH_ORG], enabled: true, escalationPolicyId: null, isDefault: false, ...over,
});
const monitor = (deliveryMode: string, over: Record<string, unknown> = {}) => [{
  kind: 'cpu', deliveryMode, deliveryChannelIds: [CH_MON], escalationPolicyId: ESC_MON, ...over,
}];

describe('routingRuleMatches', () => {
  it('matches an unconditioned row', () => {
    expect(routingRuleMatches({}, { severity: 'high', kind: null, siteId: null })).toBe(true);
  });
  it('filters on severity', () => {
    expect(routingRuleMatches({ severities: ['critical'] }, { severity: 'high', kind: null, siteId: null })).toBe(false);
  });
  it('fails closed on monitorKinds when the alert has no kind', () => {
    expect(routingRuleMatches({ monitorKinds: ['cpu'] }, { severity: 'high', kind: null, siteId: null })).toBe(false);
    expect(routingRuleMatches({ monitorKinds: ['cpu'] }, { severity: 'high', kind: 'cpu', siteId: null })).toBe(true);
  });
  it('fails closed on siteIds when the device site is unknown (unchanged semantics)', () => {
    expect(routingRuleMatches({ siteIds: [SITE_A] }, { severity: 'high', kind: null, siteId: null })).toBe(false);
    expect(routingRuleMatches({ siteIds: [SITE_A] }, { severity: 'high', kind: null, siteId: SITE_A })).toBe(true);
  });
  it('ignores unknown keys (conditionTypes/deviceTags left in old rows)', () => {
    expect(routingRuleMatches({ conditionTypes: ['x'] } as never, { severity: 'high', kind: null, siteId: null })).toBe(true);
  });
});

describe('orderRoutingRows', () => {
  it('orders non-default first, then priority, then org before partner', () => {
    const rows = [
      row({ id: 'd-org', isDefault: true, priority: 1000000 }),
      row({ id: 'p5', orgId: null, partnerId: PARTNER, priority: 5 }),
      row({ id: 'o5', priority: 5 }),
      row({ id: 'o1', priority: 1 }),
      row({ id: 'd-partner', isDefault: true, orgId: null, partnerId: PARTNER, priority: 1000000 }),
    ];
    expect(orderRoutingRows(rows).map((r) => r.id)).toEqual(['o1', 'o5', 'p5', 'd-org', 'd-partner']);
  });
});

describe('resolveDelivery precedence', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    channelRows.splice(0, channelRows.length,
      { id: CH_ORG, orgId: ORG, partnerId: null, enabled: true },
      { id: CH_MON, orgId: ORG, partnerId: null, enabled: true },
      { id: CH_PARTNER, orgId: null, partnerId: PARTNER, enabled: true });
  });

  it('1. monitor none → inbox only, no escalation even when the monitor names one', async () => {
    selectQueue.push(orgLookup(), monitor('none'));
    await expect(resolveDelivery({ orgId: ORG, severity: 'high', monitorId: 'm1' }))
      .resolves.toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'monitor_none' });
  });

  it('2. monitor channels → its channels + its escalation; routing rows never consulted', async () => {
    selectQueue.push(orgLookup(), monitor('channels'));
    const out = await resolveDelivery({ orgId: ORG, severity: 'high', monitorId: 'm1', legacyOverride: { channelIds: [CH_ORG] } });
    expect(out).toEqual({ skippedChannelIds: [], channelIds: [CH_MON], escalationPolicyId: ESC_MON, source: 'monitor_channels' });
    expect(selectQueue).toHaveLength(0);
  });

  it('3. legacy override (transitional) wins over routing rows; monitor escalation still wins over the override escalation', async () => {
    selectQueue.push(orgLookup(), monitor('inherit'));
    const out = await resolveDelivery({ orgId: ORG, severity: 'high', monitorId: 'm1', legacyOverride: { channelIds: [CH_ORG, CH_ORG], escalationPolicyId: ESC_LEGACY } });
    expect(out).toEqual({ skippedChannelIds: [], channelIds: [CH_ORG], escalationPolicyId: ESC_MON, source: 'legacy_override' });
  });

  it('3b. legacy override with an escalation but no channels does NOT short-circuit; its escalation survives as the last fallback', async () => {
    selectQueue.push(orgLookup(), [row({ id: 'r1', conditions: { severities: ['high'] } })]);
    const out = await resolveDelivery({ orgId: ORG, severity: 'high', legacyOverride: { channelIds: [], escalationPolicyId: ESC_LEGACY } });
    expect(out).toMatchObject({ channelIds: [CH_ORG], escalationPolicyId: ESC_LEGACY, source: 'routing_rule', routingRuleId: 'r1' });
  });

  it('4. first matching non-default row wins; org row beats partner row at equal priority; row escalation used', async () => {
    selectQueue.push(orgLookup(), [
      row({ id: 'partner5', orgId: null, partnerId: PARTNER, priority: 5, channelIds: [CH_PARTNER] }),
      row({ id: 'org5', priority: 5, escalationPolicyId: ESC_ROW }),
      row({ id: 'org1-wrong-sev', priority: 1, conditions: { severities: ['critical'] } }),
    ]);
    const out = await resolveDelivery({ orgId: ORG, severity: 'high' });
    expect(out).toEqual({ skippedChannelIds: [], channelIds: [CH_ORG], escalationPolicyId: ESC_ROW, source: 'routing_rule', routingRuleId: 'org5', routingRuleName: 'row' });
  });

  it('4b. monitorKinds row matches only the monitor kind (kind taken from the monitor row when not supplied)', async () => {
    selectQueue.push(orgLookup(), monitor('inherit', { escalationPolicyId: null }), [
      row({ id: 'disk-only', conditions: { monitorKinds: ['disk'] } }),
      row({ id: 'cpu', conditions: { monitorKinds: ['cpu'] }, channelIds: [CH_PARTNER] }),
    ]);
    const out = await resolveDelivery({ orgId: ORG, severity: 'high', monitorId: 'm1' });
    expect(out).toMatchObject({ source: 'routing_rule', routingRuleId: 'cpu', channelIds: [CH_PARTNER] });
  });

  it('5. no match → org default row before partner default row; empty channels mean inbox only', async () => {
    selectQueue.push(orgLookup(), [
      row({ id: 'd-partner', isDefault: true, orgId: null, partnerId: PARTNER, priority: 1000000, channelIds: [CH_PARTNER] }),
      row({ id: 'd-org', isDefault: true, priority: 1000000, channelIds: [], escalationPolicyId: ESC_ROW }),
      row({ id: 'crit', conditions: { severities: ['critical'] } }),
    ]);
    const out = await resolveDelivery({ orgId: ORG, severity: 'low' });
    expect(out).toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: ESC_ROW, source: 'default_row', routingRuleId: 'd-org', routingRuleName: 'row' });
  });

  it('5b. partner default row applies when the org has none', async () => {
    selectQueue.push(orgLookup(), [row({ id: 'd-partner', isDefault: true, orgId: null, partnerId: PARTNER, priority: 1000000, channelIds: [CH_PARTNER] })]);
    await expect(resolveDelivery({ orgId: ORG, severity: 'low' }))
      .resolves.toMatchObject({ channelIds: [CH_PARTNER], source: 'default_row', routingRuleId: 'd-partner' });
  });

  it.each([true, false])('foreign visible=%s has the same unavailable result as missing', async visible => {
    selectQueue.push(orgLookup(), [row({ channelIds: [CH_ORG, CH_PARTNER, CH_MON], escalationPolicyId: ESC_ROW })]);
    channelRows.splice(0, channelRows.length,
      { id: CH_ORG, orgId: ORG, partnerId: null, enabled: false },
      ...(visible ? [{ id: CH_PARTNER, orgId: null, partnerId: SITE_A, enabled: false }] : []));
    expect(await resolveDelivery({ orgId: ORG, severity: 'high' })).toMatchObject({
      channelIds: [], escalationPolicyId: ESC_ROW, source: 'routing_rule',
      skippedChannelIds: [{ id: CH_ORG, reason: 'disabled' }, { id: CH_PARTNER, reason: 'unavailable' }, { id: CH_MON, reason: 'unavailable' }],
    });
  });

  it('rejects sibling-org channels even when their partner matches, and emits no skip for eligible IDs', async () => {
    selectQueue.push(orgLookup(), [row({ channelIds: [CH_ORG, CH_PARTNER, CH_MON] })]);
    channelRows.splice(0, channelRows.length,
      { id: CH_ORG, orgId: SITE_A, partnerId: PARTNER, enabled: true },
      { id: CH_PARTNER, orgId: null, partnerId: PARTNER, enabled: true },
      { id: CH_MON, orgId: ORG, partnerId: null, enabled: true });
    expect(await resolveDelivery({ orgId: ORG, severity: 'high' })).toMatchObject({
      channelIds: [CH_PARTNER, CH_MON], skippedChannelIds: [{ id: CH_ORG, reason: 'unavailable' }],
    });
  });

  it('exposes the legacy-kind to CPU route delta for W05c1 equivalence checks (D6)', async () => {
    const routes = [row({ id: 'cpu-route', conditions: { monitorKinds: ['cpu'] }, channelIds: [CH_ORG], escalationPolicyId: ESC_ROW }),
      row({ id: 'default', isDefault: true, channelIds: [CH_PARTNER], escalationPolicyId: ESC_LEGACY })];
    selectQueue.push(orgLookup(), routes, orgLookup(), routes);
    const before = await resolveDelivery({ orgId: ORG, severity: 'high', kind: null });
    const after = await resolveDelivery({ orgId: ORG, severity: 'high', kind: 'cpu' });
    expect(before).toMatchObject({ channelIds: [CH_PARTNER], escalationPolicyId: ESC_LEGACY });
    expect(after).toMatchObject({ channelIds: [CH_ORG], escalationPolicyId: ESC_ROW });
  });

  it('6. nothing configured → none (fresh install)', async () => {
    selectQueue.push([{ partnerId: null }], []);
    await expect(resolveDelivery({ orgId: ORG, severity: 'low' }))
      .resolves.toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'none' });
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
cd apps/api && npx vitest run src/services/delivery/resolveDelivery.test.ts
```
Expected: `Failed to resolve import "./resolveDelivery"`.

- [ ] **Step 3: Implement**

`apps/api/src/services/delivery/railOwnership.ts`:

```ts
/**
 * Delivery rails are dual-owned (#2130): a channel / routing rule / escalation
 * policy is org-owned (org_id set) OR partner-wide (org_id NULL, partner_id
 * set). Every delivery lookup must match the alert org's own rows OR
 * partner-wide rows owned by that org's partner — a plain eq(orgId, X)
 * silently never matches partner-wide rows (the #1724 trap). Moved out of
 * notificationDispatcher.ts in W05b so resolveDelivery and the dispatcher
 * share one definition.
 */
import { and, eq, isNull, or, type Column, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { organizations } from '../../db/schema';

export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function partnerIdForOrg(orgId: string, executor: DbExecutor = db): Promise<string | null> {
  const [org] = await executor
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org?.partnerId ?? null;
}

export function railOwnershipCondition(
  orgCol: Column,
  partnerCol: Column,
  orgId: string,
  orgPartnerId: string | null
): SQL {
  if (!orgPartnerId) {
    return eq(orgCol, orgId);
  }
  return or(
    eq(orgCol, orgId),
    and(isNull(orgCol), eq(partnerCol, orgPartnerId))
  ) as SQL;
}
```

`apps/api/src/services/delivery/resolveDelivery.ts`:

```ts
/**
 * ONE delivery decision (spec §Delivery resolution, W05b). Used by the
 * dispatcher (system context), by GET /alerts/delivery/resolve (request
 * context — the partner-wide SELECT branch makes the partner's rows visible
 * to an org token) and by the manage_delivery AI tool. If the three ever
 * disagree, deliveryResolution.integration.test.ts is the proof.
 *
 * Precedence, first hit wins:
 *   1. monitor deliveryMode 'none'      → inbox only            (monitor_none)
 *   2. monitor deliveryMode 'channels'  → monitor's channels    (monitor_channels)
 *   3. legacy override with channels    → those channels        (legacy_override)  [W05b→W05d]
 *   4. first matching routing row       → row's channels        (routing_rule)
 *   5. org is_default row, else partner is_default row          (default_row)
 *   6. nothing                          → inbox only            (none)
 * Escalation resolves independently: monitor's (mode ≠ none) ?? winning row's
 * ?? legacy override's ?? null.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AlertSeverity, MonitorKind } from '@breeze/shared';
import { db } from '../../db';
import { monitorDefinitions, notificationChannels, notificationRoutingRules, type RoutingRuleConditions } from '../../db/schema';
import { partnerIdForOrg, railOwnershipCondition, type DbExecutor } from './railOwnership';

export type DeliverySource =
  | 'monitor_none'
  | 'monitor_channels'
  | 'legacy_override'
  | 'routing_rule'
  | 'default_row'
  | 'none';

export interface ResolveDeliveryInput {
  orgId: string;
  severity: AlertSeverity;
  monitorId?: string | null;
  kind?: MonitorKind | null;
  siteId?: string | null;
  /**
   * Transitional (spec §Delivery resolution "Transitional"): an UNMANAGED
   * alert_rules row's overrideSettings or a config_policy_alert_rules row's
   * own channel/escalation columns. W05c adds `retired_at IS NULL` at the
   * caller; W05d deletes the branch.
   */
  legacyOverride?: { channelIds?: string[] | null; escalationPolicyId?: string | null } | null;
}

export interface ResolvedDelivery {
  /** Eligible, visible, enabled, owner-valid destinations only (D21). */
  channelIds: string[];
  skippedChannelIds: Array<{ id: string; reason: 'disabled' | 'unavailable' }>;
  escalationPolicyId: string | null;
  source: DeliverySource;
  routingRuleId?: string;
  routingRuleName?: string;
}

type MonitorDelivery = 'inherit' | 'channels' | 'none';

function uniq(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

export function routingRuleMatches(
  conditions: RoutingRuleConditions | null | undefined,
  facts: { severity: string; kind: string | null; siteId: string | null }
): boolean {
  const c = conditions ?? {};
  if (Array.isArray(c.severities) && c.severities.length > 0 && !c.severities.includes(facts.severity)) return false;
  // Fail closed: a kind-scoped row never catches an alert with no monitor kind.
  if (Array.isArray(c.monitorKinds) && c.monitorKinds.length > 0 && (!facts.kind || !c.monitorKinds.includes(facts.kind))) return false;
  // Fail closed (unchanged): a site-scoped row never catches an alert whose device site is unknown.
  if (Array.isArray(c.siteIds) && c.siteIds.length > 0 && (!facts.siteId || !c.siteIds.includes(facts.siteId))) return false;
  return true;
}

/** Non-default first; then priority ASC; then org rows before partner rows. */
export function orderRoutingRows<T extends { isDefault: boolean; priority: number; orgId: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    const aOrg = a.orgId !== null ? 0 : 1;
    const bOrg = b.orgId !== null ? 0 : 1;
    return aOrg - bOrg;
  });
}

export async function resolveDelivery(
  input: ResolveDeliveryInput,
  executor: DbExecutor = db
): Promise<ResolvedDelivery> {
  const orgPartnerId = await partnerIdForOrg(input.orgId, executor);
  const finish = async (decision: Omit<ResolvedDelivery, 'skippedChannelIds'>): Promise<ResolvedDelivery> => {
    const ids = uniq(decision.channelIds);
    if (!ids.length) return { ...decision, channelIds: [], skippedChannelIds: [] };
    // Use the caller's executor unchanged. Project only eligibility metadata.
    const rows = await executor.select({
      id: notificationChannels.id, orgId: notificationChannels.orgId,
      partnerId: notificationChannels.partnerId, enabled: notificationChannels.enabled,
    }).from(notificationChannels).where(inArray(notificationChannels.id, ids));
    const byId = new Map(rows.map(row => [row.id, row]));
    const skippedChannelIds: ResolvedDelivery['skippedChannelIds'] = [];
    const channelIds = ids.filter(id => {
      const channel = byId.get(id);
      // System reads can see foreign rows; org reads cannot. Apply exactly the
      // same predicate before enabled state, so neither exposes existence.
      const ownerValid = channel && (channel.orgId === input.orgId ||
        (channel.orgId === null && orgPartnerId !== null && channel.partnerId === orgPartnerId));
      const reason = !ownerValid ? 'unavailable' : !channel!.enabled ? 'disabled' : null;
      if (reason === null) return true;
      skippedChannelIds.push({ id, reason }); return false;
    });
    return { ...decision, channelIds, skippedChannelIds };
  };


  let kind: string | null = input.kind ?? null;
  let monitorMode: MonitorDelivery | null = null;
  let monitorChannels: string[] = [];
  let monitorEscalation: string | null = null;

  if (input.monitorId) {
    const [monitor] = await executor
      .select({
        kind: monitorDefinitions.kind,
        deliveryMode: monitorDefinitions.deliveryMode,
        deliveryChannelIds: monitorDefinitions.deliveryChannelIds,
        escalationPolicyId: monitorDefinitions.escalationPolicyId,
      })
      .from(monitorDefinitions)
      .where(eq(monitorDefinitions.id, input.monitorId))
      .limit(1);
    if (monitor) {
      monitorMode = monitor.deliveryMode as MonitorDelivery;
      monitorChannels = uniq(monitor.deliveryChannelIds ?? []);
      monitorEscalation = monitor.escalationPolicyId ?? null;
      kind = kind ?? monitor.kind;
    }
  }

  // 1. Inbox only is an opinion: no channels, and no escalation either.
  if (monitorMode === 'none') {
    return finish({ channelIds: [], escalationPolicyId: null, source: 'monitor_none' });
  }
  // 2. Explicit channels on the monitor.
  if (monitorMode === 'channels') {
    return finish({ channelIds: monitorChannels, escalationPolicyId: monitorEscalation, source: 'monitor_channels' });
  }

  // 3. Transitional legacy override (W05b → W05d).
  const legacyChannels = uniq(input.legacyOverride?.channelIds ?? []);
  const legacyEscalation = input.legacyOverride?.escalationPolicyId ?? null;
  if (legacyChannels.length > 0) {
    return finish({ channelIds: legacyChannels, escalationPolicyId: monitorEscalation ?? legacyEscalation, source: 'legacy_override' });
  }

  // 4–5. Routing rows for the org and its partner, one ordering.
  const rows = orderRoutingRows(
    await executor
      .select()
      .from(notificationRoutingRules)
      .where(
        and(
          railOwnershipCondition(notificationRoutingRules.orgId, notificationRoutingRules.partnerId, input.orgId, orgPartnerId),
          eq(notificationRoutingRules.enabled, true)
        )
      )
      .orderBy(asc(notificationRoutingRules.priority))
  );

  const facts = { severity: input.severity, kind, siteId: input.siteId ?? null };
  for (const rule of rows) {
    if (rule.isDefault) continue;
    if (!routingRuleMatches(rule.conditions, facts)) continue;
    const channelIds = uniq(rule.channelIds ?? []);
    if (channelIds.length === 0) continue;
    return finish({
      channelIds,
      escalationPolicyId: monitorEscalation ?? rule.escalationPolicyId ?? legacyEscalation,
      source: 'routing_rule',
      routingRuleId: rule.id,
      routingRuleName: rule.name,
    });
  }

  const defaultRow =
    rows.find((r) => r.isDefault && r.orgId === input.orgId) ??
    rows.find((r) => r.isDefault && r.orgId === null);
  if (defaultRow) {
    return finish({
      channelIds: uniq(defaultRow.channelIds ?? []),
      escalationPolicyId: monitorEscalation ?? defaultRow.escalationPolicyId ?? legacyEscalation,
      source: 'default_row',
      routingRuleId: defaultRow.id,
      routingRuleName: defaultRow.name,
    });
  }

  // 6. Fresh install: nothing configured. Caller logs it.
  return finish({ channelIds: [], escalationPolicyId: monitorEscalation ?? legacyEscalation, source: 'none' });
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
(cd apps/api && npx vitest run src/services/delivery/resolveDelivery.test.ts && npx tsc --noEmit -p .)
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/delivery/railOwnership.ts apps/api/src/services/delivery/resolveDelivery.ts apps/api/src/services/delivery/resolveDelivery.test.ts
git commit -m "feat(api): resolveDelivery — one precedence for alert delivery (W05b)"
```

---

### Task 3: Routing API — `monitorKinds`, `escalationPolicyId`, the "Everything else" row rules

**Files:**
- Create: `apps/api/src/services/delivery/routingRuleWrites.ts` (+ `routingRuleWrites.test.ts`)
- Modify: `apps/api/src/routes/alerts/routing.ts:17-47` (schemas), `:230-380` (POST/PATCH/DELETE bodies), new `PUT /routing-rules/default`
- Test: `apps/api/src/routes/alerts/routing.defaultRow.test.ts`; existing `routing.writes.test.ts`, `routing.authz.test.ts`, `routing.siteScope.test.ts`, `routing.list.test.ts` must stay green

**Interfaces:**
- Produces (`routingRuleWrites.ts`):
  ```ts
  export const DEFAULT_ROW_NAME = 'Everything else';
  export const DEFAULT_ROW_PRIORITY = 1000000;
  export type RoutingOwner = { orgId: string | null; partnerId: string | null };
  export class DeliveryWriteError extends Error { constructor(public readonly status: 400 | 403 | 404 | 409, message: string) }
  export function assertDefaultRowPatch(updates: Record<string, unknown>): void; // throws DeliveryWriteError(400)
  export async function escalationPolicyCompatible(policyId: string, owner: RoutingOwner, executor?: DbExecutor): Promise<boolean>;
  export async function upsertDefaultRow(owner: RoutingOwner, data: { channelIds: string[]; escalationPolicyId: string | null }, auth: Pick<AuthContext, 'scope' | 'allowedSiteIds' | 'allowedDeviceIds'> & Partial<Pick<AuthContext, 'partnerId' | 'partnerOrgAccess' | 'canAccessOrg'>>, executor?: DbExecutor): Promise<typeof notificationRoutingRules.$inferSelect>;
  ```
- Produces (HTTP): `POST /alerts/routing-rules` accepts `conditions: { severities?, monitorKinds?, siteIds? }` (strict — `conditionTypes`/`deviceTags` → 400) and `escalationPolicyId?: uuid | null`; `PATCH /alerts/routing-rules/:id` on an `isDefault` row requires `canMutateOrgWideGovernance(auth)` and accepts only `channelIds` (may be `[]`) and `escalationPolicyId`; `DELETE` of an `isDefault` row on either axis → 409; `PUT /alerts/routing-rules/default` `{ ownerScope?: 'organization' | 'partner', channelIds: uuid[], escalationPolicyId?: uuid | null }` (+ `?orgId=` for partner/system callers) upserts the axis's row → 200 `{ data: row }`.
- Consumes: `monitorKindSchema` (`@breeze/shared`), `canManagePartnerWidePolicies` / `PARTNER_WIDE_WRITE_DENIED_MESSAGE` (`services/partnerWideAccess.ts`), `resolveWriteOrgId`, `ensureOrgAccess` (`routes/alerts/helpers.ts:52,77`), `partnerIdForOrg` (Task 2).

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/delivery/routingRuleWrites.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectQueue, inserted, updated } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  inserted: { current: undefined as Record<string, unknown> | undefined },
  updated: { current: undefined as Record<string, unknown> | undefined },
}));
vi.mock('../../db', () => {
  const chain: any = {
    from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain,
    values: (v: Record<string, unknown>) => { inserted.current = v; return chain; },
    set: (v: Record<string, unknown>) => { updated.current = v; return chain; },
    returning: () => Promise.resolve([{ id: 'row-1', ...(inserted.current ?? updated.current ?? {}) }]),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(isChannelRead ? channelRows : selectQueue.shift() ?? []).then(resolve, reject),
  };
  return { db: { select: () => chain, insert: () => chain, update: () => chain } };
});
vi.mock('../partnerWideAccess', () => ({
  canManagePartnerWidePolicies: (auth: { scope?: string }) => auth.scope === 'partner',
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'denied',
}));

import {
  DEFAULT_ROW_NAME, DEFAULT_ROW_PRIORITY, DeliveryWriteError,
  assertDefaultRowPatch, escalationPolicyCompatible, upsertDefaultRow,
} from './routingRuleWrites';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const OTHER_PARTNER = '99999999-9999-4999-8999-999999999999';

beforeEach(() => { selectQueue.length = 0; inserted.current = undefined; updated.current = undefined; });

describe('assertDefaultRowPatch', () => {
  it('allows channelIds and escalationPolicyId only', () => {
    expect(() => assertDefaultRowPatch({ channelIds: [], escalationPolicyId: null })).not.toThrow();
    expect(() => assertDefaultRowPatch({ name: 'x' })).toThrow(DeliveryWriteError);
    expect(() => assertDefaultRowPatch({ enabled: false })).toThrow(/Everything else/);
    expect(() => assertDefaultRowPatch({ priority: 1 })).toThrow(DeliveryWriteError);
    expect(() => assertDefaultRowPatch({ conditions: {} })).toThrow(DeliveryWriteError);
  });
});

describe('escalationPolicyCompatible', () => {
  it('org-owned rule: accepts the org policy and the org partner\'s partner-wide policy, rejects a foreign one', async () => {
    selectQueue.push([{ id: 'e', orgId: ORG, partnerId: null }]);
    await expect(escalationPolicyCompatible('e', { orgId: ORG, partnerId: null })).resolves.toBe(true);
    selectQueue.push([{ id: 'e', orgId: null, partnerId: PARTNER }], [{ partnerId: PARTNER }]);
    await expect(escalationPolicyCompatible('e', { orgId: ORG, partnerId: null })).resolves.toBe(true);
    selectQueue.push([{ id: 'e', orgId: null, partnerId: OTHER_PARTNER }], [{ partnerId: PARTNER }]);
    await expect(escalationPolicyCompatible('e', { orgId: ORG, partnerId: null })).resolves.toBe(false);
  });
  it('partner-wide rule: accepts only a partner-wide policy of the same partner', async () => {
    selectQueue.push([{ id: 'e', orgId: null, partnerId: PARTNER }]);
    await expect(escalationPolicyCompatible('e', { orgId: null, partnerId: PARTNER })).resolves.toBe(true);
    selectQueue.push([{ id: 'e', orgId: ORG, partnerId: null }]);
    await expect(escalationPolicyCompatible('e', { orgId: null, partnerId: PARTNER })).resolves.toBe(false);
  });
  it('missing policy → false', async () => {
    selectQueue.push([]);
    await expect(escalationPolicyCompatible('e', { orgId: ORG, partnerId: null })).resolves.toBe(false);
  });
});

describe('upsertDefaultRow', () => {
  it('inserts the org row with the fixed name/priority when none exists', async () => {
    selectQueue.push([]);
    const row = await upsertDefaultRow({ orgId: ORG, partnerId: null }, { channelIds: ['aaaaaaaa-0000-4000-8000-000000000012'], escalationPolicyId: null }, { scope: 'organization' });
    expect(inserted.current).toMatchObject({ orgId: ORG, partnerId: null, name: DEFAULT_ROW_NAME, priority: DEFAULT_ROW_PRIORITY, conditions: {}, channelIds: ['aaaaaaaa-0000-4000-8000-000000000012'], enabled: true, isDefault: true });
    expect(row.id).toBe('row-1');
  });
  it('updates channels/escalation in place when the row exists', async () => {
    selectQueue.push([{ id: 'existing', orgId: ORG, partnerId: null, isDefault: true }]);
    await upsertDefaultRow({ orgId: ORG, partnerId: null }, { channelIds: [], escalationPolicyId: 'e1' }, { scope: 'organization' });
    expect(inserted.current).toBeUndefined();
    expect(updated.current).toMatchObject({ channelIds: [], escalationPolicyId: 'e1' });
  });
  it.each([[], ['33333333-3333-4333-8333-333333333333']])('shared writer rejects site ceiling %j', async allowedSiteIds => {
    await expect(upsertDefaultRow({ orgId: ORG, partnerId: null }, { channelIds: [], escalationPolicyId: null },
      { scope: 'organization', allowedSiteIds })).rejects.toMatchObject({ status: 403 });
    expect(inserted.current).toBeUndefined(); expect(updated.current).toBeUndefined();
  });
  it('partner row requires canManagePartnerWidePolicies', async () => {
    await expect(upsertDefaultRow({ orgId: null, partnerId: PARTNER }, { channelIds: [], escalationPolicyId: null }, { scope: 'organization' }))
      .rejects.toMatchObject({ status: 403 });
  });
});
```

`apps/api/src/routes/alerts/routing.defaultRow.test.ts` (harness cloned from `routing.writes.test.ts:12-71`, plus a mock of the writes module):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, insertedRef, existingRowRef, deletedRef, upsertMock } = vi.hoisted(() => ({
  authRef: { current: {} as Record<string, unknown> },
  insertedRef: { current: undefined as Record<string, unknown> | undefined },
  existingRowRef: { current: undefined as Record<string, unknown> | undefined },
  deletedRef: { current: false },
  upsertMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => { c.set('auth', authRef.current); await next(); },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: () => () => true,
}));
vi.mock('../../db', () => {
  const builder: any = {
    values: (vals: Record<string, unknown>) => { insertedRef.current = vals; return builder; },
    returning: () => Promise.resolve([{ id: 'new-rule', ...(insertedRef.current ?? existingRowRef.current ?? {}) }]),
    set: () => builder, from: () => builder, where: () => builder,
    limit: () => Promise.resolve(existingRowRef.current ? [existingRowRef.current] : []),
    orderBy: () => Promise.resolve([]),
  };
  return {
    db: {
      insert: () => builder, update: () => builder, select: () => builder,
      delete: () => ({ where: () => { deletedRef.current = true; return Promise.resolve(undefined); } }),
    },
  };
});
vi.mock('../../db/schema', () => ({
  notificationRoutingRules: { id: { name: 'id' }, orgId: { name: 'org_id' }, partnerId: { name: 'partner_id' }, priority: { name: 'priority' } },
  organizations: { id: { name: 'id' }, partnerId: { name: 'partner_id' } },
  sites: { id: { name: 'id' }, orgId: { name: 'org_id' } },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/delivery/routingRuleWrites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/delivery/routingRuleWrites')>();
  return { ...actual, escalationPolicyCompatible: vi.fn(async () => true), upsertDefaultRow: upsertMock };
});

import { routingRoutes } from './routing';

const app = () => { const a = new Hono(); a.route('/alerts', routingRoutes); return a; };
const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const CHANNEL = '9a8b7c6d-2222-4333-8444-555566667777';
const POLICY = '7c6d5e4f-3333-4444-8555-666677778888';
const jsonReq = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const partnerAuth = () => ({ scope: 'partner', partnerOrgAccess: 'all', user: { id: 'u-1' }, partnerId: 'p-1', orgId: null, accessibleOrgIds: ['org-a'], canAccessOrg: () => true, allowedSiteIds: undefined });
const orgAuth = () => ({ scope: 'organization', user: { id: 'u-1' }, partnerId: 'p-1', orgId: 'org-a', accessibleOrgIds: ['org-a'], canAccessOrg: (id: string) => id === 'org-a', allowedSiteIds: undefined });

beforeEach(() => { vi.clearAllMocks(); insertedRef.current = undefined; existingRowRef.current = undefined; deletedRef.current = false; authRef.current = partnerAuth(); upsertMock.mockResolvedValue({ id: 'default-row' }); });

describe('routing schema (W05b)', () => {
  it('rejects the never-evaluated conditionTypes/deviceTags keys with 400', async () => {
    const res = await app().request('/alerts/routing-rules?orgId=org-a', jsonReq('POST', { name: 'x', priority: 1, conditions: { conditionTypes: ['cpu'] }, channelIds: [CHANNEL] }));
    expect(res.status).toBe(400);
  });
  it('accepts monitorKinds and escalationPolicyId and stores them', async () => {
    const res = await app().request('/alerts/routing-rules?orgId=org-a', jsonReq('POST', { name: 'x', priority: 1, conditions: { monitorKinds: ['cpu', 'disk'], severities: ['high'] }, channelIds: [CHANNEL], escalationPolicyId: POLICY }));
    expect(res.status).toBe(201);
    expect(insertedRef.current).toMatchObject({ conditions: { monitorKinds: ['cpu', 'disk'], severities: ['high'] }, escalationPolicyId: POLICY, isDefault: false });
  });
  it('rejects an unknown monitor kind', async () => {
    const res = await app().request('/alerts/routing-rules?orgId=org-a', jsonReq('POST', { name: 'x', priority: 1, conditions: { monitorKinds: ['nope'] }, channelIds: [CHANNEL] }));
    expect(res.status).toBe(400);
  });
});

describe('Everything else row rules', () => {
  it('PATCH on the default row accepts channelIds [] (inbox only) and escalationPolicyId', async () => {
    existingRowRef.current = { id: RULE_ID, orgId: 'org-a', partnerId: null, name: 'Everything else', isDefault: true, conditions: {} };
    const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, jsonReq('PATCH', { channelIds: [], escalationPolicyId: POLICY }));
    expect(res.status).toBe(200);
  });
  it('PATCH on the default row rejects name/priority/conditions/enabled', async () => {
    existingRowRef.current = { id: RULE_ID, orgId: 'org-a', partnerId: null, name: 'Everything else', isDefault: true, conditions: {} };
    for (const body of [{ name: 'x' }, { priority: 2 }, { conditions: {} }, { enabled: false }]) {
      const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, jsonReq('PATCH', body));
      expect(res.status).toBe(400);
    }
  });
  it.each([{ allowedSiteIds: [] }, { allowedSiteIds: ['33333333-3333-4333-8333-333333333333'] }, { allowedDeviceIds: [] }])(
    'PATCH on a default row rejects governance ceiling %j, including an empty-channel write', async ceiling => {
      authRef.current = { ...orgAuth(), ...ceiling };
      existingRowRef.current = { id: RULE_ID, orgId: 'org-a', partnerId: null, isDefault: true, conditions: {} };
      expect((await app().request(`/alerts/routing-rules/${RULE_ID}`, jsonReq('PATCH', { channelIds: [] }))).status).toBe(403);
    },
  );
  it('PATCH on a NON-default row rejects an empty channel list', async () => {
    existingRowRef.current = { id: RULE_ID, orgId: 'org-a', partnerId: null, name: 'Crit', isDefault: false, conditions: {} };
    const res = await app().request(`/alerts/routing-rules/${RULE_ID}`, jsonReq('PATCH', { channelIds: [] }));
    expect(res.status).toBe(400);
  });
  it('DELETE of either Everything else row is 409', async () => {
    for (const owner of [{ orgId: null, partnerId: 'p-1' }, { orgId: 'org-a', partnerId: null }]) {
      existingRowRef.current = { id: RULE_ID, ...owner, name: 'Everything else', isDefault: true, conditions: {} };
      expect((await app().request(`/alerts/routing-rules/${RULE_ID}`, { method: 'DELETE' })).status).toBe(409);
      expect(deletedRef.current).toBe(false);
    }
  });
  it('PUT /routing-rules/default upserts the org row for an org token and the partner row for ownerScope partner', async () => {
    authRef.current = orgAuth();
    let res = await app().request('/alerts/routing-rules/default', jsonReq('PUT', { channelIds: [CHANNEL] }));
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenLastCalledWith({ orgId: 'org-a', partnerId: null }, { channelIds: [CHANNEL], escalationPolicyId: null }, expect.anything());

    authRef.current = partnerAuth();
    res = await app().request('/alerts/routing-rules/default', jsonReq('PUT', { ownerScope: 'partner', channelIds: [] }));
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenLastCalledWith({ orgId: null, partnerId: 'p-1' }, { channelIds: [], escalationPolicyId: null }, expect.anything());
  });
  it.each([[], ['33333333-3333-4333-8333-333333333333']])('rejects site ceiling %j even for inbox-only defaults', async allowedSiteIds => {
    authRef.current = { ...orgAuth(), allowedSiteIds };
    for (const channelIds of [[], [CHANNEL]]) {
      expect((await app().request('/alerts/routing-rules/default', jsonReq('PUT', { channelIds }))).status).toBe(403);
    }
    expect(upsertMock).not.toHaveBeenCalled();
  });
  it('PUT /routing-rules/default maps DeliveryWriteError to its status', async () => {
    const { DeliveryWriteError } = await import('../../services/delivery/routingRuleWrites');
    upsertMock.mockRejectedValueOnce(new DeliveryWriteError(403, 'denied'));
    const res = await app().request('/alerts/routing-rules/default', jsonReq('PUT', { ownerScope: 'partner', channelIds: [] }));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
cd apps/api && npx vitest run src/services/delivery/routingRuleWrites.test.ts src/routes/alerts/routing.defaultRow.test.ts
```
Expected: `Failed to resolve import "./routingRuleWrites"`; then, once the file exists, the route tests fail with 201 where 400 is expected (`conditionTypes` still accepted) and 404/500 on `PUT /routing-rules/default`.

- [ ] **Step 3: Implement**

`apps/api/src/services/delivery/routingRuleWrites.ts`:

```ts
/**
 * Write rules for notification_routing_rules that the route AND the
 * manage_delivery AI tool must agree on (spec §End state "Delivery": the
 * "Everything else" row cannot be deleted or reordered; its channels may be
 * emptied to mean inbox only). One body, two callers.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { escalationPolicies, notificationRoutingRules } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../siteCeilingAccess';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import { partnerIdForOrg, type DbExecutor } from './railOwnership';

export const DEFAULT_ROW_NAME = 'Everything else';
/** Cosmetic: resolveDelivery orders is_default rows last regardless of priority. */
export const DEFAULT_ROW_PRIORITY = 1000000;

export type RoutingOwner = { orgId: string | null; partnerId: string | null };

export class DeliveryWriteError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = 'DeliveryWriteError';
  }
}

const DEFAULT_ROW_PATCHABLE = new Set(['channelIds', 'escalationPolicyId']);

export function assertDefaultRowPatch(updates: Record<string, unknown>): void {
  const offending = Object.keys(updates).filter((k) => updates[k] !== undefined && !DEFAULT_ROW_PATCHABLE.has(k));
  if (offending.length > 0) {
    throw new DeliveryWriteError(400, `Only channelIds and escalationPolicyId can change on the Everything else row (got ${offending.join(', ')})`);
  }
}

/**
 * An org-owned row may name the org's own policy or its partner's partner-wide
 * policy; a partner-wide row may name only a partner-wide policy of the same
 * partner (mirrors monitorAttachability for monitors).
 */
export async function escalationPolicyCompatible(
  policyId: string,
  owner: RoutingOwner,
  executor: DbExecutor = db
): Promise<boolean> {
  const [policy] = await executor
    .select({ id: escalationPolicies.id, orgId: escalationPolicies.orgId, partnerId: escalationPolicies.partnerId })
    .from(escalationPolicies)
    .where(eq(escalationPolicies.id, policyId))
    .limit(1);
  if (!policy) return false;
  if (owner.orgId !== null) {
    if (policy.orgId === owner.orgId) return true;
    if (policy.orgId !== null) return false;
    const orgPartnerId = await partnerIdForOrg(owner.orgId, executor);
    return orgPartnerId !== null && policy.partnerId === orgPartnerId;
  }
  return policy.orgId === null && policy.partnerId === owner.partnerId;
}

export async function upsertDefaultRow(
  owner: RoutingOwner,
  data: { channelIds: string[]; escalationPolicyId: string | null },
  auth: Pick<AuthContext, 'scope' | 'allowedSiteIds' | 'allowedDeviceIds'> & Partial<Pick<AuthContext, 'partnerId' | 'partnerOrgAccess' | 'canAccessOrg'>>,
  executor: DbExecutor = db
) {
  if (!canMutateOrgWideGovernance(auth)) {
    throw new DeliveryWriteError(403, SITE_CEILING_WRITE_DENIED_MESSAGE);
  }
  if (owner.orgId === null && !canManagePartnerWidePolicies(auth as Parameters<typeof canManagePartnerWidePolicies>[0])) {
    throw new DeliveryWriteError(403, PARTNER_WIDE_WRITE_DENIED_MESSAGE);
  }
  const axis = owner.orgId !== null
    ? and(eq(notificationRoutingRules.orgId, owner.orgId), eq(notificationRoutingRules.isDefault, true))
    : and(isNull(notificationRoutingRules.orgId), eq(notificationRoutingRules.partnerId, owner.partnerId!), eq(notificationRoutingRules.isDefault, true));
  const [existing] = await executor.select().from(notificationRoutingRules).where(axis).limit(1);
  const channelIds = [...new Set(data.channelIds)];
  if (existing) {
    const [row] = await executor
      .update(notificationRoutingRules)
      .set({ channelIds, escalationPolicyId: data.escalationPolicyId, updatedAt: new Date() })
      .where(eq(notificationRoutingRules.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await executor
    .insert(notificationRoutingRules)
    .values({
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      name: DEFAULT_ROW_NAME,
      priority: DEFAULT_ROW_PRIORITY,
      conditions: {},
      channelIds,
      enabled: true,
      escalationPolicyId: data.escalationPolicyId,
      isDefault: true,
    })
    .returning();
  return row!;
}
```

`apps/api/src/routes/alerts/routing.ts` — replace lines 17-47 with:

```ts
import { monitorKindSchema } from '@breeze/shared';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';
import {
  DeliveryWriteError,
  assertDefaultRowPatch,
  escalationPolicyCompatible,
  upsertDefaultRow,
} from '../../services/delivery/routingRuleWrites';

const listRoutingRulesSchema = z.object({
  orgId: z.string().guid().optional(),
});

// Evaluated keys only (spec §Data model "Routing"): `conditionTypes` and
// `deviceTags` were accepted for two years and never read by the dispatcher;
// `.strict()` turns a write of either into a 400 instead of a silent no-op.
const routingConditionsSchema = z.object({
  severities: z.array(z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
  monitorKinds: z.array(monitorKindSchema).optional(),
  siteIds: z.array(z.string().guid()).optional(),
}).strict();

const createRoutingRuleSchema = z.object({
  // 'partner' creates a partner-wide ("all orgs") routing rule: orgId NULL,
  // partnerId = caller's partner (#2130). Create-only.
  ownerScope: z.enum(['organization', 'partner']).optional(),
  name: z.string().min(1).max(255),
  priority: z.number().int().min(0),
  conditions: routingConditionsSchema,
  channelIds: z.array(z.string().guid()).min(1),
  escalationPolicyId: z.string().guid().nullable().optional(),
  enabled: z.boolean().optional().default(true),
});

const updateRoutingRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  priority: z.number().int().min(0).optional(),
  conditions: routingConditionsSchema.optional(),
  // No .min(1): the Everything else row may be emptied (inbox only). Non-default
  // rows are re-checked in the handler.
  channelIds: z.array(z.string().guid()).optional(),
  escalationPolicyId: z.string().guid().nullable().optional(),
  enabled: z.boolean().optional(),
});

const upsertDefaultRowSchema = z.object({
  ownerScope: z.enum(['organization', 'partner']).optional(),
  channelIds: z.array(z.string().guid()),
  escalationPolicyId: z.string().guid().nullable().optional(),
});

const ESCALATION_POLICY_AXIS_MESSAGE = 'Escalation policy is not available to this rule owner';
```

POST handler: after `owner` is resolved and before the insert, add
```ts
      if (data.escalationPolicyId && !(await escalationPolicyCompatible(data.escalationPolicyId, owner))) {
        return c.json({ error: ESCALATION_POLICY_AXIS_MESSAGE }, 400);
      }
```
and include both `escalationPolicyId: data.escalationPolicyId ?? null` and `isDefault: false` in `.values({...})` (the mock does not apply database defaults).

PATCH handler: after the partner-wide capability check and before the site checks, add
```ts
      if (existing.isDefault) {
        if (!canMutateOrgWideGovernance(auth)) return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
        try {
          assertDefaultRowPatch(updates);
        } catch (err) {
          if (err instanceof DeliveryWriteError) return c.json({ error: err.message }, err.status);
          throw err;
        }
      } else if (updates.channelIds !== undefined && updates.channelIds.length === 0) {
        return c.json({ error: 'channelIds must contain at least one channel' }, 400);
      }
      if (updates.escalationPolicyId && !(await escalationPolicyCompatible(updates.escalationPolicyId, { orgId: existing.orgId, partnerId: existing.partnerId }))) {
        return c.json({ error: ESCALATION_POLICY_AXIS_MESSAGE }, 400);
      }
```
and in the `setValues` block add `if (updates.escalationPolicyId !== undefined) setValues.escalationPolicyId = updates.escalationPolicyId;`.

DELETE handler: after the partner-wide capability check, add
```ts
      if (existing.isDefault) {
        return c.json({ error: 'The Everything else row cannot be deleted; empty its channels for inbox only' }, 409);
      }
```

New route (place it **before** `routingRoutes.patch('/routing-rules/:id', ...)` so the literal segment is registered first):

```ts
// Import canMutateOrgWideGovernance and SITE_CEILING_WRITE_DENIED_MESSAGE
// from '../../services/siteCeilingAccess'. The shared writer repeats this guard.
// PUT /alerts/routing-rules/default — upsert the axis's "Everything else" row.
// An org token writes its org row (which shadows the partner's for that org);
// a partner-scoped caller writes the partner row with ownerScope 'partner' or
// an org row with ?orgId=.
routingRoutes.put(
  '/routing-rules/default',
  requireScope('organization', 'partner', 'system'),
  requireAlertWrite,
  requireMfa(),
  zValidator('json', upsertDefaultRowSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      if (!canMutateOrgWideGovernance(auth)) return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
      const data = c.req.valid('json');
      let owner: { orgId: string | null; partnerId: string | null };
      if (data.ownerScope === 'partner') {
        if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) {
          return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
        }
        owner = { orgId: null, partnerId: auth.partnerId };
      } else {
        const resolved = resolveWriteOrgId(auth, c.req.query('orgId'));
        if (resolved.error) {
          return c.json({ error: resolved.error }, resolved.status ?? 400);
        }
        owner = { orgId: resolved.orgId!, partnerId: null };
      }
      if (data.escalationPolicyId && !(await escalationPolicyCompatible(data.escalationPolicyId, owner))) {
        return c.json({ error: ESCALATION_POLICY_AXIS_MESSAGE }, 400);
      }
      const row = await upsertDefaultRow(owner, { channelIds: data.channelIds, escalationPolicyId: data.escalationPolicyId ?? null }, auth);
      writeRouteAudit(c, {
        orgId: owner.orgId,
        action: 'notification_routing_rule.default_upsert',
        resourceType: 'notification_routing_rule',
        resourceId: row.id,
        resourceName: row.name,
        details: { channelCount: data.channelIds.length, inboxOnly: data.channelIds.length === 0 },
      });
      return c.json({ data: row });
    } catch (error) {
      if (error instanceof DeliveryWriteError) return c.json({ error: error.message }, error.status);
      console.error('[RoutingRules] Failed to upsert default routing row', error);
      return c.json({ error: 'Failed to save the Everything else row' }, 500);
    }
  }
);
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd apps/api && npx vitest run src/services/delivery/routingRuleWrites.test.ts src/routes/alerts/routing.defaultRow.test.ts src/routes/alerts/routing.writes.test.ts src/routes/alerts/routing.authz.test.ts src/routes/alerts/routing.siteScope.test.ts src/routes/alerts/routing.list.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts
```
If `routing.writes.test.ts`'s schema mock (`vi.mock('../../db/schema', () => ({ notificationRoutingRules: {...} }))`) now throws because `routingRuleWrites.ts` imports `escalationPolicies`, add `escalationPolicies: { id: {}, orgId: {}, partnerId: {} }, organizations: { id: {}, partnerId: {} }` to that mock — no behavior change.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/delivery/routingRuleWrites.ts apps/api/src/services/delivery/routingRuleWrites.test.ts apps/api/src/routes/alerts/routing.ts apps/api/src/routes/alerts/routing.defaultRow.test.ts apps/api/src/routes/alerts/routing.writes.test.ts
git commit -m "feat(api): routing rules gain monitorKinds + escalationPolicyId; Everything else row rules (W05b)"
```

---

### Task 4: Dispatcher on the resolver; delete the all-channels fallback

**Files:**
- Modify: `apps/api/src/services/notificationDispatcher.ts` — imports (`:9-45`), delete `partnerIdForOrg`/`railOwnershipCondition` (`:126-160`), replace `:264-376` and `:441-446`, delete `resolveRoutingRules` (`:1245-1300`)
- Move+rewrite: `apps/api/src/services/notificationDispatcher.routingSites.test.ts` → `apps/api/src/services/delivery/resolveDelivery.sites.test.ts`
- Modify: all existing `apps/api/src/services/notificationDispatcher*.test.ts` (UUID fixture normalization); `notificationDispatcher.monitorDelivery.test.ts:148-249`, `notificationDispatcher.configPolicyOverrides.test.ts:143-214`, `notificationDispatcher.orderingGuards.test.ts` (six 6-entry queues), `apps/api/src/__tests__/integration/notificationRailsPartnerRls.integration.test.ts:384-407`

**Interfaces:**
- Consumes: `resolveDelivery`, `partnerIdForOrg`, `railOwnershipCondition` (Task 2).
- Produces: unchanged export surface except `resolveRoutingRules` is **removed** (grep confirms its only consumer is the routingSites test). `processAlertNotifications` return shape unchanged.
- Select order after this task (every mock-based test depends on it):
  1. `alerts` by id · 2. `devices` by id · 3. `alertRules` `{overrideSettings, managedByMonitorId}` if `alert.ruleId`, else `configPolicyAlertRules` if `alert.configPolicyId`, else nothing · 4. `organizations` (dispatcher's `partnerIdForOrg`) · 5. `organizations` (resolver's `partnerIdForOrg`) · 6. `monitorDefinitions` if a monitorId resolved (`alert.monitorId ?? rule.managedByMonitorId`) · 7. `notificationRoutingRules` unless steps 1–3 of the precedence short-circuited · 7b. `notificationChannels` eligibility metadata (ordinary SELECT under the supplied context); 8. `notificationChannels` transport options if eligible channels resolved · 9. `escalationPolicies` + `notificationChannels` if an escalation policy resolved.
  The second `organizations` read is deliberate: the resolver owns its own lookup so the preview endpoint and the AI tool need no caller-side plumbing; one PK read per dispatch is the price of one contract.

- [ ] **Step 1: Write the failing tests** — rewrite the affected cases first.

Strict persisted-step parsing in Task 6 uses the real UUID validator. Before applying the snippets, replace the legacy fixture channel strings throughout the existing dispatcher test files (including expected job IDs) using this implementation-time script:

```python
from pathlib import Path
ids = {'mc1': 'aaaaaaaa-0000-4000-8000-000000000011',
       'c1': 'aaaaaaaa-0000-4000-8000-000000000012',
       'channel-1': 'aaaaaaaa-0000-4000-8000-000000000013',
       'org-default-channel': 'aaaaaaaa-0000-4000-8000-000000000014'}
for path in Path('apps/api/src/services').glob('notificationDispatcher*.test.ts'):
    text = path.read_text()
    for old, new in ids.items():
        text = text.replace(old, new)
    path.write_text(text)
```

In all three existing dispatcher suites add `channelEligibilityMock: vi.fn()` to the hoisted state. Extend their existing `db.select` factory to distinguish Task 2's eligibility projection from the later transport SELECT. Retain the existing select queue for all other reads:

```ts
// In the existing db mock factory: accept `fields` in select's callback and,
// before building the queued chain, add this branch. This still mocks SELECT.
select: vi.fn((fields?: Record<string, unknown>) => {
  if (fields && 'enabled' in fields && 'orgId' in fields && 'partnerId' in fields) {
    return { from: () => ({ where: () => channelEligibilityMock() }) };
  }
  return makeSelect(); // the suite's existing thenable queue-chain factory
}),
// In each beforeEach, independently reset the eligibility fixtures:
channelEligibilityMock.mockReset().mockResolvedValue(
  ['aaaaaaaa-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-000000000013', 'aaaaaaaa-0000-4000-8000-000000000014']
    .map(id => ({ id, orgId: 'org-1', partnerId: null, enabled: true })),
);
```

`notificationDispatcher.orderingGuards.test.ts:337-349`'s `queueEscalationFlow` also needs the resolver organization lookup before its channel-options lookup; its unmanaged override means no routing read. Keep webhook transport metadata in the subsequent options fixture.


`apps/api/src/services/delivery/resolveDelivery.sites.test.ts` (replaces the routingSites suite; same harness as Task 2's test):

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { selectQueue, channelRows } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  channelRows: [] as Array<{ id: string; orgId: string | null; partnerId: string | null; enabled: boolean }>,
}));
vi.mock('../../db', async () => {
  const { notificationChannels } = await import('../../db/schema');
  const makeSelect = () => {
    let isChannelRead = false;
    const chain: any = {
      from: (table: unknown) => { isChannelRead = table === notificationChannels; return chain; },
      where: () => chain, orderBy: () => chain, limit: () => chain,
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(isChannelRead ? channelRows : selectQueue.shift() ?? []).then(resolve),
    };
    return chain;
  };
  return { db: { select: vi.fn(() => makeSelect()) } };
});

import { resolveDelivery } from './resolveDelivery';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const SITE_B = '44444444-4444-4444-8444-444444444444';

const rule = (conditions: Record<string, unknown>) => ({
  id: 'r1', orgId: ORG_ID, partnerId: null, name: 'Scoped routing', priority: 1, conditions,
  channelIds: [CHANNEL_ID], enabled: true, escalationPolicyId: null, isDefault: false,
});
const resolve = (siteId: string | null) => resolveDelivery({ orgId: ORG_ID, severity: 'high', siteId });

describe('routing site matching (moved from notificationDispatcher.routingSites.test.ts)', () => {
  beforeEach(() => {
    selectQueue.length = 0;
    channelRows.splice(0, channelRows.length, { id: CHANNEL_ID, orgId: ORG_ID, partnerId: null, enabled: true });
  });

  it('matches a site-restricted rule when the firing device is at an included site', async () => {
    selectQueue.push([{ partnerId: null }], [rule({ severities: ['high'], siteIds: [SITE_A] })]);
    await expect(resolve(SITE_A)).resolves.toMatchObject({ channelIds: [CHANNEL_ID], source: 'routing_rule' });
  });
  it('skips a site-restricted rule when the firing device is at another site', async () => {
    selectQueue.push([{ partnerId: null }], [rule({ severities: ['high'], siteIds: [SITE_A] })]);
    await expect(resolve(SITE_B)).resolves.toMatchObject({ channelIds: [], source: 'none' });
  });
  it('fails closed when a site-restricted rule cannot resolve the firing device site', async () => {
    selectQueue.push([{ partnerId: null }], [rule({ severities: ['high'], siteIds: [SITE_A] })]);
    await expect(resolve(null)).resolves.toMatchObject({ channelIds: [], source: 'none' });
  });
  it('preserves unrestricted routing rules when the device site is unavailable', async () => {
    selectQueue.push([{ partnerId: null }], [rule({ severities: ['high'] })]);
    await expect(resolve(null)).resolves.toMatchObject({ channelIds: [CHANNEL_ID], source: 'routing_rule' });
  });
});
```

`notificationDispatcher.monitorDelivery.test.ts` — replace the `describe` block at lines 147-249 (helpers above it unchanged; add the constant right above the `describe`):

```ts
const ORG_LOOKUP = [{ partnerId: null }];
const DEFAULT_ROW = {
  id: 'default-row', orgId: 'org-1', partnerId: null, name: 'Everything else', priority: 1000000,
  conditions: {}, channelIds: ['aaaaaaaa-0000-4000-8000-000000000014'], enabled: true, escalationPolicyId: null, isDefault: true,
};

describe('processAlertNotifications monitor delivery (#5290, on resolveDelivery since W05b)', () => {
  it("routes a rule-less monitor alert to the monitor's own channels and schedules its escalation policy", async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })], // 1 alert
      [{ id: 'device-1', displayName: 'Server-1' }], // 2 device
      ORG_LOOKUP, // 4 org (dispatcher)
      ORG_LOOKUP, // 5 org (resolver)
      [{ kind: 'cpu', deliveryMode: 'channels', deliveryChannelIds: ['aaaaaaaa-0000-4000-8000-000000000011'], escalationPolicyId: 'ep1' }], // 6 monitor
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }], // 8 validChannels (baseline)
      [{ id: 'ep1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000011'] }] }], // 9 escalation policy
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }] // 9 validChannels (escalation)
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000011']);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'aaaaaaaa-0000-4000-8000-000000000011', escalationStep: 1 });
  });

  it('delivery_mode none is inbox only: no channel send, no routing lookup, no escalation', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'none', deliveryChannelIds: [], escalationPolicyId: 'ep1' }],
      // Poison: consumed only on a regression (routing rows, validChannels).
      [DEFAULT_ROW],
      [{ id: 'should-not-be-used' }]
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(0);
    expect(result.inAppSent).toBe(true);
    expect(queueAddBulkMock).not.toHaveBeenCalled();
    expect(queueAddMock).not.toHaveBeenCalled(); // 'none' drops the monitor's escalation too
    expect(selectQueue).toHaveLength(2);
  });

  it('delivery_mode inherit resolves through routing rows and ends at the Everything else row', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null }],
      [DEFAULT_ROW], // 7 routing rows: only the default row
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000014' }] // 8 validChannels
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000014']);
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('inherit with no routing rows and no Everything else row is inbox only — the all-channels fallback is gone', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: null }],
      [], // routing rows
      [{ id: 'should-not-be-used' }] // poison: the old fallback query
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(0);
    expect(queueAddBulkMock).not.toHaveBeenCalled();
    expect(selectQueue).toHaveLength(1);
  });

  it('inherit + monitor escalation policy schedules escalation even when delivery is inbox only', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: 'ep1' }],
      [], // routing rows → source 'none'
      [{ id: 'ep1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000011'] }] }], // escalation policy
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }] // validChannels (escalation)
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(0);
    expect(queueAddBulkMock).not.toHaveBeenCalled();
    expect(queueAddMock).toHaveBeenCalledTimes(1);
  });

  it('an alert with both ruleId and monitorId resolves from the MONITOR, not the compiled rule\'s overrideSettings', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: 'rule-1', monitorId: 'monitor-1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ overrideSettings: { notificationChannelIds: ['stale-compiled'] }, managedByMonitorId: 'monitor-1' }], // 3 rule (managed)
      ORG_LOOKUP, ORG_LOOKUP,
      [{ kind: 'cpu', deliveryMode: 'channels', deliveryChannelIds: ['aaaaaaaa-0000-4000-8000-000000000011'], escalationPolicyId: null }],
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }]
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000011']);
  });

  it('an UNMANAGED rule keeps its overrideSettings (transitional legacy override, W05b → W05d)', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: 'rule-1', monitorId: null })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ overrideSettings: { notificationChannelIds: ['aaaaaaaa-0000-4000-8000-000000000013'] }, managedByMonitorId: null }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000013' }] // validChannels — no monitor read, no routing read
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    expect(queueAddMock).not.toHaveBeenCalled();
    expect(selectQueue).toHaveLength(0);
  });
});
```

`notificationDispatcher.configPolicyOverrides.test.ts` — replace the `describe` block at lines 142-214 (add the same `ORG_LOOKUP`/`DEFAULT_ROW` constants above it):

```ts
describe('processAlertNotifications config-policy delivery overrides (#5289 Task 9, on resolveDelivery since W05b)', () => {
  it('routes to the config-policy rule channels and schedules its escalation policy (transitional legacy override)', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: 'cpar1' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ escalationPolicyId: 'e1', notificationChannelIds: ['aaaaaaaa-0000-4000-8000-000000000012'] }], // 3 config_policy_alert_rules row
      ORG_LOOKUP, ORG_LOOKUP,
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000012' }], // 8 validChannels (baseline)
      [{ id: 'e1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000012'] }] }], // 9 policy
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000012' }] // 9 validChannels (escalation)
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000012']);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'aaaaaaaa-0000-4000-8000-000000000012', escalationStep: 1 });
  });

  it('with no delivery overrides, resolves through routing rows to the Everything else row and skips escalation', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: null, configPolicyId: 'cpar2' })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ escalationPolicyId: null, notificationChannelIds: null }],
      ORG_LOOKUP, ORG_LOOKUP,
      [DEFAULT_ROW], // 7 routing rows
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000014' }] // 8 validChannels
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    const bulkJobs = queueAddBulkMock.mock.calls[0]![0] as Array<{ data: { channelId: string } }>;
    expect(bulkJobs.map((j) => j.data.channelId)).toEqual(['aaaaaaaa-0000-4000-8000-000000000014']);
    expect(queueAddMock).not.toHaveBeenCalled();
  });

  it('leaves the unmanaged rule-based path unaffected', async () => {
    selectQueue.push(
      [makeAlert({ ruleId: 'rule-1', configPolicyId: null })],
      [{ id: 'device-1', displayName: 'Server-1' }],
      [{ overrideSettings: { notificationChannelIds: ['aaaaaaaa-0000-4000-8000-000000000013'], escalationPolicyId: 'policy-1' }, managedByMonitorId: null }],
      ORG_LOOKUP, ORG_LOOKUP,
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000013' }],
      [{ id: 'policy-1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000013'] }] }],
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000013' }]
    );
    const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
    expect(result.queued).toBe(1);
    expect(queueAddMock).toHaveBeenCalledTimes(1);
    expect(queueAddMock.mock.calls[0]![1]).toEqual({ type: 'send', alertId: 'alert-1', channelId: 'aaaaaaaa-0000-4000-8000-000000000013', escalationStep: 1 });
  });
});
```

`notificationDispatcher.orderingGuards.test.ts` — every 6-entry baseline queue (`:157-164`, `:183-190`, `:209-216`, `:229-236`, `:290-297`) currently reads `alert, device, org, [] routing, [{id:'aaaaaaaa-0000-4000-8000-000000000013'}] fallback, validChannels`. Replace each with `alert, device, ORG_LOOKUP, ORG_LOOKUP, [DEFAULT_ROW_C1], validChannels` where, added once near the helpers:

```ts
const ORG_LOOKUP = [{ partnerId: null }];
const DEFAULT_ROW_C1 = {
  id: 'default-row', orgId: 'org-1', partnerId: null, name: 'Everything else', priority: 1000000,
  conditions: {}, channelIds: ['aaaaaaaa-0000-4000-8000-000000000013'], enabled: true, escalationPolicyId: null, isDefault: true,
};
```
(The `:229-236` case keeps its webhook `validChannels` entry `[{ id: 'aaaaaaaa-0000-4000-8000-000000000013', type: 'webhook', config }]`.) Expectations are unchanged.

`notificationRailsPartnerRls.integration.test.ts:384-407` — retitle and seed the partner's default row:

```ts
  it("a partner-wide Everything else row delivers member-org alerts only (the no-rules fallback is gone)", async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const deviceA = await seedDevice(orgA.id, 'rail-fallback-a');
    const deviceB = await seedDevice(orgB.id, 'rail-fallback-b');
    const alertA = await seedAlert(orgA.id, deviceA);
    const alertB = await seedAlert(orgB.id, deviceB);

    // Partner A has a partner-wide channel AND its Everything else row
    // (what the W05b migration writes for it). No other rules anywhere.
    const channelA = await seedPartnerChannel(partnerA.id);
    const [defaultA] = await withDbAccessContext(partnerContext(partnerA.id, []), () =>
      db.insert(notificationRoutingRules).values({
        orgId: null, partnerId: partnerA.id, name: 'Everything else', priority: 1000000,
        conditions: {}, channelIds: [channelA], enabled: true, isDefault: true,
      }).returning(),
    );
    createdRules.push(defaultA!.id);

    const resultA = await withDbAccessContext(SYSTEM_CTX, () =>
      processAlertNotifications({ type: 'process-alert', alertId: alertA }),
    );
    expect(resultA.queued).toBe(1); // the default row found the partner-wide channel

    const resultB = await withDbAccessContext(SYSTEM_CTX, () =>
      processAlertNotifications({ type: 'process-alert', alertId: alertB }),
    );
    expect(resultB.queued).toBe(0); // another partner's row NEVER leaks in; no row → inbox only
  });
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd apps/api && npx vitest run src/services/delivery/resolveDelivery.sites.test.ts src/services/notificationDispatcher.monitorDelivery.test.ts src/services/notificationDispatcher.configPolicyOverrides.test.ts src/services/notificationDispatcher.orderingGuards.test.ts
```
Expected: the new monitorDelivery/configPolicyOverrides cases fail on `queued` counts (old code consumes the queue in the old order and hits the fallback); `resolveDelivery.sites` passes already (it only needs Task 2) — that is fine, it is the moved suite.

- [ ] **Step 3: Implement** — `notificationDispatcher.ts`:

(a) Imports: add
```ts
import { resolveDelivery } from './delivery/resolveDelivery';
import { partnerIdForOrg, railOwnershipCondition } from './delivery/railOwnership';
```
remove `notificationRoutingRules`, `monitorDefinitions` from the `../db/schema` import and `asc`, `isNull`, `or`, `Column` from the `drizzle-orm` import if nothing else in the file uses them (tsc/eslint `no-unused-vars` will say). Delete the local `partnerIdForOrg` and `railOwnershipCondition` definitions (`:126-160`) and their doc comment.

(b) Replace `:264-376` (from `// Get notification channels — from rule overrides or org defaults` through the `if (channelIds.length === 0) { ... return ... }` that follows the fallback) with:

```ts
  // ONE delivery decision (W05b, spec §Delivery resolution). resolveDelivery is
  // shared with GET /alerts/delivery/resolve, so what the monitor editor
  // previews is what fires here. The all-enabled-channels fallback is gone: the
  // "Everything else" routing row is the default a technician can read.
  let monitorId: string | null = alert.monitorId ?? null;
  let legacyOverride: { channelIds?: string[] | null; escalationPolicyId?: string | null } | null = null;

  if (alert.ruleId) {
    const [rule] = await db
      .select({ overrideSettings: alertRules.overrideSettings, managedByMonitorId: alertRules.managedByMonitorId })
      .from(alertRules)
      .where(eq(alertRules.id, alert.ruleId))
      .limit(1);
    if (rule) {
      monitorId = monitorId ?? rule.managedByMonitorId ?? null;
      if (!rule.managedByMonitorId) {
        // Transitional (spec §Delivery resolution "Transitional", W05b → W05d):
        // an UNMANAGED legacy rule keeps its own channel/escalation overrides
        // until it is converted. W05c adds `retired_at IS NULL` to this lookup;
        // W05c1 Task 8 covers BOTH legacy lookups with a queued-dispatch regression.
        // W05d deletes the branch. A MANAGED (monitor-compiled) rule is never
        // read for delivery — the monitor definition is the source of truth.
        const overrides = (rule.overrideSettings ?? {}) as Record<string, unknown>;
        legacyOverride = {
          channelIds: Array.isArray(overrides.notificationChannelIds) ? (overrides.notificationChannelIds as string[]) : null,
          escalationPolicyId: typeof overrides.escalationPolicyId === 'string' ? overrides.escalationPolicyId : null,
        };
      }
    }
  } else if (alert.configPolicyId) {
    // Config-policy inline rule (#5289 Task 9): `configPolicyId` holds the
    // config_policy_alert_rules row id (historical column name). Same
    // transitional treatment as an unmanaged alert_rules row. W05c1 Task 8 adds
    // isNull(configPolicyAlertRules.retiredAt) here, alongside alertRules.retiredAt above.
    const [cpRule] = await db
      .select({
        escalationPolicyId: configPolicyAlertRules.escalationPolicyId,
        notificationChannelIds: configPolicyAlertRules.notificationChannelIds
      })
      .from(configPolicyAlertRules)
      .where(eq(configPolicyAlertRules.id, alert.configPolicyId))
      .limit(1);
    if (cpRule) {
      legacyOverride = { channelIds: cpRule.notificationChannelIds ?? null, escalationPolicyId: cpRule.escalationPolicyId ?? null };
    }
  }

  // Dual-axis rail resolution (#2130): the alert org's partner, for the
  // channel validation and escalation lookups below.
  const orgPartnerId = await partnerIdForOrg(alert.orgId);

  const resolved = await resolveDelivery({
    orgId: alert.orgId,
    severity: alert.severity as AlertSeverity,
    monitorId,
    siteId: device?.siteId ?? null,
    legacyOverride
  });

  // Escalation resolves independently of channels (spec): "inbox now, page
  // on-call in 30 minutes" is a valid configuration, so schedule it whether or
  // not a baseline send goes out.
  const scheduleResolvedEscalation = async () => {
    if (resolved.escalationPolicyId) {
      await scheduleEscalation(data.alertId, resolved.escalationPolicyId, alert.orgId, orgPartnerId);
    }
  };

  let channelIds = resolved.channelIds;
  if (channelIds.length === 0) {
    console.log(`[NotificationDispatcher] Delivery for alert ${data.alertId} resolved to inbox only (source=${resolved.source})`);
    await scheduleResolvedEscalation();
    return { queued: 0, inAppSent, durationMs: Date.now() - startTime };
  }
```

(c) Replace `:378-400` (the second eligibility filter and its early returns). Eligibility belongs solely to the resolver. Load transport options for those IDs, then map the jobs over `channelIds` (not query results), preserving `retryIfFailedJob`, baseline job IDs and the retry options:

```ts
const channelOptions = await db.select({ id: notificationChannels.id, type: notificationChannels.type, config: notificationChannels.config })
  .from(notificationChannels).where(inArray(notificationChannels.id, channelIds));
const optionsById = new Map(channelOptions.map(channel => [channel.id, channel]));
const validChannels = channelIds.map(id => optionsById.get(id) ?? { id, type: 'unknown', config: {} });
```

There is no dispatcher eligibility filter or post-filter early return. The zero-channel branch above **always** calls `scheduleResolvedEscalation`; retain the mandatory disabled-channel regression in Task 17 as a PR-1 gate. The send worker still checks live state at egress to handle changes after resolution. Replace `:441-446` with:

```ts
await scheduleResolvedEscalation();
```

(d) Delete `resolveRoutingRules` (`:1245-1300`, including its doc comment) and `git rm apps/api/src/services/notificationDispatcher.routingSites.test.ts` (its replacement is `services/delivery/resolveDelivery.sites.test.ts`).

- [ ] **Step 4: Run, expect PASS**

```bash
(cd apps/api && npx vitest run src/services/delivery src/services/notificationDispatcher && npx tsc --noEmit -p .)
if rg -n "resolveRoutingRules" apps/api/src; then
  echo "Stale resolver reference remains" >&2
  exit 1
fi
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/notificationRailsPartnerRls.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/notificationDispatcher.ts apps/api/src/services/notificationDispatcher*.test.ts apps/api/src/services/delivery/resolveDelivery.sites.test.ts apps/api/src/__tests__/integration/notificationRailsPartnerRls.integration.test.ts
git rm apps/api/src/services/notificationDispatcher.routingSites.test.ts
git commit -m "feat(api): dispatcher delivers through resolveDelivery; all-channels fallback deleted (W05b)"
```

---

### Task 5: Typed escalation-policy steps

**Files:**
- Modify: `apps/api/src/routes/alerts/schemas.ts:180-191`
- Modify: `apps/api/src/routes/alerts/policies.authz.test.ts:175,187` (fixtures `steps: []` → one valid step)
- Test: `apps/api/src/routes/alerts/policies.steps.test.ts`

**Interfaces:**
- Produces: `export const escalationStepSchema: z.ZodType<EscalationStep>; EscalationStep = { delayMinutes: number; channelIds: string[]; userIds: string[]; repeat?: { everyMinutes: number; maxTimes: number } }`; `createPolicySchema.steps` = `z.array(escalationStepSchema).min(1).max(10)`; `updatePolicySchema.steps` = same, optional. Exported `EscalationStep` type.
- D18: steps target channels and/or users; `repeat.everyMinutes` is 1..10080 and `maxTimes` is 1..100 **additional** sends after the first. All delays are absolute from initial scheduling; acknowledgements/resolution cancel every occurrence. User targets create deduplicated in-app notifications. The execution task below implements these fields in PR 1; Task 12 exposes them in PR 2.

- [ ] **Step 1: Write the failing test** — `apps/api/src/routes/alerts/policies.steps.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { createPolicySchema, updatePolicySchema, escalationStepSchema } from './schemas';

const CH = '9a8b7c6d-2222-4333-8444-555566667777';

describe('escalation policy steps schema (W05b)', () => {
  it('accepts delayMinutes + channelIds', () => {
    expect(escalationStepSchema.safeParse({ delayMinutes: 15, channelIds: [CH] }).success).toBe(true);
  });
  it('rejects a step with no targets, a zero delay, and invalid user IDs', () => {
    expect(escalationStepSchema.safeParse({ delayMinutes: 15, channelIds: [] }).success).toBe(false);
    expect(escalationStepSchema.safeParse({ delayMinutes: 0, channelIds: [CH] }).success).toBe(false);
    expect(escalationStepSchema.safeParse({ delayMinutes: 5, channelIds: [CH], userIds: ['u'] }).success).toBe(false);
  });
  it('accepts user-only steps and bounded repeats; rejects malformed repetition', () => {
    expect(escalationStepSchema.parse({ delayMinutes: 5, userIds: [CH], repeat: { everyMinutes: 10, maxTimes: 2 } }))
      .toEqual({ delayMinutes: 5, channelIds: [], userIds: [CH], repeat: { everyMinutes: 10, maxTimes: 2 } });
    for (const repeat of [{ everyMinutes: 0, maxTimes: 2 }, { everyMinutes: 10, maxTimes: 0 }, { everyMinutes: 10, maxTimes: 101 }]) {
      expect(escalationStepSchema.safeParse({ delayMinutes: 5, channelIds: [CH], repeat }).success).toBe(false);
    }
  });
  it('create requires 1..10 steps; update keeps steps optional', () => {
    expect(createPolicySchema.safeParse({ name: 'On-call', steps: [] }).success).toBe(false);
    expect(createPolicySchema.safeParse({ name: 'On-call', steps: [{ delayMinutes: 5, channelIds: [CH] }] }).success).toBe(true);
    expect(createPolicySchema.safeParse({ name: 'On-call', steps: 'nope' }).success).toBe(false);
    expect(updatePolicySchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
cd apps/api && npx vitest run src/routes/alerts/policies.steps.test.ts
```
Expected: `escalationStepSchema` is not exported; `steps: []` parses successfully today (`z.any()`).

- [ ] **Step 3: Implement** — `schemas.ts:180-191`:

```ts
export const escalationStepSchema = z.object({
  delayMinutes: z.number().int().min(1).max(10080),
  channelIds: z.array(z.string().guid()).max(100).default([]),
  userIds: z.array(z.string().guid()).max(100).default([]),
  repeat: z.object({ everyMinutes: z.number().int().min(1).max(10080),
    maxTimes: z.number().int().min(1).max(100) }).strict().optional(),
}).strict().refine(step => step.channelIds.length + step.userIds.length > 0, 'At least one target is required');
export type EscalationStep = z.infer<typeof escalationStepSchema>;

export const createPolicySchema = z.object({
  orgId: z.string().guid().optional(),
  // 'partner' creates a partner-wide ("all orgs") escalation policy (#2130).
  ownerScope: z.enum(['organization', 'partner']).optional(),
  name: z.string().min(1).max(255),
  steps: z.array(escalationStepSchema).min(1).max(10)
});

export const updatePolicySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  steps: z.array(escalationStepSchema).min(1).max(10).optional()
});
```
`policies.authz.test.ts:175,187`: `steps: []` → `steps: [{ delayMinutes: 5, channelIds: ['9a8b7c6d-2222-4333-8444-555566667777'] }]`.

- [ ] **Step 4: Run, expect PASS**

```bash
cd apps/api && npx vitest run src/routes/alerts/policies
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/alerts/schemas.ts apps/api/src/routes/alerts/policies.steps.test.ts apps/api/src/routes/alerts/policies.authz.test.ts
git commit -m "feat(api): typed escalation policy steps (W05b)"
```

---

### Task 6: Execute user escalation targets and bounded repeats (PR 1)

**Files:**
- Create: `apps/api/src/services/delivery/escalationExecution.ts`, `escalationExecution.test.ts`
- Modify: `apps/api/src/services/notificationDispatcher.ts:85-124,1306-1427` (job union/worker, scheduling, cancellation)
- Modify: `apps/api/src/routes/alerts/policies.ts:157-165,210-229` (validate targets before insert/update)
- Modify: `apps/api/src/services/notificationDispatcher.monitorDelivery.test.ts:28-61` (queue cancellation mock)
- Read: `apps/api/src/services/notificationSenders/inAppSender.ts:65-105,178-218`, `apps/api/src/db/schema/users.ts:132-153`, `apps/api/src/db/schema/notifications.ts:33-67`. The existing targeted sender has no dedupe key; the new executor uses the existing unique `(user_id,dedupe_key)` index instead.

**Interfaces:**
- Consumes Task 5 `EscalationStep`; existing channel `processSendNotification` durable status/dedupe guard.
- Produces `escalationOccurrences(steps)`, `listEscalationUsers(owner, executor?)`, `validateEscalationUsers(steps, owner, executor?)`, `processUserEscalation(data, executor?)`; `UserEscalationJob = { type: 'escalation-user'; alertId; userId; escalationStep: number }`.
- First occurrence keeps existing `escalationStep = index + 1`; repeat r uses `r * 10 + index + 1` (at most ten steps). Thus old pending channel jobs retain identity and each repeat gets a different durable send identity. `maxTimes` counts additional sends; delay is `delayMinutes + r * everyMinutes` from scheduling. User notifications have no external egress and commit in the background worker’s existing short system transaction; the service requires that transaction and never changes the caller’s scope.

- [ ] **Step 1: Write the failing test**

```ts
// escalationExecution.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[][], values: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => { const q: any = { from: () => q, where: () => q, limit: () => q, for: () => q,
      then: (ok: any, bad: any) => Promise.resolve(state.rows.shift() ?? []).then(ok, bad) }; return q; },
    execute: async () => state.rows.shift() ?? [],
    insert: () => ({ values: (v: unknown) => { state.values(v); return { onConflictDoNothing: async () => [] }; } }),
  },
  assertInTransaction: vi.fn(),
}));
import { assertInTransaction } from '../../db';
import { escalationOccurrences, processUserEscalation, validateEscalationUsers } from './escalationExecution';
beforeEach(() => { state.rows.length = 0; vi.clearAllMocks(); });
it('keeps old step IDs and allocates unique repeat identities at exact delays', () => {
  expect(escalationOccurrences([{ delayMinutes: 5, channelIds: ['ch'], userIds: ['u'], repeat: { everyMinutes: 10, maxTimes: 2 } }])
    .map(o => [o.escalationStep, o.delayMs])).toEqual([[1, 300000], [11, 900000], [21, 1500000]]);
});
it.each(['acknowledged', 'resolved', 'suppressed', 'dismissed'])('does not notify after %s, including jobs already active', async status => {
  state.rows.push([{ id: 'a', orgId: 'o', status }]);
  await processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 11 });
  expect(state.values).not.toHaveBeenCalled();
});
it('uses an occurrence-specific durable key and does not conflate baseline in-app notices', async () => {
  state.rows.push([{ id: 'a', orgId: 'o', status: 'active', title: 'CPU', message: 'High', severity: 'high' }],
    [{ partnerId: 'p' }], [{ id: 'u', name: 'Alex' }]);
  await processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 11 });
  expect(state.values).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', orgId: 'o', dedupeKey: 'escalation:a:11:u' }));
});
it('requires an existing transaction instead of changing scope itself', async () => {
  vi.mocked(assertInTransaction).mockImplementationOnce(() => { throw new Error('transaction required'); });
  await expect(processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 1 }))
    .rejects.toThrow('transaction required');
  expect(state.values).not.toHaveBeenCalled();
});
it('rejects missing/foreign targets before policy writes', async () => {
  state.rows.push([{ partnerId: 'p' }], []);
  await expect(validateEscalationUsers([{ delayMinutes: 5, channelIds: [], userIds: ['foreign'] }],
    { orgId: 'o', partnerId: null })).rejects.toMatchObject({ status: 400 });
});
it('drops a user who lost membership before execution', async () => {
  state.rows.push([{ id: 'a', orgId: 'o', status: 'active' }], [{ partnerId: 'p' }], []);
  await processUserEscalation({ type: 'escalation-user', alertId: 'a', userId: 'u', escalationStep: 1 });
  expect(state.values).not.toHaveBeenCalled();
});
```

In `notificationDispatcher.monitorDelivery.test.ts` extend the hoisted state with `queueDelayedMock: vi.fn()`; use `getDelayed = queueDelayedMock` in its Queue mock, reset it to `mockResolvedValue([])` in `beforeEach`, import `cancelAlertEscalations`, then add:

```ts
it('cancels channel and user repetitions but leaves baseline jobs alone', async () => {
  const jobs = [
    { type: 'send', alertId: 'alert-1', channelId: 'c', escalationStep: 11 },
    { type: 'escalation-user', alertId: 'alert-1', userId: 'u', escalationStep: 21 },
    { type: 'send', alertId: 'alert-1', channelId: 'c' },
  ].map(data => ({ data, remove: vi.fn(async () => {}) }));
  queueDelayedMock.mockResolvedValue(jobs);
  expect(await cancelAlertEscalations('alert-1')).toBe(2);
  expect(jobs[2]!.remove).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
(cd apps/api && npx vitest run src/services/delivery/escalationExecution.test.ts src/services/notificationDispatcher.monitorDelivery.test.ts)
```
Expected: missing `./escalationExecution`; cancellation returns 1 instead of 2.

- [ ] **Step 3: Implement**

```ts
// services/delivery/escalationExecution.ts
import { eq, sql } from 'drizzle-orm';
import { db, assertInTransaction } from '../../db';
import { alerts, userNotifications } from '../../db/schema';
import type { EscalationStep } from '../../routes/alerts/schemas';
import { partnerIdForOrg, type DbExecutor } from './railOwnership';
import { DeliveryWriteError, type RoutingOwner } from './routingRuleWrites';

export interface UserEscalationJob { type: 'escalation-user'; alertId: string; userId: string; escalationStep: number }
export function escalationOccurrences(steps: EscalationStep[]) {
  return steps.flatMap((step, index) => Array.from({ length: 1 + (step.repeat?.maxTimes ?? 0) }, (_, repeat) => ({
    ...step, escalationStep: repeat * 10 + index + 1,
    delayMs: (step.delayMinutes + repeat * (step.repeat?.everyMinutes ?? 0)) * 60000,
  })));
}
export async function listEscalationUsers(owner: RoutingOwner, executor: DbExecutor = db): Promise<Array<{ id: string; name: string }>> {
  const partner = owner.orgId ? await partnerIdForOrg(owner.orgId, executor) : owner.partnerId;
  const rows = await executor.execute<{ id: string; name: string }>(sql`
    SELECT DISTINCT u.id, u.name FROM users u WHERE u.status = 'active' AND (
      (${owner.orgId}::uuid IS NOT NULL AND EXISTS (
        SELECT 1 FROM organization_users ou WHERE ou.user_id = u.id AND ou.org_id = ${owner.orgId}::uuid
          AND ou.site_ids IS NULL AND ou.device_group_ids IS NULL
      )) OR EXISTS (
        SELECT 1 FROM partner_users pu WHERE pu.user_id = u.id AND pu.partner_id = ${partner}::uuid
          AND (pu.org_access = 'all' OR (${owner.orgId}::uuid IS NOT NULL
            AND pu.org_access = 'selected' AND ${owner.orgId}::uuid = ANY(pu.org_ids)))
      )) ORDER BY u.name, u.id
  `);
  return Array.from(rows);
}
export async function validateEscalationUsers(steps: EscalationStep[], owner: RoutingOwner, executor: DbExecutor = db) {
  const requested = [...new Set(steps.flatMap(step => step.userIds))];
  if (!requested.length) return;
  const available = new Set((await listEscalationUsers(owner, executor)).map(user => user.id));
  if (requested.some(id => !available.has(id))) throw new DeliveryWriteError(400, 'Escalation users are not available to this owner');
}
export async function processUserEscalation(data: UserEscalationJob, executor: DbExecutor = db): Promise<void> {
  assertInTransaction('processUserEscalation');
  const [alert] = await executor.select().from(alerts).where(eq(alerts.id, data.alertId)).limit(1).for('update');
  if (!alert || alert.status !== 'active') return;
  const eligible = await listEscalationUsers({ orgId: alert.orgId, partnerId: null }, executor);
  if (!eligible.some(user => user.id === data.userId)) return;
  await executor.insert(userNotifications).values({
    userId: data.userId, orgId: alert.orgId, type: 'alert', priority: 'urgent',
    title: alert.title, message: alert.message, link: `/alerts/${alert.id}`,
    metadata: { alertId: alert.id, escalationStep: data.escalationStep }, read: false,
    dedupeKey: `escalation:${alert.id}:${data.escalationStep}:${data.userId}`,
  }).onConflictDoNothing();
}

```

Use the actual schema parser for stored steps (older rows omit `userIds`): import `escalationStepSchema` into the dispatcher; in `scheduleEscalation`, replace the type assertion with:

```ts
const parsed = escalationStepSchema.array().min(1).max(10).safeParse(policy.steps);
if (!parsed.success) throw new Error(`Invalid escalation policy ${policy.id}`);
const steps = parsed.data;
```

Import `escalationOccurrences`, `listEscalationUsers`, `processUserEscalation`, and `UserEscalationJob`. Add `UserEscalationJob` to `NotificationJobData` and this worker case:

```ts
case 'escalation-user': {
  // Background entry point establishes the same context as process-alert.
  const userJob = job.data;
  return runWithSystemDbAccess(() => processUserEscalation(userJob));
}
```

Keep the existing enabled/owner-scoped escalation-channel query and retry handling. Replace the outer `for (let i = 0; i < steps.length; i++)` scheduling loop with the following; first-channel job IDs stay byte-compatible with existing queued jobs:

```ts
const requestedUsers = steps.some(step => step.userIds.length > 0);
const eligibleUsers = new Set(requestedUsers
  ? (await listEscalationUsers({ orgId, partnerId: null })).map(user => user.id) : []);
for (const step of escalationOccurrences(steps)) {
  for (const channelId of [...new Set(step.channelIds)].filter(id => validChannelIdSet.has(id))) {
    const channel = validChannelById.get(channelId)!;
    const job = await queue.add('send', { type: 'send', alertId, channelId, escalationStep: step.escalationStep }, {
      delay: step.delayMs, jobId: `escalation-${alertId}-step${step.escalationStep}-${channelId}`,
      attempts: notificationJobAttempts(channel.type, channel.config),
      backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: true, removeOnFail: { age: 3600 },
    });
    await retryIfFailedJob(job, `alert ${alertId} escalation step ${step.escalationStep}`);
  }
  for (const userId of [...new Set(step.userIds)].filter(id => eligibleUsers.has(id))) {
    const job = await queue.add('escalation-user', { type: 'escalation-user', alertId, userId, escalationStep: step.escalationStep }, {
      delay: step.delayMs, jobId: `escalation-${alertId}-step${step.escalationStep}-user-${userId}`,
      attempts: 3, backoff: { type: 'exponential', delay: 30000 }, removeOnComplete: true, removeOnFail: { age: 3600 },
    });
    await retryIfFailedJob(job, `alert ${alertId} user escalation ${step.escalationStep}`);
  }
}
```

In `cancelAlertEscalations`, replace its condition with:

```ts
if ((job.data.type === 'send' || job.data.type === 'escalation-user') &&
    job.data.alertId === alertId && job.data.escalationStep) {
  await job.remove(); cancelled++;
}
```

In `policies.ts` import `validateEscalationUsers`, `DeliveryWriteError`, `canMutateOrgWideGovernance`, `SITE_CEILING_WRITE_DENIED_MESSAGE`. Add the governance guard before any POST/PUT/DELETE write, and insert this before POST's insert and PUT's update respectively (owner for PUT is `{ orgId: policy.orgId, partnerId: policy.partnerId }`):

```ts
if (!canMutateOrgWideGovernance(auth)) return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
try {
  if (data.steps) await validateEscalationUsers(data.steps, owner);
} catch (error) {
  if (error instanceof DeliveryWriteError) return c.json({ error: error.message }, error.status);
  throw error;
}
```

For the PUT snippet, declare the immutable owner immediately after its existing `getEscalationPolicyWithOrgCheck`/partner-capability guard:

```ts
const owner = { orgId: policy.orgId, partnerId: policy.partnerId };
```

Keep the channel write validation already specified for routing/AI; additionally call `validateEscalationUsers(data.steps, owner)` in both Task 15 AI escalation mutations. `policies.authz.test.ts` keeps channel-only fixtures; no target-user query occurs for them. For DELETE use only the governance guard, since there is no `data.steps`.

- [ ] **Step 4: Run, expect PASS**

```bash
(cd apps/api && npx vitest run src/services/delivery/escalationExecution.test.ts src/services/notificationDispatcher src/routes/alerts/policies)
```
Expected: precise occurrence timing/identity, cancellation, current-membership and inactive-status regressions pass. Existing channel escalation retry/dedupe tests remain green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/delivery/escalationExecution.ts apps/api/src/services/delivery/escalationExecution.test.ts apps/api/src/services/notificationDispatcher.ts apps/api/src/services/notificationDispatcher.monitorDelivery.test.ts apps/api/src/routes/alerts/policies.ts
git commit -m "feat(alerts): deliver user escalations and cancel bounded repeats (W05b)"
```

---

### Task 7: Integration gate (part 1) — dispatcher ⇄ resolver on real Postgres

**Files:**
- Create: `apps/api/src/__tests__/integration/deliveryResolution.integration.test.ts`

**Interfaces:**
- Consumes: `processAlertNotifications` (system context), `resolveDelivery`, fixtures via `./db-utils` (`createPartner`, `createOrganization`), direct inserts under `withDbAccessContext` as in `notificationRailsPartnerRls.integration.test.ts:106-160, 285-326`.
- Extended in Task 13 with the endpoint leg (same file, same fixtures).

- [ ] **Step 1: Write the failing tests before applying Tasks 2 and 4**

```ts
/**
 * W05b spec gate: the dispatcher and the resolver (and, from Task 13, the
 * preview endpoint) agree for the org-row, partner-row, default-row and
 * inbox-only cases against real Postgres with the breeze_app role's RLS.
 *
 * Fixture: partner P with an enabled partner-wide channel; org O under P with
 * an enabled org channel, one site, one device at that site.
 */
import './setup';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  alerts, devices, escalationPolicies, monitorDefinitions, notificationChannels, notificationRoutingRules, sites,
} from '../../db/schema';
import { getNotificationQueue, processAlertNotifications, shutdownNotificationDispatcher } from '../../services/notificationDispatcher';
import { resolveDelivery } from '../../services/delivery/resolveDelivery';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const sys = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const created = { alerts: [] as string[], rules: [] as string[], policies: [] as string[], channels: [] as string[], monitors: [] as string[], devices: [] as string[], sites: [] as string[] };

afterAll(async () => { await shutdownNotificationDispatcher(); });
afterEach(async () => {
  await sys(async () => {
    if (created.alerts.length) await db.delete(alerts).where(inArray(alerts.id, created.alerts));
    for (const id of created.rules) await db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, id));
    for (const id of created.monitors) await db.delete(monitorDefinitions).where(eq(monitorDefinitions.id, id));
    for (const id of created.policies) await db.delete(escalationPolicies).where(eq(escalationPolicies.id, id));
    for (const id of created.channels) await db.delete(notificationChannels).where(eq(notificationChannels.id, id));
    for (const id of created.devices) await db.delete(devices).where(eq(devices.id, id));
    for (const id of created.sites) await db.delete(sites).where(eq(sites.id, id));
  });
  for (const k of Object.keys(created) as Array<keyof typeof created>) created[k].length = 0;
});

export interface DeliveryFixture { partnerId: string; orgId: string; siteId: string; deviceId: string; partnerChannel: string; orgChannel: string }

export async function seedFixture(): Promise<DeliveryFixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const [site] = await sys(() => db.insert(sites).values({ orgId: org.id, name: 'HQ' }).returning());
  created.sites.push(site!.id);
  const [device] = await sys(() => db.insert(devices).values({
    orgId: org.id, siteId: site!.id, agentId: `agent-${site!.id.slice(0, 18)}`, hostname: 'delivery-gate',
    osType: 'windows', osVersion: '10.0', architecture: 'x64', agentVersion: '1.0.0',
  }).returning());
  created.devices.push(device!.id);
  const [pc] = await sys(() => db.insert(notificationChannels).values({ orgId: null, partnerId: partner.id, name: 'Partner NOC', type: 'slack', config: { webhookUrl: 'https://hooks.slack.example/p' }, enabled: true }).returning());
  const [oc] = await sys(() => db.insert(notificationChannels).values({ orgId: org.id, partnerId: null, name: 'Org email', type: 'slack', config: { webhookUrl: 'https://hooks.slack.example/o' }, enabled: true }).returning());
  created.channels.push(pc!.id, oc!.id);
  return { partnerId: partner.id, orgId: org.id, siteId: site!.id, deviceId: device!.id, partnerChannel: pc!.id, orgChannel: oc!.id };
}

async function seedRule(values: Partial<typeof notificationRoutingRules.$inferInsert> & { channelIds: string[] }) {
  const [row] = await sys(() => db.insert(notificationRoutingRules).values({ name: 'r', priority: 10, conditions: {}, enabled: true, orgId: null, partnerId: null, ...values }).returning());
  created.rules.push(row!.id);
  return row!;
}

async function seedAlert(f: DeliveryFixture, severity: 'critical' | 'high' | 'medium' | 'low', monitorId: string | null = null) {
  const [alert] = await sys(() => db.insert(alerts).values({ orgId: f.orgId, deviceId: f.deviceId, severity, status: 'active', title: 'gate', message: 'gate', monitorId }).returning());
  created.alerts.push(alert!.id);
  return alert!.id;
}

function orgCtx(f: DeliveryFixture): DbAccessContext {
  return { scope: 'organization', orgId: f.orgId, accessibleOrgIds: [f.orgId],
    accessiblePartnerIds: [], currentPartnerId: f.partnerId, userId: null };
}

async function dispatch(alertId: string) {
  return sys(() => processAlertNotifications({ type: 'process-alert', alertId }));
}

async function capturedDispatch(alertId: string) {
  const bulk = vi.spyOn(getNotificationQueue(), 'addBulk').mockResolvedValue([]);
  const single = vi.spyOn(getNotificationQueue(), 'add').mockResolvedValue({ getState: async () => 'waiting' } as never);
  try {
    const result = await dispatch(alertId);
    return { ...result, channelIds: bulk.mock.calls.flatMap(([jobs]) => jobs.map(job => job.data.channelId)) };
  } finally { bulk.mockRestore(); single.mockRestore(); }
}

describe('delivery resolution gate — dispatcher ⇄ resolver', () => {
  runDb('org-row: an org routing rule wins for a matching severity', async () => {
    const f = await seedFixture();
    const rule = await seedRule({ orgId: f.orgId, name: 'Org criticals', conditions: { severities: ['critical'] }, channelIds: [f.orgChannel] });
    const resolved = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'critical', siteId: f.siteId }));
    expect(resolved).toMatchObject({ source: 'routing_rule', routingRuleId: rule.id, channelIds: [f.orgChannel] });
    expect((await capturedDispatch(await seedAlert(f, 'critical'))).queued).toBe(resolved.channelIds.length);
  });

  runDb('partner-row: a partner-wide rule wins when no org rule matches; monitorKinds is honoured', async () => {
    const f = await seedFixture();
    const [monitor] = await sys(() => db.insert(monitorDefinitions).values({ orgId: f.orgId, partnerId: null, name: 'Disk full', kind: 'disk', condition: { operator: 'gt', value: 90 }, severity: 'high', deliveryMode: 'inherit' }).returning());
    created.monitors.push(monitor!.id);
    const rule = await seedRule({ partnerId: f.partnerId, name: 'Disk to NOC', conditions: { monitorKinds: ['disk'] }, channelIds: [f.partnerChannel] });
    const resolved = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'high', monitorId: monitor!.id, siteId: f.siteId }));
    expect(resolved).toMatchObject({ source: 'routing_rule', routingRuleId: rule.id, channelIds: [f.partnerChannel] });
    expect((await capturedDispatch(await seedAlert(f, 'high', monitor!.id))).queued).toBe(1);
  });

  runDb('default-row: the org Everything else row shadows the partner one; both channels fan out', async () => {
    const f = await seedFixture();
    await seedRule({ partnerId: f.partnerId, name: 'Everything else', priority: 1000000, channelIds: [f.partnerChannel], isDefault: true });
    const orgDefault = await seedRule({ orgId: f.orgId, name: 'Everything else', priority: 1000000, channelIds: [f.orgChannel, f.partnerChannel], isDefault: true });
    const resolved = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'low', siteId: f.siteId }));
    expect(resolved).toMatchObject({ source: 'default_row', routingRuleId: orgDefault.id });
    expect([...resolved.channelIds].sort()).toEqual([f.orgChannel, f.partnerChannel].sort());
    expect((await capturedDispatch(await seedAlert(f, 'low'))).queued).toBe(2);
  });

  runDb('inbox-only: monitor deliveryMode none sends nothing; an emptied Everything else row sends nothing; no row at all sends nothing', async () => {
    const f = await seedFixture();
    const [policy] = await sys(() => db.insert(escalationPolicies).values({ orgId: f.orgId, partnerId: null, name: 'On-call', steps: [{ delayMinutes: 5, channelIds: [f.orgChannel] }] }).returning());
    created.policies.push(policy!.id);
    const [monitor] = await sys(() => db.insert(monitorDefinitions).values({ orgId: f.orgId, partnerId: null, name: 'Quiet', kind: 'cpu', condition: { operator: 'gt', value: 90 }, severity: 'high', deliveryMode: 'none', escalationPolicyId: policy!.id }).returning());
    created.monitors.push(monitor!.id);
    await seedRule({ partnerId: f.partnerId, name: 'Everything else', priority: 1000000, channelIds: [f.partnerChannel], isDefault: true });

    const none = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'high', monitorId: monitor!.id, siteId: f.siteId }));
    expect(none).toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'monitor_none' });
    expect((await capturedDispatch(await seedAlert(f, 'high', monitor!.id))).queued).toBe(0);

    const orgDefault = await seedRule({ orgId: f.orgId, name: 'Everything else', priority: 1000000, channelIds: [], isDefault: true });
    const emptied = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'medium', siteId: f.siteId }));
    expect(emptied).toMatchObject({ source: 'default_row', routingRuleId: orgDefault.id, channelIds: [] });
    expect((await capturedDispatch(await seedAlert(f, 'medium'))).queued).toBe(0);

    await sys(() => db.delete(notificationRoutingRules).where(inArray(notificationRoutingRules.id, created.rules)));
    created.rules.length = 0;
    const nothing = await sys(() => resolveDelivery({ orgId: f.orgId, severity: 'medium', siteId: f.siteId }));
    expect(nothing).toEqual({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'none' });
    expect((await capturedDispatch(await seedAlert(f, 'medium'))).queued).toBe(0); // the fallback used to send to BOTH channels here
  });
  runDb('ordinary org reads and system dispatch select the same eligible IDs with an explicit owner predicate', async () => {
    const f = await seedFixture();
    const foreign = await seedFixture();
    const missing = '99999999-9999-4999-8999-999999999999';
    await sys(() => db.update(notificationChannels).set({ enabled: false }).where(eq(notificationChannels.id, f.orgChannel)));
    await seedRule({ orgId: f.orgId, channelIds: [f.partnerChannel, f.orgChannel, foreign.orgChannel, missing] });
    const facts = { orgId: f.orgId, severity: 'high' as const, siteId: f.siteId };
    const previewDecision = await withDbAccessContext(orgCtx(f), async () => {
      const role = await db.execute(sql`select current_user as role`);
      expect(role[0]?.role).toBe('breeze_app');
      return resolveDelivery(facts);
    });
    const dispatchDecision = await sys(() => resolveDelivery(facts));
    expect(previewDecision).toEqual(dispatchDecision);
    expect(previewDecision.channelIds).toEqual([f.partnerChannel]);
    expect(previewDecision.skippedChannelIds).toEqual([
      { id: f.orgChannel, reason: 'disabled' },
      { id: foreign.orgChannel, reason: 'unavailable' },
      { id: missing, reason: 'unavailable' },
    ]);
    const sent = await capturedDispatch(await seedAlert(f, 'high'));
    expect(sent.channelIds).toEqual(previewDecision.channelIds);
  });

  runDb('org reads inherit partner rails without acquiring any partner insert permission (42501)', async () => {
    const f = await seedFixture();
    const attempts: Array<() => Promise<unknown>> = [
      () => db.insert(notificationChannels).values({ orgId: null, partnerId: f.partnerId,
        name: 'Forbidden', type: 'slack', config: {}, enabled: true }).returning(),
      () => db.insert(notificationRoutingRules).values({ orgId: null, partnerId: f.partnerId,
        name: 'Forbidden', conditions: {}, channelIds: [], enabled: true }).returning(),
      () => db.insert(escalationPolicies).values({ orgId: null, partnerId: f.partnerId,
        name: 'Forbidden', steps: [] }).returning(),
    ];
    for (const attempt of attempts) {
      await expect(withDbAccessContext(orgCtx(f), attempt))
        .rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });

});
```

- [ ] **Step 2: Run it, expect FAIL** (execute this red gate before Tasks 2 and 4; confirm all six initial cases execute, 0 skipped (Task 8 adds the inherited-rails route case before PR 1), with `DATABASE_URL` set):

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deliveryResolution.integration.test.ts
```
Before Tasks 2 and 4, module discovery or decision assertions fail; the inbox-only case exposes the old fallback. Record that red result before implementing those tasks. The explicit owner predicate must also reject foreign IDs in system context, where RLS alone does not hide them. Task 13 adds the HTTP preview leg to these same fixtures.

- [ ] **Step 3: Implement** — nothing beyond Tasks 1–5 and Task 6; if a case fails, the resolver or the dispatcher is wrong, not the test.

- [ ] **Step 4: Run, expect PASS** — same command; then the whole PR-1 surface:

```bash
cd apps/api && npx vitest run src/services/delivery src/services/notificationDispatcher src/routes/alerts/routing src/routes/alerts/policies src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deliveryResolution.integration.test.ts src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts src/__tests__/integration/notificationRailsPartnerRls.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/__tests__/integration/deliveryResolution.integration.test.ts
git commit -m "test(api): delivery resolution gate — dispatcher and resolver agree on real Postgres (W05b)"
```
After Task 8 and Task 17 verification, open PR 1. PR 1 body: `Closes` nothing yet (the wave closes on PR 3); state the migration name check was re-run against `origin/main`; release-notes line: *New notification channels are not subscribed to anything until added to a routing row; existing behavior is preserved by the "Everything else" rows the migration writes.*

---

### Task 8: Read inherited partner rails without granting partner writes (PR 1)

**Files:**
- Create: `apps/api/src/routes/alerts/deliveryRails.ts`, `deliveryRails.test.ts`
- Create: `apps/api/src/services/delivery/inheritedRails.ts`, `inheritedRails.test.ts`
- Modify: `apps/api/src/routes/alerts/index.ts:8-21` (mount before catch-all)
- Modify: `apps/api/src/routes/alerts/routing.ts:58-93` (export `routingSiteIds` and `canAccessRoutingSites`, bodies unchanged; PR 1 owns these exports)
- Read: `apps/api/src/routes/alerts/channels.ts:59-68,92-97`, `policies.ts:35-39`, `routing.ts:135-139`, `helpers.ts:52-113,435-447`, `services/notificationChannelSecrets.ts` (`redactNotificationChannelConfig`). Existing administrative list/by-ID endpoints keep their write-access restrictions.

**Interfaces:**
- Produces `GET /alerts/delivery/rails?rail=channels|routing|escalation|users&orgId=<uuid>&ownerScope=partner|organization`. Channels return `{ data: editableChannels, inherited: InheritedChannel[] }`; routing/escalation return `{ data: Array<EditableRow | InheritedDTO> }`. Users retain `{ data: UserChoice[] }`.
- Org callers are pinned to their org. Partner/system callers with orgId get that org plus its actual parent partner, never a caller-supplied partner ID. Without orgId, partner scope reads its own editable rails only. `ownerScope=partner` is accepted only for users and partner/system principals with a partner ID.
- Service-level column projection produces exactly these inherited DTOs: channels `{ id, name, type, enabled, inherited: true }`; routing `{ id, name, priority, enabled, isDefault, conditions: { severities, monitorKinds, siteIds }, channelIds, escalationPolicyId, inherited: true }`; policies `{ id, name, stepCount, inherited: true }`. Inherited channels never select `config`, even for redaction. Policy step targets and user IDs never leave the database projection. Routing exposes only supported conditions and intersects site IDs with the selected org and caller's allowed sites; targeted rows with no visible sites and unrestricted rows for site-limited callers fail closed.
- Editable rows use their exact owner axis. Inherited reads use the supplied ordinary executor and an explicit `org_id IS NULL AND partner_id = <actual org parent>` predicate. Existing additive SELECT policies supply visibility; no new policy, allowlist change, runtime elevation, or widened mutation permission. Existing own-channel redaction remains unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// services/delivery/inheritedRails.test.ts
import { expect, it, vi } from 'vitest';
import { readInheritedRails } from './inheritedRails';
const ORG = '10000000-0000-4000-8000-000000000001';
const PARTNER = '20000000-0000-4000-8000-000000000001';
function executorFor(rows: unknown[][]) {
  const select = vi.fn((projection: Record<string, unknown>) => {
    const result = rows.shift() ?? [];
    const q: any = { from: () => q, where: () => q, orderBy: () => q,
      then: (ok: any, bad: any) => Promise.resolve(result.map(row => Object.fromEntries(
        Object.keys(projection).map(key => [key, (row as any)[key]])))).then(ok, bad) };
    return q;
  });
  return { select };
}
it('selects only inherited channel metadata, with no config key at any stage', async () => {
  const executor = executorFor([[{ id: 'ch', name: 'NOC', type: 'slack', enabled: true,
    config: { webhookUrl: 'secret' }, lastTestError: 'private' }]]);
  const result = await readInheritedRails('channels', { orgId: ORG, partnerId: PARTNER }, executor as any);
  expect(result).toEqual([{ id: 'ch', name: 'NOC', type: 'slack', enabled: true, inherited: true }]);
  expect(Object.keys(executor.select.mock.calls[0]![0]).sort()).toEqual(['enabled','id','name','type']);
  expect(result[0]).not.toHaveProperty('config');
});
it('projects stepCount, never policy targets or owner IDs', async () => {
  const executor = executorFor([[{ id: 'ep', name: 'On call', stepCount: 2, steps: [{ userIds: ['private'] }] }]]);
  expect(await readInheritedRails('escalation', { orgId: ORG, partnerId: PARTNER }, executor as any))
    .toEqual([{ id: 'ep', name: 'On call', stepCount: 2, inherited: true }]);
  expect(Object.keys(executor.select.mock.calls[0]![0]).sort()).toEqual(['id','name','stepCount']);
});
it('filters inherited routing sites and exposes only the supported condition fields', async () => {
  const executor = executorFor([[{ id: 'r', name: 'NOC', priority: 1, enabled: true, isDefault: false,
    conditions: { severities: ['high'], monitorKinds: ['cpu'], siteIds: ['visible','foreign'], deviceTags: ['private'] },
    channelIds: ['ch'], escalationPolicyId: 'ep' }], [{ id: 'visible' }]]);
  expect(await readInheritedRails('routing', { orgId: ORG, partnerId: PARTNER, allowedSiteIds: ['visible'] }, executor as any))
    .toEqual([{ id: 'r', name: 'NOC', priority: 1, enabled: true, isDefault: false,
      conditions: { severities: ['high'], monitorKinds: ['cpu'], siteIds: ['visible'] },
      channelIds: ['ch'], escalationPolicyId: 'ep', inherited: true }]);
});
it.each([[], ['unrelated']])('hides targeted routing rows with no visible sites: %j', async allowedSiteIds => {
  const executor = executorFor([[{ id: 'r', conditions: { siteIds: ['hidden'] } }], []]);
  expect(await readInheritedRails('routing', { orgId: ORG, partnerId: PARTNER, allowedSiteIds }, executor as any)).toEqual([]);
});
```

`routes/alerts/deliveryRails.test.ts` (independent route harness; real service with ordinary mocked executor):

```ts
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[][], authenticated: true, read: true, auth: {} as any }));
vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  requireMfa: () => async (_c: any, next: any) => next(),
  requireScope: () => async (c: any, next: any) => {
    if (!state.authenticated) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', state.auth); await next();
  },
  requirePermission: () => async (c: any, next: any) => {
    if (!state.read) return c.json({ error: 'Forbidden' }, 403); await next();
  },
}));
vi.mock('../../db', () => ({ db: { select: () => {
  const q: any = { from: () => q, where: () => q, orderBy: () => q, limit: () => q,
    then: (ok: any, bad: any) => Promise.resolve(state.rows.shift() ?? []).then(ok, bad) }; return q;
} } }));
import { deliveryRailsRoutes } from './deliveryRails';
const ORG = '10000000-0000-4000-8000-000000000001', PARTNER = '20000000-0000-4000-8000-000000000001';
const app = new Hono().route('/alerts', deliveryRailsRoutes);
beforeEach(() => {
  state.rows.length = 0; state.authenticated = true; state.read = true;
  state.auth = { scope: 'organization', orgId: ORG, partnerId: PARTNER, canAccessOrg: (id: string) => id === ORG };
});
it('exposes only the inherited channel DTO through HTTP', async () => {
  state.rows.push([{ partnerId: PARTNER }], [], [{ id: 'ch', name: 'NOC', type: 'slack', enabled: true }]);
  const res = await app.request('/alerts/delivery/rails?rail=channels');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: [], inherited: [{ id: 'ch', name: 'NOC', type: 'slack', enabled: true, inherited: true }] });
});
it('rejects a foreign org and partner user selection by an org token', async () => {
  expect((await app.request(`/alerts/delivery/rails?rail=routing&orgId=${PARTNER}`)).status).toBe(403);
  expect((await app.request('/alerts/delivery/rails?rail=users&ownerScope=partner')).status).toBe(403);
});
it('returns a safe 500 on a failed rail read', async () => {
  const { db } = await import('../../db');
  vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('private db detail'); });
  const res = await app.request('/alerts/delivery/rails?rail=routing');
  expect(res.status).toBe(500); expect(await res.text()).not.toContain('private db detail');
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
(cd apps/api && npx vitest run src/services/delivery/inheritedRails.test.ts src/routes/alerts/deliveryRails.test.ts)
```
Expected: missing `./deliveryRails` module.

- [ ] **Step 3: Implement**

In `routing.ts`, add `export` to the existing `routingSiteIds` and `canAccessRoutingSites` declarations; keep their signatures and bodies unchanged. The unit harness above retains the real `siteAccessCheck` and supplies `requireMfa` because importing this module registers its existing routes.

```ts
// services/delivery/inheritedRails.ts
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { notificationChannels, notificationRoutingRules, escalationPolicies, sites } from '../../db/schema';
type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type Context = { orgId: string; partnerId: string; allowedSiteIds?: string[] };
type Conditions = { severities?: string[]; monitorKinds?: string[]; siteIds?: string[] };
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
export async function readInheritedRails(rail: 'channels' | 'routing' | 'escalation', context: Context, executor: DbExecutor = db) {
  const { orgId, partnerId, allowedSiteIds } = context;
  if (rail === 'channels') {
    const c = notificationChannels;
    const rows = await executor.select({ id: c.id, name: c.name, type: c.type, enabled: c.enabled })
      .from(c).where(and(isNull(c.orgId), eq(c.partnerId, partnerId))).orderBy(asc(c.name));
    return rows.map(({ id, name, type, enabled }) => ({ id, name, type, enabled, inherited: true as const }));
  }
  if (rail === 'escalation') {
    const p = escalationPolicies;
    const rows = await executor.select({ id: p.id, name: p.name,
      stepCount: sql<number>`CASE WHEN jsonb_typeof(${p.steps}) = 'array' THEN jsonb_array_length(${p.steps}) ELSE 0 END`.mapWith(Number) })
      .from(p).where(and(isNull(p.orgId), eq(p.partnerId, partnerId))).orderBy(asc(p.name));
    return rows.map(({ id, name, stepCount }) => ({ id, name, stepCount, inherited: true as const }));
  }
  const r = notificationRoutingRules;
  const rows = await executor.select({ id: r.id, name: r.name, priority: r.priority, enabled: r.enabled,
    isDefault: r.isDefault, channelIds: r.channelIds, escalationPolicyId: r.escalationPolicyId,
    conditions: sql<Conditions>`jsonb_build_object('severities', ${r.conditions}->'severities',
      'monitorKinds', ${r.conditions}->'monitorKinds', 'siteIds', ${r.conditions}->'siteIds')` })
    .from(r).where(and(isNull(r.orgId), eq(r.partnerId, partnerId))).orderBy(asc(r.isDefault), asc(r.priority));
  const orgSites = await executor.select({ id: sites.id }).from(sites).where(eq(sites.orgId, orgId));
  const visibleSites = new Set(orgSites.filter(site => allowedSiteIds === undefined || allowedSiteIds.includes(site.id)).map(site => site.id));
  return rows.flatMap(({ id, name, priority, enabled, isDefault, conditions, channelIds, escalationPolicyId }) => {
    const targetedSites = strings(conditions.siteIds);
    const siteIds = targetedSites.filter(siteId => visibleSites.has(siteId));
    if ((targetedSites.length > 0 && siteIds.length === 0) || (targetedSites.length === 0 && allowedSiteIds !== undefined)) return [];
    return [{ id, name, priority, enabled, isDefault,
      conditions: { severities: strings(conditions.severities), monitorKinds: strings(conditions.monitorKinds), siteIds },
      channelIds, escalationPolicyId, inherited: true as const }];
  });
}
```

```ts
// routes/alerts/deliveryRails.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { notificationChannels, notificationRoutingRules, escalationPolicies } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { zValidator } from '../../lib/validation';
import { PERMISSIONS } from '../../services/permissions';
import { partnerIdForOrg } from '../../services/delivery/railOwnership';
import { readInheritedRails } from '../../services/delivery/inheritedRails';
import { listEscalationUsers } from '../../services/delivery/escalationExecution';
import { redactNotificationChannelConfig } from '../../services/notificationChannelSecrets';
import { resolveWriteOrgId } from './helpers';
import { canAccessRoutingSites, routingSiteIds } from './routing';
const querySchema = z.object({ rail: z.enum(['channels','routing','escalation','users']),
  orgId: z.string().guid().optional(), ownerScope: z.enum(['organization','partner']).optional() }).strict();
export const deliveryRailsRoutes = new Hono();
deliveryRailsRoutes.get('/delivery/rails', requireScope('organization','partner','system'),
  requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action),
  zValidator('query', querySchema), async c => {
    try {
      const auth = c.get('auth'), query = c.req.valid('query');
      const partnerOnly = query.ownerScope === 'partner' || (auth.scope === 'partner' && !query.orgId);
      if (query.ownerScope === 'partner' && query.rail !== 'users') return c.json({ error: 'ownerScope applies to users only' }, 400);
      if (partnerOnly && (auth.scope === 'organization' || !auth.partnerId)) return c.json({ error: 'Partner scope required' }, 403);
      const resolved: ReturnType<typeof resolveWriteOrgId> = partnerOnly ? {} : resolveWriteOrgId(auth, query.orgId);
      if (resolved.error) return c.json({ error: resolved.error }, resolved.status ?? 400);
      const orgId = resolved.orgId ?? null;
      const partnerId = orgId ? await partnerIdForOrg(orgId) : auth.partnerId;
      if (orgId && !partnerId) return c.json({ error: 'Organization not found' }, 404);
      const owner = { orgId, partnerId: orgId ? null : partnerId ?? null };
      const axis = (table: typeof notificationRoutingRules | typeof notificationChannels | typeof escalationPolicies) => orgId
        ? eq(table.orgId, orgId)
        : and(isNull(table.orgId), eq(table.partnerId, partnerId!));
      if (query.rail === 'users') return c.json({ data: await listEscalationUsers(owner) });
      const inherited = () => orgId && partnerId
        ? readInheritedRails(query.rail as 'channels' | 'routing' | 'escalation', { orgId, partnerId, allowedSiteIds: auth.allowedSiteIds }, db)
        : Promise.resolve([]);
      if (query.rail === 'routing') {
        const rows = await db.select().from(notificationRoutingRules)
          .where(axis(notificationRoutingRules)).orderBy(asc(notificationRoutingRules.isDefault), asc(notificationRoutingRules.priority));
        const visible = await Promise.all(rows.map(async row =>
          await canAccessRoutingSites(auth, { orgId: row.orgId, partnerId: row.partnerId }, routingSiteIds(row.conditions), false)
            ? row : null));
        return c.json({ data: [...visible.filter(row => row !== null), ...await inherited()] });
      }
      if (query.rail === 'escalation') {
        const editable = await db.select().from(escalationPolicies).where(axis(escalationPolicies)).orderBy(asc(escalationPolicies.name));
        return c.json({ data: [...editable, ...await inherited()] });
      }
      const rows = await db.select().from(notificationChannels).where(axis(notificationChannels)).orderBy(asc(notificationChannels.name));
      return c.json({
        data: rows.map(row => ({ ...row,
          config: redactNotificationChannelConfig(row.type, row.config) })),
        inherited: await inherited(),
      });
    } catch (error) {
      console.error('[DeliveryRails] Read failed', error);
      return c.json({ error: 'Failed to load delivery settings' }, 500);
    }
  });
```

Mount in `routes/alerts/index.ts` before `alertsRoutes`:

```ts
import { deliveryRailsRoutes } from './deliveryRails';
alertRoutes.route('/', deliveryRailsRoutes);
```

In Task 7's real-Postgres suite, import this router and add an HTTP fixture wrapper just like Task 13's `previewAs`, using the same real org `DbAccessContext` and middleware-only injection. This concrete regression belongs to PR 1 (use the imports/mock immediately below):

```ts
runDb('inherited rails stay readable under org RLS and exclude a foreign partner', async () => {
  const f = await seedFixture();
  await seedRule({ partnerId: f.partnerId, name: 'Inherited', channelIds: [f.partnerChannel] });
  const foreign = await createPartner();
  await seedRule({ partnerId: foreign.id, name: 'Foreign', channelIds: [f.partnerChannel] });
  const ctx: DbAccessContext = { scope: 'organization', orgId: f.orgId, accessibleOrgIds: [f.orgId],
    accessiblePartnerIds: [], currentPartnerId: f.partnerId, userId: null };
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', { scope: 'organization', orgId: f.orgId,
    partnerId: f.partnerId, canAccessOrg: (id: string) => id === f.orgId }); await next(); });
  app.route('/alerts', deliveryRailsRoutes);
  const response = await withDbAccessContext(ctx, () => app.request('/alerts/delivery/rails?rail=routing'));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.data.map((row: { name: string }) => row.name)).toEqual(['Inherited']);
  expect(body.data[0]).toMatchObject({ inherited: true });
  expect(Object.keys(body.data[0]).sort()).toEqual(['channelIds','conditions','enabled','escalationPolicyId','id','inherited','isDefault','name','priority']);
});
```

Add these imports and middleware-only mock when this integration case lands in PR 1; Task 13 reuses them:

```ts
import { Hono } from 'hono';
// Reuse Task 7's existing vi import.
import { deliveryRailsRoutes } from '../../routes/alerts/deliveryRails';
vi.mock('../../middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return { ...actual,
    requireMfa: () => async (_c: any, next: any) => next(),
    requireScope: () => async (_c: any, next: any) => next(),
    requirePermission: () => async (_c: any, next: any) => next(),
  };
});
``` Retain existing `channels.authz`, `policies.authz`, and `routing.authz` suites: org writes/tests against partner-owned rows remain denied.

- [ ] **Step 4: Run, expect PASS**

```bash
(cd apps/api && npx vitest run src/services/delivery/inheritedRails.test.ts src/routes/alerts/deliveryRails.test.ts src/routes/alerts/channels.authz.test.ts src/routes/alerts/policies.authz.test.ts src/routes/alerts/routing.authz.test.ts)
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deliveryResolution.integration.test.ts)
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/delivery/inheritedRails.ts apps/api/src/services/delivery/inheritedRails.test.ts apps/api/src/routes/alerts/routing.ts apps/api/src/routes/alerts/deliveryRails.ts apps/api/src/routes/alerts/deliveryRails.test.ts apps/api/src/routes/alerts/index.ts apps/api/src/__tests__/integration/deliveryResolution.integration.test.ts
git commit -m "feat(alerts): expose inherited delivery rails as read-only metadata (W05b)"
```

---

## PR 2 — Web: `/alerts/delivery` page and redirects (Tasks 9–12)

### Task 9: Tab strip `channels` → `delivery`, page + 301 stubs, page titles

**Files:**
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:39,693` (one-for-one guard target replacement)
- Modify: `apps/web/src/components/alerts/AlertsTabStrip.tsx:6-12` (TABS), `:42-47` (activeHref)
- Modify: `apps/web/src/components/alerts/AlertsTabStrip.test.tsx:20-36`
- Rename: `apps/web/src/components/alerts/NotificationChannelsPage.tsx` → `DeliveryPage.tsx`, and `NotificationChannelsPage.test.tsx` → `delivery/deliveryActions.test.ts` (repair relative imports and routing fixtures).
- Modify: `apps/web/src/components/alerts/index.ts:45` (renamed page export)
- Create: `apps/web/src/pages/alerts/delivery.astro`
- Modify: `apps/web/src/pages/alerts/channels/index.astro` (→ 301 stub); Create: `apps/web/src/pages/alerts/routing-rules.astro` (301 stub)
- Modify (if present, see Ordering 2): `apps/web/src/pages/monitoring/delivery.astro`
- Modify: `apps/web/src/components/alerts/AlertRuleForm.tsx:675` (`href="/alerts/delivery"`)
- Modify (8 locales): `apps/web/src/locales/<locale>/alerts.json` `alertsTabStrip.tabs` (replace `channels` with `delivery`), `apps/web/src/locales/<locale>/pages.json` `titles` (replace `alertsChannels` with `alertsDelivery`)

**Interfaces:**
- Produces: route `/alerts/delivery` rendering the renamed `DeliveryPage` (Step 3 preserves existing functionality; Task 11 adds the new composition), tab key `alertsTabStrip.tabs.delivery`, page title key `titles.alertsDelivery`.
- Consumes: `routeScope.ts:122` already classifies `/alerts(\/.*)?` as `org-or-all` — no change.

- [ ] **Step 1: Write the failing test** — replace `AlertsTabStrip.test.tsx:20-36`:

```ts
  it('localizes all alert section tabs in Brazilian Portuguese', async () => {
    await loadLocale('pt-BR');
    await act(() => i18n.changeLanguage('pt-BR'));

    render(<AlertsTabStrip />);

    expect(screen.getByRole('link', { name: 'Alertas' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Correlações' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Monitores' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Regras' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Entrega' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Canais' })).not.toBeInTheDocument();
  });

  it('points the rules tab at the Legacy rules page (#5289) and the delivery tab at /alerts/delivery (W05b)', () => {
    render(<AlertsTabStrip />);
    expect(screen.getByRole('link', { name: 'Monitors' })).toHaveAttribute('href', '/alerts/monitors');
    expect(screen.getByRole('link', { name: 'Rules' })).toHaveAttribute('href', '/alerts/rules');
    expect(screen.getByRole('link', { name: 'Delivery' })).toHaveAttribute('href', '/alerts/delivery');
    expect(screen.queryByRole('link', { name: 'Channels' })).not.toBeInTheDocument();
  });

  it('marks the delivery tab active for /alerts/delivery and for the redirected legacy paths', () => {
    const { unmount } = render(<AlertsTabStrip currentPath="/alerts/delivery" />);
    expect(screen.getByRole('link', { name: 'Delivery' })).toHaveAttribute('aria-current', 'page');
    unmount();
    render(<AlertsTabStrip currentPath="/alerts/channels" />);
    expect(screen.getByRole('link', { name: 'Delivery' })).toHaveAttribute('aria-current', 'page');
  });
```

- [ ] **Step 2: Run it, expect FAIL**

```bash
cd apps/web && npx vitest run src/components/alerts/AlertsTabStrip.test.tsx
```
Expected: `Unable to find an accessible element with the role "link" and name "Delivery"`.

- [ ] **Step 3: Implement**

`AlertsTabStrip.tsx:6-12`:
```ts
const TABS = [
  { href: '/alerts', labelKey: 'alerts' },
  { href: '/alerts/correlations', labelKey: 'correlations' },
  { href: '/alerts/monitors', labelKey: 'monitors' },
  { href: '/alerts/rules', labelKey: 'rules' },
  { href: '/alerts/delivery', labelKey: 'delivery' },
] as const;
```
`:42-47`:
```ts
  const activeHref = useMemo(() => {
    if (path.startsWith('/alerts/correlations')) return '/alerts/correlations';
    // /alerts/channels and /alerts/routing-rules 301 to /alerts/delivery (W05b);
    // matching them here keeps the tab correct during the redirect paint.
    if (path.startsWith('/alerts/delivery') || path.startsWith('/alerts/channels') || path.startsWith('/alerts/routing-rules')) return '/alerts/delivery';
    if (path.startsWith('/alerts/monitors')) return '/alerts/monitors';
    if (path.startsWith('/alerts/rules')) return '/alerts/rules';
    return '/alerts';
  }, [path]);
```

`apps/web/src/pages/alerts/delivery.astro`:
```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import DeliveryPage from '../../components/alerts/DeliveryPage';
import Breadcrumbs from '../../components/layout/Breadcrumbs';
---

<DashboardLayout titleKey="titles.alertsDelivery">
  <Breadcrumbs client:load items={[
    { label: 'Alerts', href: '/alerts' },
    { label: 'Delivery' }
  ]} />
  <DeliveryPage client:load />
</DashboardLayout>
```
(Task 9 ships before Task 11 inside the same PR; to keep every commit green, in this commit create `apps/web/src/components/alerts/DeliveryPage.tsx` as the *rename* of `NotificationChannelsPage.tsx` — `git mv`, then change the default export name, the `<AlertsTabStrip currentPath="/alerts/delivery" />` prop and the `h1` to `t('alertsTabStrip.tabs.delivery')` — and `git mv NotificationChannelsPage.test.tsx delivery/deliveryActions.test.ts` with its import path updated to `'../DeliveryPage'`. Task 11 then splits the file.)

The moved test retains every assertion and mock. Apply these exact import replacements (source `NotificationChannelsPage.test.tsx:5-29`), and add `escalationPolicyId: null` to its routing fixture at original line 170:

```ts
vi.mock('../NotificationChannelList', () => ({ default: () => null }));
vi.mock('../NotificationChannelForm', () => ({ default: () => null }));
vi.mock('../AlertsTabStrip', () => ({ default: () => null }));
// Preserve existing factories; replace their module specifiers:
// ../../stores/orgStore -> ../../../stores/orgStore
// ../../stores/auth -> ../../../stores/auth (mock AND import)
// ../shared/Toast -> ../../shared/Toast (mock AND import)
// ./NotificationChannelsPage -> ../DeliveryPage
```

In the guard's `TARGET_GLOBS` replace the old entry, keeping the count at 146:

```ts
'src/components/alerts/DeliveryPage.tsx',
```

`apps/web/src/pages/alerts/channels/index.astro` (whole file):
```astro
---
// Channels moved into the Delivery facet (alerting consolidation W05b).
return Astro.redirect('/alerts/delivery', 301);
---
```
`apps/web/src/pages/alerts/routing-rules.astro` (whole file — this path never had a page; the spec names it so bookmarks to the API-shaped URL land somewhere):
```astro
---
// Routing lives on the Delivery page (alerting consolidation W05b).
return Astro.redirect('/alerts/delivery', 301);
---
```
`apps/web/src/pages/monitoring/delivery.astro` — only if it still exists: `return Astro.redirect('/alerts/delivery', 301);`.

`AlertRuleForm.tsx:675`: `href="/alerts/delivery"`.

`apps/web/src/components/alerts/index.ts:45`: `export { default as DeliveryPage } from './DeliveryPage';` (remove the `NotificationChannelsPage` line).

Locales — `alertsTabStrip.tabs`: delete the `"channels"` leaf and add `"delivery"` in every locale:

| locale | `tabs.delivery` | `titles.alertsDelivery` (pages.json, replaces `alertsChannels`) |
|---|---|---|
| en | Delivery | Alerts – Delivery |
| de-DE | Zustellung | Warnungen – Zustellung |
| es-419 | Entrega | Alertas – Entrega |
| fr-FR | Livraison | Alertes – Livraison |
| fr-CA | Livraison | Alertes – Livraison |
| it-IT | Consegna | Avvisi – Consegna |
| pt-BR | Entrega | Alertas – Entrega |
| tr-TR | Teslimat | Uyarılar – Teslimat |

Grep-check nothing else reads the removed keys: `grep -rn "alertsTabStrip.tabs.channels\|titles.alertsChannels" apps/web/src` must return nothing.

- [ ] **Step 4: Run, expect PASS**

```bash
cd apps/web && npx vitest run src/components/alerts/AlertsTabStrip.test.tsx src/components/alerts/delivery/deliveryActions.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/settingsPageRegistry.test.ts
```

- [ ] **Step 5: Commit**

```bash
if test -f apps/web/src/pages/monitoring/delivery.astro; then git add apps/web/src/pages/monitoring/delivery.astro; fi
git add apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/components/alerts/AlertsTabStrip.tsx apps/web/src/components/alerts/AlertsTabStrip.test.tsx apps/web/src/pages/alerts apps/web/src/components/alerts/AlertRuleForm.tsx apps/web/src/components/alerts/index.ts apps/web/src/components/alerts/DeliveryPage.tsx apps/web/src/components/alerts/delivery/deliveryActions.test.ts apps/web/src/locales
git commit -m "feat(web): /alerts/delivery replaces /alerts/channels; tab strip Channels → Delivery (W05b)"
```

---

### Task 10: Independent delivery read states and Retry (PR 2)

**Files:**
- Create: `apps/web/src/components/alerts/delivery/useDeliveryResource.ts`, `useDeliveryResource.test.tsx`
- Consume: `apps/web/src/stores/auth.ts` (`fetchWithAuth`), `apps/web/src/lib/navigation.ts` (`navigateTo`), `apps/web/src/lib/asList.ts`; Task 11's page and Task 12's user picker use the hook.
- Read: `apps/web/src/components/alerts/NotificationChannelsPage.tsx:172-190` (current channel error handling). The review's inferred new routing/escalation failure is confirmed: existing GET handlers above return 500 on errors; treating their result as `[]` would fabricate a valid empty configuration.

**Interfaces:**
- Produces `useDeliveryResource<T>(url): { status: 'loading'|'error'|'success'; data: T[]; inherited: InheritedChannelChoice[]; reload(): void }`. Each rail has separate state, key, and retry. Stale responses cannot replace a newer org's data.
- A section with failed/loading prerequisites is not editable. Routing needs channels, routing and escalation reads; escalation needs channels and policy reads. Only a successful empty routing response synthesizes Inbox only. Other successfully loaded sections stay visible. GET query parameters are request facts, never browser UI state.

- [ ] **Step 1: Write the failing test**

```tsx
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import { useDeliveryResource } from './useDeliveryResource';
const fetchMock = vi.mocked(fetchWithAuth);
const response = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body }) as Response;
beforeEach(() => vi.clearAllMocks());
it('errors are not successful empty lists; retry can produce a real empty list', async () => {
  fetchMock.mockResolvedValueOnce(response({ error: 'down' }, 500)).mockResolvedValueOnce(response({ data: [] }));
  const hook = renderHook(() => useDeliveryResource('/alerts/delivery/rails?rail=routing'));
  expect(hook.result.current.status).toBe('loading');
  await waitFor(() => expect(hook.result.current.status).toBe('error'));
  act(() => hook.result.current.reload());
  await waitFor(() => expect(hook.result.current.status).toBe('success'));
  expect(hook.result.current.data).toEqual([]);
});
it('ignores late results after changing org', async () => {
  let finish!: (res: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(response({ data: [{ id: 'new' }] }));
  const hook = renderHook(({ url }) => useDeliveryResource<{ id: string }>(url), { initialProps: { url: 'old' } });
  hook.rerender({ url: 'new' });
  await waitFor(() => expect(hook.result.current.data).toEqual([{ id: 'new' }]));
  await act(async () => finish(response({ data: [{ id: 'old' }] })));
  expect(hook.result.current.data).toEqual([{ id: 'new' }]);
});
it('preserves inherited channel enabled state without inventing config', async () => {
  const inherited = [{ id: 'partner', name: 'NOC', type: 'slack', enabled: false, inherited: true }];
  fetchMock.mockResolvedValueOnce(response({ data: [], inherited }));
  const hook = renderHook(() => useDeliveryResource('channels'));
  await waitFor(() => expect(hook.result.current.status).toBe('success'));
  expect(hook.result.current.inherited).toEqual(inherited);
  expect(hook.result.current.inherited[0]).not.toHaveProperty('config');
});
it('keeps unrelated rails usable', async () => {
  fetchMock.mockImplementation(async url => response({ data: [] }, url.includes('routing') ? 500 : 200));
  const hook = renderHook(() => ({ routing: useDeliveryResource('routing'), channels: useDeliveryResource('channels') }));
  await waitFor(() => expect(hook.result.current.routing.status).toBe('error'));
  expect(hook.result.current.channels.status).toBe('success');
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
(cd apps/web && npx vitest run src/components/alerts/delivery/useDeliveryResource.test.tsx)
```
Expected: missing `./useDeliveryResource`.

- [ ] **Step 3: Implement**

```ts
// useDeliveryResource.ts
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
export type ChannelChoice = { id: string; name: string; type: string; enabled: boolean; inherited?: true };
export type InheritedChannelChoice = ChannelChoice & { inherited: true };
type ReadState<T> = { key: string; status: 'loading'|'error'|'success'; data: T[]; inherited: InheritedChannelChoice[] };
export function useDeliveryResource<T>(url: string) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReadState<T>>({ key: '', status: 'loading', data: [], inherited: [] });
  const reload = useCallback(() => setAttempt(value => value + 1), []);
  useEffect(() => {
    let active = true;
    setState({ key: url, status: 'loading', data: [], inherited: [] });
    void fetchWithAuth(url).then(async response => {
      if (response.status === 401) { void navigateTo('/login', { replace: true }); throw new Error('unauthorized'); }
      if (!response.ok) throw new Error('read failed');
      const body = await response.json();
      if (!Array.isArray(body.data)) throw new Error('invalid rail response');
      if (active) setState({ key: url, status: 'success', data: body.data, inherited: body.inherited ?? [] });
    }).catch(() => { if (active) setState({ key: url, status: 'error', data: [], inherited: [] }); });
    return () => { active = false; };
  }, [url, attempt]);
  const current: ReadState<T> = state.key === url ? state : { key: url, status: 'loading', data: [], inherited: [] };
  return { ...current, reload };
}
```

In Task 11 use the replacement page below from its first commit. In Task 12 the user picker invokes its own `useDeliveryResource<{id:string;name:string}>` with `rail=users` and the selected ownerScope; errors hide choices and disable Save, not clear saved target IDs. The exact new loading/error translations are supplied in Task 11; use `deliveryPage.loading`/`deliveryPage.loadFailed`.

- [ ] **Step 4: Run, expect PASS**

```bash
(cd apps/web && npx vitest run src/components/alerts/delivery/useDeliveryResource.test.tsx)
```
Expected: loading, independent error, retry and stale-result checks pass. Run the page regression after Task 11 supplies its composition.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/alerts/delivery/useDeliveryResource.ts apps/web/src/components/alerts/delivery/useDeliveryResource.test.tsx
git commit -m "fix(web): distinguish delivery read failures from empty settings (W05b)"
```

---

### Task 11: Delivery page — Channels · Routing (with the "Everything else" row) sections

**Files:**
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts:39,693` (one-for-one guard target replacement)
- Create: `apps/web/src/components/alerts/delivery/deliveryActions.ts` (the five `run*` helpers moved verbatim from `DeliveryPage.tsx`, formerly `NotificationChannelsPage.tsx:19-114`, plus `runDefaultRowSave`); `deliveryActions.test.ts` (already moved in Task 9; imports switch to `'./deliveryActions'`; add cases)
- Create: `apps/web/src/components/alerts/delivery/ChannelsSection.tsx` (the channel list + create/edit/delete modals + `transformFormToPayload`/`transformChannelToForm`, lifted verbatim from former `NotificationChannelsPage.tsx:132-470` and `:666-745`)
- Create: `apps/web/src/components/alerts/delivery/RoutingSection.tsx`, `RoutingRuleDrawer.tsx`, `RoutingSection.test.tsx`
- Rewrite: `apps/web/src/components/alerts/DeliveryPage.tsx` (composition only)
- Create: `apps/web/src/components/alerts/DeliveryPage.test.tsx` (independent read failure and retry regression)
- Modify (8 locales): `apps/web/src/locales/<locale>/alerts.json` — new `deliveryPage` block

**Interfaces:**
- Produces:
  ```ts
  // deliveryActions.ts
  export type EditableRoutingRule = { id: string; orgId: string | null; partnerId: string | null; name: string; priority: number; conditions: { severities?: string[]; monitorKinds?: string[]; siteIds?: string[] }; channelIds: string[]; escalationPolicyId: string | null; enabled: boolean; isDefault: boolean; inherited?: false };
  export type InheritedRoutingRule = Omit<EditableRoutingRule, 'orgId' | 'partnerId' | 'inherited'> & { inherited: true };
  export type RoutingRule = EditableRoutingRule | InheritedRoutingRule;
  export const isEditableRoutingRule = (row: RoutingRule): row is EditableRoutingRule => row.inherited !== true;
  export const isPartnerRail = (row: RoutingRule | EscalationPolicy): boolean => row.inherited === true || row.orgId === null;
  export type EditableEscalationPolicy = { inherited?: false; id: string; orgId: string | null; partnerId: string | null; name: string; steps: Array<{ delayMinutes: number; channelIds: string[]; userIds?: string[]; repeat?: { everyMinutes: number; maxTimes: number } }> };
  export type InheritedEscalationPolicy = { id: string; name: string; stepCount: number; inherited: true };
  export type EscalationPolicy = EditableEscalationPolicy | InheritedEscalationPolicy;
  export const isEditableEscalationPolicy = (row: EscalationPolicy): row is EditableEscalationPolicy => row.inherited !== true;
  export async function runRoutingRuleSave(rule: Omit<EditableRoutingRule, 'id' | 'isDefault' | 'orgId' | 'partnerId' | 'inherited'> & { id?: string; ownerScope?: 'organization' | 'partner' }, deps): Promise<void>; // body now carries escalationPolicyId
  export async function runDefaultRowSave(data: { ownerScope?: 'organization' | 'partner'; channelIds: string[]; escalationPolicyId: string | null }, deps): Promise<void>; // PUT /alerts/routing-rules/default
  ```
- Consumes: `Drawer` (`components/shared/Drawer.tsx`), `ConfirmDialog`, `MONITOR_KINDS` (`@breeze/shared`) with labels `monitoring:kinds.<kind>`, sites via `GET /orgs/sites?organizationId=<id>&limit=100` (`asList(data, 'sites')`), `useDefaultOwnerScope`, `useOrgStore().currentOrgId`.
- View rules (spec §End state "Delivery" 2): non-default rows ordered by priority then org-before-partner; partner rows carry the `All orgs` badge and are editable only when `isPartnerScope`; the **Everything else** row is always rendered last, never has a delete button, shows *Inbox only* when its channels are empty; in an org view (`currentOrgId` set) the org row shadows the partner row — if only the partner row exists it renders read-only with **Customize for this organization**; in the all-orgs partner view the partner row is edited directly; when no row exists at all the page renders a synthesized *Inbox only* row whose Edit creates it.

- [ ] **Step 1: Write the failing tests**

`deliveryActions.test.ts` — append:

```ts
describe('runDefaultRowSave (W05b)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('PUTs /alerts/routing-rules/default with the axis and channels and toasts success', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { id: 'default-row' } }));
    await runDefaultRowSave({ ownerScope: 'partner', channelIds: ['ch-1'], escalationPolicyId: null }, { onUnauthorized: ON_UNAUTHORIZED });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/alerts/routing-rules/default', expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse((fetchWithAuthMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ ownerScope: 'partner', channelIds: ['ch-1'], escalationPolicyId: null });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('runRoutingRuleSave sends escalationPolicyId', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ data: { id: 'r' } }));
    await runRoutingRuleSave({ name: 'x', priority: 1, conditions: { monitorKinds: ['cpu'] }, channelIds: ['ch-1'], escalationPolicyId: 'ep-1', enabled: true }, { onUnauthorized: ON_UNAUTHORIZED });
    expect(JSON.parse((fetchWithAuthMock.mock.calls[0]![1] as RequestInit).body as string)).toMatchObject({ escalationPolicyId: 'ep-1', conditions: { monitorKinds: ['cpu'] } });
  });
});
```
(add `ActionError` to the imports from `'../../../lib/runAction'` and `runDefaultRowSave` to the imports from `'./deliveryActions'`.)

`RoutingSection.test.tsx`:

```tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import RoutingSection from './RoutingSection';
import type { RoutingRule, EditableRoutingRule, EscalationPolicy } from './deliveryActions';
import type { NotificationChannel } from '../NotificationChannelList';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const channels = [
  { id: 'ch-org', name: 'Org email', type: 'email', enabled: true, config: {} },
  { id: 'ch-partner', name: 'Partner NOC', type: 'slack', enabled: true, config: {} },
] as unknown as NotificationChannel[];
const policies: EscalationPolicy[] = [{ id: 'ep-1', name: 'On-call', stepCount: 1, inherited: true }];
const rule = (o: Partial<EditableRoutingRule>): EditableRoutingRule => ({ id: 'r', orgId: 'org-1', partnerId: null, name: 'r', priority: 10, conditions: {}, channelIds: ['ch-org'], escalationPolicyId: null, enabled: true, isDefault: false, ...o });

function renderSection(rules: RoutingRule[], opts: { currentOrgId?: string | null; isPartnerScope?: boolean } = {}) {
  const onChanged = vi.fn(async () => {});
  render(
    <RoutingSection
      rules={rules} channels={channels} policies={policies}
      currentOrgId={opts.currentOrgId === undefined ? 'org-1' : opts.currentOrgId}
      isPartnerScope={opts.isPartnerScope ?? false}
      defaultOwnerScope="organization"
      onChanged={onChanged} onUnauthorized={() => {}}
    />
  );
  return { onChanged };
}

beforeEach(() => { vi.clearAllMocks(); fetchMock.mockImplementation(async () => json({ data: [] })); });

describe('RoutingSection (W05b)', () => {
  it('renders non-default rows by priority with org before partner, then the Everything else row last, with no delete button on it', () => {
    renderSection([
      rule({ id: 'd-org', name: 'Everything else', isDefault: true, priority: 1000000, channelIds: [] }),
      rule({ id: 'p5', name: 'Partner 5', orgId: null, partnerId: 'p-1', priority: 5, channelIds: ['ch-partner'] }),
      rule({ id: 'o5', name: 'Org 5', priority: 5 }),
    ]);
    const rows = screen.getAllByTestId(/^routing-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual(['routing-row-o5', 'routing-row-p5', 'routing-row-default']);
    const def = screen.getByTestId('routing-row-default');
    expect(within(def).getByText('Inbox only')).toBeInTheDocument();
    expect(within(def).queryByTestId('routing-row-delete')).toBeNull();
    expect(within(screen.getByTestId('routing-row-p5')).getByTestId('routing-rule-partner-wide-badge')).toBeInTheDocument();
  });

  it('org view with only a partner Everything else row: read-only row + Customize creates the org row prefilled from the partner channels', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/alerts/routing-rules/default' && init?.method === 'PUT') return json({ data: { id: 'new' } });
      return json({ data: [] });
    });
    const { onChanged } = renderSection([
      { id: 'd-partner', name: 'Everything else', inherited: true, isDefault: true, enabled: true, conditions: {}, priority: 1000000, channelIds: ['ch-partner'], escalationPolicyId: 'ep-1' },
    ]);
    const def = screen.getByTestId('routing-row-default');
    expect(within(def).getByTestId('routing-rule-partner-wide-badge')).toBeInTheDocument();
    fireEvent.click(within(def).getByTestId('routing-default-customize'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    expect(within(drawer).getByLabelText('Partner NOC')).toBeChecked();
    fireEvent.click(within(drawer).getByLabelText('Org email'));
    fireEvent.click(within(drawer).getByTestId('routing-rule-drawer-save'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const put = fetchMock.mock.calls.find(([u, i]) => u === '/alerts/routing-rules/default' && (i as RequestInit)?.method === 'PUT')!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ channelIds: ['ch-partner', 'ch-org'], escalationPolicyId: 'ep-1' });
  });

  it('never offers default deletion even when both axes have a row', () => {
    renderSection([rule({ id: 'd-org', isDefault: true }),
      rule({ id: 'd-partner', orgId: null, partnerId: 'p-1', isDefault: true })]);
    expect(screen.queryByTestId('routing-default-remove')).toBeNull();
  });

  it('no row anywhere: a synthesized Inbox only row whose Edit opens the default drawer', async () => {
    renderSection([]);
    const def = screen.getByTestId('routing-row-default');
    expect(within(def).getByText('Inbox only')).toBeInTheDocument();
    fireEvent.click(within(def).getByTestId('routing-default-edit'));
    expect(await screen.findByTestId('routing-rule-drawer')).toBeInTheDocument();
  });

  it('renders an exact inherited DTO without edit or delete controls', () => {
    renderSection([{ id: 'inherited', name: 'Partner routing', priority: 5, enabled: true, isDefault: false,
      conditions: { severities: ['high'], monitorKinds: ['cpu'], siteIds: [] }, channelIds: ['ch-partner'],
      escalationPolicyId: null, inherited: true }]);
    const row = screen.getByTestId('routing-row-inherited');
    expect(within(row).getByTestId('routing-rule-partner-wide-badge')).toBeInTheDocument();
    expect(within(row).queryByTestId('routing-row-edit')).toBeNull();
    expect(within(row).queryByTestId('routing-row-delete')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('new rule drawer posts monitorKinds, severities and escalationPolicyId', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/alerts/routing-rules' && init?.method === 'POST') return json({ data: { id: 'new' } });
      return json({ data: [] });
    });
    renderSection([]);
    fireEvent.click(screen.getByTestId('routing-add-rule'));
    const drawer = await screen.findByTestId('routing-rule-drawer');
    fireEvent.change(within(drawer).getByTestId('routing-rule-name'), { target: { value: 'Disk to NOC' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-severity-high'));
    fireEvent.click(within(drawer).getByTestId('routing-rule-kind-disk'));
    fireEvent.click(within(drawer).getByLabelText('Partner NOC'));
    fireEvent.change(within(drawer).getByTestId('routing-rule-escalation'), { target: { value: 'ep-1' } });
    fireEvent.click(within(drawer).getByTestId('routing-rule-drawer-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/alerts/routing-rules', expect.objectContaining({ method: 'POST' })));
    const post = fetchMock.mock.calls.find(([u, i]) => u === '/alerts/routing-rules' && (i as RequestInit)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({
      name: 'Disk to NOC', conditions: { severities: ['high'], monitorKinds: ['disk'] }, channelIds: ['ch-partner'], escalationPolicyId: 'ep-1', enabled: true,
    });
  });
});
```

- [ ] **Step 2: Run them, expect FAIL**

```bash
cd apps/web && npx vitest run src/components/alerts/delivery
```
Expected: `Failed to resolve import "./deliveryActions"` / `"./RoutingSection"`.

- [ ] **Step 3: Implement**

In `no-silent-mutations.test.ts` replace the Task 9 target with the final mutation owner (count remains 146):

```ts
'src/components/alerts/delivery/deliveryActions.ts',
```

`deliveryActions.ts` — move the five helpers verbatim (they already import `runAction`, `ActionError`, `showToast`, `i18n`, `fetchWithAuth`; fix the relative paths to `'../../../lib/runAction'`, `'../../shared/Toast'`, `'../../../lib/i18n'`, `'../../../stores/auth'`), add the types above, change `runRoutingRuleSave`'s body to include `escalationPolicyId: rule.escalationPolicyId ?? null`, and append:

```ts
export async function runDefaultRowSave(
  data: { ownerScope?: 'organization' | 'partner'; channelIds: string[]; escalationPolicyId: string | null },
  deps: { onUnauthorized: () => void }
): Promise<void> {
  await runAction({
    request: () => fetchWithAuth('/alerts/routing-rules/default', { method: 'PUT', body: JSON.stringify(data) }),
    successMessage: i18n.t('alerts:deliveryPage.routing.defaultSaved'),
    errorFallback: i18n.t('alerts:deliveryPage.routing.failedToSaveDefault'),
    onUnauthorized: deps.onUnauthorized,
  });
}

/** Mirrors services/delivery/resolveDelivery.ts orderRoutingRows — non-default first, priority ASC, org before partner. */
export function orderRoutingRules<T extends RoutingRule>(rules: T[]): T[] {
  return [...rules].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? 1 : -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Number(isPartnerRail(a)) - Number(isPartnerRail(b));
  });
}
```

`ChannelsSection.tsx` — lift verbatim. Signature and the only new glue:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import NotificationChannelList, { type NotificationChannel } from '../NotificationChannelList';
import NotificationChannelForm, { type NotificationChannelFormValues } from '../NotificationChannelForm';
import { ActionError } from '../../../lib/runAction';
import { runChannelDelete, runChannelSave, runChannelTest } from './deliveryActions';

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

export default function ChannelsSection({ channels, currentOrgId, isPartnerScope, defaultOwnerScope, onChanged, onUnauthorized }: {
  channels: NotificationChannel[];
  currentOrgId: string | null;
  isPartnerScope: boolean;
  defaultOwnerScope: 'organization' | 'partner';
  onChanged: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedChannel, setSelectedChannel] = useState<NotificationChannel | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [channelOwnerScope, setChannelOwnerScope] = useState<'organization' | 'partner'>('organization');
  // ← handleCreate/handleEdit/handleDelete/handleTest/handleCloseModal,
  //   transformFormToPayload, transformChannelToForm, handleSubmit,
  //   handleConfirmDelete: moved verbatim from the former
  //   NotificationChannelsPage.tsx:199-225,227-397,399-439 — every
  //   `await fetchChannels()` becomes `await onChanged()`.
  return (
    <section className="space-y-4" data-testid="delivery-channels">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('deliveryPage.sections.channels')}</h2>
        <button type="button" onClick={handleCreate} data-testid="delivery-new-channel"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" />{t('notificationChannelsPage.newChannel')}
        </button>
      </div>
      {error && modalMode === 'closed' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}
      <NotificationChannelList channels={channels} onEdit={handleEdit} onDelete={handleDelete} onTest={handleTest} onCreate={handleCreate} />
      {/* ← the create/edit modal and the delete confirmation modal: moved verbatim from the former NotificationChannelsPage.tsx:666-745 */}
    </section>
  );
}
```

`RoutingRuleDrawer.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MONITOR_KINDS } from '@breeze/shared';
import { Drawer } from '../../shared/Drawer';
import { fetchWithAuth } from '../../../stores/auth';
import { asList } from '@/lib/asList';
import type { ChannelChoice } from './useDeliveryResource';
import { isPartnerRail, type EscalationPolicy, type EditableRoutingRule } from './deliveryActions';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

export type RoutingDrawerValues = {
  name: string; priority: number; severities: string[]; monitorKinds: string[]; siteIds: string[];
  channelIds: string[]; escalationPolicyId: string | null; enabled: boolean; ownerScope: 'organization' | 'partner';
};

export default function RoutingRuleDrawer({ open, mode, rule, initialChannelIds, initialEscalationPolicyId, ownerScope, showOwnerScope, orgId, channels, policies, saving, onSave, onCancel }: {
  open: boolean;
  /** 'default' edits only channels + escalation of the Everything else row. */
  mode: 'rule' | 'default';
  rule: EditableRoutingRule | null;
  initialChannelIds?: string[];
  initialEscalationPolicyId?: string | null;
  ownerScope: 'organization' | 'partner';
  showOwnerScope: boolean;
  orgId: string | null;
  channels: ChannelChoice[];
  policies: EscalationPolicy[];
  saving: boolean;
  onSave: (values: RoutingDrawerValues) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [values, setValues] = useState<RoutingDrawerValues>(() => ({
    name: rule?.name ?? '', priority: rule?.priority ?? 10,
    severities: rule?.conditions.severities ?? [], monitorKinds: rule?.conditions.monitorKinds ?? [], siteIds: rule?.conditions.siteIds ?? [],
    channelIds: rule?.channelIds ?? initialChannelIds ?? [], escalationPolicyId: rule?.escalationPolicyId ?? initialEscalationPolicyId ?? null,
    enabled: rule?.enabled ?? true, ownerScope,
  }));
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (!open || mode !== 'rule' || values.ownerScope !== 'organization' || !orgId) { setSites([]); return; }
    let cancelled = false;
    fetchWithAuth(`/orgs/sites?organizationId=${orgId}&limit=100`)
      .then(async (r) => (r.ok ? asList(await r.json(), 'sites') : []))
      .then((list) => { if (!cancelled) setSites(list as Array<{ id: string; name: string }>); })
      .catch(() => { if (!cancelled) setSites([]); });
    return () => { cancelled = true; };
  }, [open, mode, values.ownerScope, orgId]);

  const toggle = (key: 'severities' | 'monitorKinds' | 'siteIds' | 'channelIds', id: string) =>
    setValues((v) => ({ ...v, [key]: v[key].includes(id) ? v[key].filter((x) => x !== id) : [...v[key], id] }));
  const compatiblePolicies = policies.filter((p) => values.ownerScope === 'partner' ? isPartnerRail(p) : true);
  const canSave = mode === 'default' || (values.name.trim().length > 0 && values.channelIds.length > 0);
  const title = mode === 'default' ? t('deliveryPage.routing.editDefault') : rule ? t('deliveryPage.routing.editRule') : t('deliveryPage.routing.newRule');

  return (
    <Drawer open={open} onClose={onCancel} title={title} width="max-w-lg" dataTestId="routing-rule-drawer" closeDisabled={saving}>
      <div className="space-y-5 p-1">
        {mode === 'rule' && !rule && showOwnerScope && (
          <fieldset className="space-y-2 rounded-md border p-3" data-testid="routing-rule-owner">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('notificationChannelsPage.scope')}</legend>
            {(['partner', 'organization'] as const).map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input type="radio" checked={values.ownerScope === scope} onChange={() => setValues((v) => ({ ...v, ownerScope: scope, siteIds: [] }))} data-testid={`routing-rule-owner-${scope === 'partner' ? 'partner' : 'org'}`} />
                {scope === 'partner' ? t('notificationChannelsPage.allOrganizations') : t('notificationChannelsPage.thisOrganizationOnly')}
              </label>
            ))}
          </fieldset>
        )}
        {mode === 'rule' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-muted-foreground">{t('notificationChannelsPage.name')}
                <input value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} data-testid="routing-rule-name"
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" />
              </label>
              <label className="block text-xs font-medium text-muted-foreground">{t('deliveryPage.routing.priority')}
                <input type="number" min={1} max={100} value={values.priority} onChange={(e) => setValues((v) => ({ ...v, priority: Number(e.target.value) || 10 }))} data-testid="routing-rule-priority"
                  className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" />
              </label>
            </div>
            <ChipGroup label={t('deliveryPage.routing.severities')} hint={t('deliveryPage.routing.leaveEmptyForAll')}>
              {SEVERITIES.map((sev) => (
                <Chip key={sev} active={values.severities.includes(sev)} onClick={() => toggle('severities', sev)} testId={`routing-rule-severity-${sev}`}>
                  {t(/* i18n-dynamic */ `notificationChannelsPage.severity.${sev}`)}
                </Chip>
              ))}
            </ChipGroup>
            <ChipGroup label={t('deliveryPage.routing.monitorKinds')} hint={t('deliveryPage.routing.leaveEmptyForAll')}>
              {MONITOR_KINDS.map((kind) => (
                <Chip key={kind} active={values.monitorKinds.includes(kind)} onClick={() => toggle('monitorKinds', kind)} testId={`routing-rule-kind-${kind}`}>
                  {t(/* i18n-dynamic */ `monitoring:kinds.${kind}`)}
                </Chip>
              ))}
            </ChipGroup>
            {values.ownerScope === 'organization' && sites.length > 0 && (
              <ChipGroup label={t('deliveryPage.routing.sites')} hint={t('deliveryPage.routing.leaveEmptyForAll')}>
                {sites.map((s) => (
                  <Chip key={s.id} active={values.siteIds.includes(s.id)} onClick={() => toggle('siteIds', s.id)} testId={`routing-rule-site-${s.id}`}>{s.name}</Chip>
                ))}
              </ChipGroup>
            )}
          </>
        )}
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('deliveryPage.routing.sendTo')}</p>
          {mode === 'default' && <p className="mb-2 text-xs text-muted-foreground">{t('deliveryPage.routing.everythingElseHint')}</p>}
          <div className="mt-2 space-y-1">
            {channels.map((ch) => (
              <label key={ch.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
                <input type="checkbox" checked={values.channelIds.includes(ch.id)} onChange={() => toggle('channelIds', ch.id)} className="h-4 w-4 rounded border-muted" />
                <span className="text-sm">{ch.name}</span><span className="text-xs text-muted-foreground">({ch.type})</span>
              </label>
            ))}
            {channels.length === 0 && <p className="text-xs text-muted-foreground">{t('notificationChannelsPage.noChannelsConfiguredYet')}</p>}
          </div>
        </div>
        <label className="block text-xs font-medium text-muted-foreground">{t('deliveryPage.routing.escalateVia')}
          <select value={values.escalationPolicyId ?? ''} onChange={(e) => setValues((v) => ({ ...v, escalationPolicyId: e.target.value || null }))} data-testid="routing-rule-escalation"
            className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm">
            <option value="">{t('deliveryPage.routing.noEscalation')}</option>
            {compatiblePolicies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {mode === 'rule' && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={values.enabled} onChange={(e) => setValues((v) => ({ ...v, enabled: e.target.checked }))} className="h-4 w-4 rounded border-muted" />
            {t('notificationChannelsPage.enabled')}
          </label>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} disabled={saving} className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground">{t('common:actions.cancel')}</button>
          <button type="button" onClick={() => onSave(values)} disabled={!canSave || saving} data-testid="routing-rule-drawer-save"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">{t('common:actions.save')}</button>
        </div>
      </div>
    </Drawer>
  );
}

function ChipGroup({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="mb-2 text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
function Chip({ active, onClick, testId, children }: { active: boolean; onClick: () => void; testId: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} data-testid={testId} aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${active ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted'}`}>{children}</button>
  );
}
```

`RoutingSection.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { ActionError } from '../../../lib/runAction';
import type { ChannelChoice } from './useDeliveryResource';
import RoutingRuleDrawer, { type RoutingDrawerValues } from './RoutingRuleDrawer';
import {
  orderRoutingRules, runDefaultRowSave, runRoutingRuleDelete, runRoutingRuleSave,
  isEditableRoutingRule, isPartnerRail, type EscalationPolicy, type RoutingRule, type EditableRoutingRule,
} from './deliveryActions';

type DrawerState =
  | { kind: 'closed' }
  | { kind: 'rule'; rule: EditableRoutingRule | null }
  | { kind: 'default'; ownerScope: 'organization' | 'partner'; row: EditableRoutingRule | null; prefillFrom: RoutingRule | null };

export default function RoutingSection({ rules, channels, policies, currentOrgId, isPartnerScope, defaultOwnerScope, onChanged, onUnauthorized }: {
  rules: RoutingRule[];
  channels: ChannelChoice[];
  policies: EscalationPolicy[];
  currentOrgId: string | null;
  isPartnerScope: boolean;
  defaultOwnerScope: 'organization' | 'partner';
  onChanged: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [drawer, setDrawer] = useState<DrawerState>({ kind: 'closed' });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<EditableRoutingRule | null>(null);
  const [error, setError] = useState<string>();

  const ordered = useMemo(() => orderRoutingRules(rules.filter((r) => !r.isDefault)), [rules]);
  const orgDefault = rules.find((r): r is EditableRoutingRule => isEditableRoutingRule(r) && r.isDefault && r.orgId !== null) ?? null;
  const partnerDefault = rules.find((r) => r.isDefault && isPartnerRail(r)) ?? null;
  // Org view: the org row shadows the partner row. All-orgs view: the partner row.
  const orgView = currentOrgId !== null;
  const effectiveDefault = orgView ? (orgDefault ?? partnerDefault) : partnerDefault;
  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? id.slice(0, 8);
  const policyName = (id: string | null) => (id ? policies.find((p) => p.id === id)?.name ?? id.slice(0, 8) : null);

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setSaving(true); setError(undefined);
    try { await fn(); await onChanged(); setDrawer({ kind: 'closed' }); setDeleting(null); }
    catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) setError(err instanceof Error ? err.message : fallback);
    } finally { setSaving(false); }
  };

  const saveFromDrawer = (values: RoutingDrawerValues) => {
    if (drawer.kind === 'default') {
      return run(() => runDefaultRowSave({
        ...(drawer.ownerScope === 'partner' ? { ownerScope: 'partner' as const } : {}),
        channelIds: values.channelIds, escalationPolicyId: values.escalationPolicyId,
      }, { onUnauthorized }), t('deliveryPage.routing.failedToSaveDefault'));
    }
    if (drawer.kind === 'rule') {
      const existing = drawer.rule;
      return run(() => runRoutingRuleSave({
        ...(existing ? { id: existing.id } : {}),
        name: values.name.trim(), priority: values.priority,
        conditions: {
          ...(values.severities.length ? { severities: values.severities } : {}),
          ...(values.monitorKinds.length ? { monitorKinds: values.monitorKinds } : {}),
          ...(values.siteIds.length ? { siteIds: values.siteIds } : {}),
        },
        channelIds: values.channelIds, escalationPolicyId: values.escalationPolicyId, enabled: values.enabled,
        ...(!existing && isPartnerScope ? { ownerScope: values.ownerScope } : {}),
      }, { onUnauthorized }), t('notificationChannelsPage.failedToSaveRoutingRule'));
    }
    return Promise.resolve();
  };

  const openDefaultEditor = () => {
    if (orgView) {
      setDrawer({ kind: 'default', ownerScope: 'organization', row: orgDefault, prefillFrom: orgDefault ? null : partnerDefault });
    } else {
      setDrawer({ kind: 'default', ownerScope: 'partner', row: partnerDefault && isEditableRoutingRule(partnerDefault) ? partnerDefault : null, prefillFrom: null });
    }
  };
  const canEditRow = (rule: RoutingRule): rule is EditableRoutingRule => isEditableRoutingRule(rule)
    && (rule.orgId !== null || (isPartnerScope && currentOrgId === null));
  const defaultIsPartnerRowInOrgView = orgView && !orgDefault && !!partnerDefault;

  return (
    <section className="space-y-3" data-testid="delivery-routing">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t('deliveryPage.sections.routing')}</h2>
          <p className="text-sm text-muted-foreground">{t('deliveryPage.precedence')}</p>
        </div>
        <button type="button" onClick={() => setDrawer({ kind: 'rule', rule: null })} data-testid="routing-add-rule"
          className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted">
          <Plus className="h-3.5 w-3.5" /> {t('deliveryPage.routing.addRule')}
        </button>
      </div>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      <ol className="space-y-2">
        {ordered.map((rule) => (
          <li key={rule.id} data-testid={`routing-row-${rule.id}`} className="flex items-center gap-3 rounded-md border bg-muted/20 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{rule.name}</span>
                {isPartnerRail(rule) && (
                  <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary" data-testid="routing-rule-partner-wide-badge" title={t('deliveryPage.routing.partnerRowHint')}>
                    {t('notificationChannelsPage.allOrgs')}
                  </span>
                )}
                {!rule.enabled && <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{t('notificationChannelsPage.disabled')}</span>}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{t('notificationChannelsPage.priority')} {rule.priority}</span>
                <span>{describeMatch(rule, t)}</span>
                <span>{t('deliveryPage.routing.sendTo')}: {rule.channelIds.map(channelName).join(', ')}</span>
                {rule.escalationPolicyId && <span>{t('deliveryPage.routing.escalateVia')}: {policyName(rule.escalationPolicyId)}</span>}
              </div>
            </div>
            {canEditRow(rule) && (
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => setDrawer({ kind: 'rule', rule })} className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted" data-testid="routing-row-edit">{t('common:actions.edit')}</button>
                <button type="button" onClick={() => setDeleting(rule)} className="rounded-md p-1 text-destructive hover:bg-muted" data-testid="routing-row-delete" aria-label={t('common:actions.delete')}><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            )}
          </li>
        ))}
        <li data-testid="routing-row-default" className="flex items-center gap-3 rounded-md border border-dashed bg-card px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{t('deliveryPage.routing.everythingElse')}</span>
              {effectiveDefault && isPartnerRail(effectiveDefault) && (
                <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary" data-testid="routing-rule-partner-wide-badge">{t('notificationChannelsPage.allOrgs')}</span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{t('deliveryPage.routing.matchAll')}</span>
              <span>
                {t('deliveryPage.routing.sendTo')}: {effectiveDefault && effectiveDefault.channelIds.length > 0
                  ? effectiveDefault.channelIds.map(channelName).join(', ')
                  : t('deliveryPage.routing.inboxOnly')}
              </span>
              {effectiveDefault?.escalationPolicyId && <span>{t('deliveryPage.routing.escalateVia')}: {policyName(effectiveDefault.escalationPolicyId)}</span>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('deliveryPage.routing.everythingElseHint')}</p>
          </div>
          <div className="flex items-center gap-1">
            {defaultIsPartnerRowInOrgView ? (
              <button type="button" onClick={openDefaultEditor} data-testid="routing-default-customize" className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted">{t('deliveryPage.routing.customizeForOrg')}</button>
            ) : (orgView || isPartnerScope) && (
              <button type="button" onClick={openDefaultEditor} data-testid="routing-default-edit" className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted">{t('common:actions.edit')}</button>
            )}

          </div>
        </li>
      </ol>

      {drawer.kind !== 'closed' && (
        <RoutingRuleDrawer
          key={drawer.kind === 'rule' ? (drawer.rule?.id ?? 'new') : `default-${drawer.ownerScope}`}
          open mode={drawer.kind}
          rule={drawer.kind === 'rule' ? drawer.rule : drawer.row}
          initialChannelIds={drawer.kind === 'default' ? drawer.prefillFrom?.channelIds ?? [] : undefined}
          initialEscalationPolicyId={drawer.kind === 'default' ? drawer.prefillFrom?.escalationPolicyId ?? null : undefined}
          ownerScope={drawer.kind === 'default' ? drawer.ownerScope : defaultOwnerScope}
          showOwnerScope={isPartnerScope}
          orgId={currentOrgId}
          channels={channels} policies={policies} saving={saving}
          onSave={saveFromDrawer} onCancel={() => setDrawer({ kind: 'closed' })}
        />
      )}
      <ConfirmDialog
        open={deleting !== null} onClose={() => setDeleting(null)} isLoading={saving} variant="destructive"
        title={t('common:actions.delete')}
        message={t('deliveryPage.routing.deleteConfirm', { name: deleting?.name ?? '' })}
        onConfirm={() => {
          if (!deleting) return;
          void run(
            () => runRoutingRuleDelete(deleting.id, { onUnauthorized }),
            t('notificationChannelsPage.failedToDeleteRoutingRule')
          );
        }}
      />
    </section>
  );
}

function describeMatch(rule: RoutingRule, t: (k: string, o?: Record<string, unknown>) => string): string {
  const parts: string[] = [];
  if (rule.conditions.severities?.length) parts.push(`${t('deliveryPage.routing.severities')}: ${rule.conditions.severities.join(', ')}`);
  if (rule.conditions.monitorKinds?.length) parts.push(`${t('deliveryPage.routing.monitorKinds')}: ${rule.conditions.monitorKinds.map((k) => t(/* i18n-dynamic */ `monitoring:kinds.${k}`)).join(', ')}`);
  if (rule.conditions.siteIds?.length) parts.push(`${t('deliveryPage.routing.sites')}: ${rule.conditions.siteIds.length}`);
  return parts.length ? parts.join(' · ') : t('deliveryPage.routing.matchAll');
}
```

`DeliveryPage.tsx` (rewritten; all three rails have independent state):

```tsx
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import AlertsTabStrip from './AlertsTabStrip';
import type { NotificationChannel } from './NotificationChannelList';
import ChannelsSection from './delivery/ChannelsSection';
import RoutingSection from './delivery/RoutingSection';
import EscalationPoliciesSection from './delivery/EscalationPoliciesSection';
import type { EscalationPolicy, RoutingRule } from './delivery/deliveryActions';
import { useDeliveryResource } from './delivery/useDeliveryResource';
import { useOrgStore } from '../../stores/orgStore';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { navigateTo } from '@/lib/navigation';
import '../../lib/i18n';
export default function DeliveryPage() {
  const { t } = useTranslation('alerts');
  const { currentOrgId } = useOrgStore();
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const suffix = currentOrgId ? `&orgId=${encodeURIComponent(currentOrgId)}` : '';
  const channels = useDeliveryResource<NotificationChannel>(`/alerts/delivery/rails?rail=channels${suffix}`);
  const routing = useDeliveryResource<RoutingRule>(`/alerts/delivery/rails?rail=routing${suffix}`);
  const policies = useDeliveryResource<EscalationPolicy>(`/alerts/delivery/rails?rail=escalation${suffix}`);
  const onUnauthorized = useCallback(() => { void navigateTo('/login', { replace: true }); }, []);
  const onChanged = async () => { channels.reload(); routing.reload(); policies.reload(); };
  const choices = [...channels.data.map(({ id, name, type, enabled }) => ({ id, name, type, enabled })), ...channels.inherited];
  const props = { currentOrgId, isPartnerScope, defaultOwnerScope, onChanged, onUnauthorized };
  const state = (resource: { status: string; reload: () => void }, key: string) => resource.status === 'error'
    ? <div role="alert" data-testid={`delivery-${key}-error`}>{t('deliveryPage.loadFailed')}
        <button type="button" onClick={resource.reload}>{t('common:actions.retry')}</button></div>
    : resource.status === 'loading' ? <p role="status">{t('deliveryPage.loading')}</p> : null;
  return <div className="space-y-8">
    <AlertsTabStrip currentPath="/alerts/delivery" />
    <h1>{t('deliveryPage.title')}</h1><p>{t('deliveryPage.subtitle')}</p>
    {state(channels, 'channels')}
    {channels.status === 'success' && <>
      <ChannelsSection {...props} channels={channels.data} />
      <ul data-testid="delivery-inherited-channels">{channels.inherited.map(channel => <li key={channel.id}>
        {channel.name} ({channel.type}) · {t('notificationChannelsPage.allOrgs')} · {t('deliveryPage.routing.partnerRowHint')}
      </li>)}</ul>
    </>}
    {state(routing, 'routing')}{state(policies, 'escalation')}
    {channels.status === 'success' && routing.status === 'success' && policies.status === 'success' &&
      <RoutingSection {...props} channels={choices} rules={routing.data} policies={policies.data} />}
    {channels.status === 'success' && policies.status === 'success' &&
      <EscalationPoliciesSection {...props} channels={choices} policies={policies.data} />}
  </div>;
}
```

Use `ChannelChoice[]` from `useDeliveryResource.ts` for the channel props of `RoutingSection`, `RoutingRuleDrawer`, `EscalationPoliciesSection`, and `EscalationPolicyDrawer`; `ChannelsSection` alone consumes full `NotificationChannel[]`. Never fabricate config fields for inherited channels or pass them to edit/test/delete controls. Use the `inherited` discriminant to narrow every row before reading owner IDs or steps. `canEditRow`/`canEdit` are type guards that first exclude inherited DTOs; only editable rows enter mutation drawers. Manage inherited partner rows from the partner view.

`DeliveryPage.test.tsx` (real page and independent fetches, minimal child stubs):

```tsx
import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({ useDefaultOwnerScope: () => ({ isPartnerScope: false, defaultOwnerScope: 'organization' }) }));
vi.mock('./AlertsTabStrip', () => ({ default: () => null }));
vi.mock('./delivery/ChannelsSection', () => ({ default: () => <div data-testid="channels-ready" /> }));
vi.mock('./delivery/RoutingSection', () => ({ default: () => <button data-testid="routing-default-edit">Edit</button> }));
vi.mock('./delivery/EscalationPoliciesSection', () => ({ default: () => <button data-testid="escalation-new">New</button> }));
import { fetchWithAuth } from '../../stores/auth';
import DeliveryPage from './DeliveryPage';
const fetchMock = vi.mocked(fetchWithAuth);
beforeEach(() => vi.clearAllMocks());
it.each(['routing','escalation'])('a failed %s read never offers an inbox-only default; Retry restores it', async rail => {
  let failed = true;
  fetchMock.mockImplementation(async url => ({ ok: !(failed && url.includes(`rail=${rail}`)), status: failed && url.includes(`rail=${rail}`) ? 500 : 200,
    json: async () => ({ data: [] }) }) as Response);
  render(<DeliveryPage />);
  await screen.findByTestId(`delivery-${rail}-error`);
  expect(screen.getByTestId('channels-ready')).toBeInTheDocument();
  expect(screen.queryByTestId('routing-default-edit')).toBeNull();
  if (rail === 'escalation') expect(screen.queryByTestId('escalation-new')).toBeNull();
  failed = false; fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('routing-default-edit')).toBeInTheDocument();
});
```

`EscalationPoliciesSection` is replaced in Task 12; this intermediate typed stub keeps Task 11 independently compilable:

```tsx
import { useTranslation } from 'react-i18next';
export default function EscalationPoliciesSection(_props: Record<string, unknown>) {
  const { t } = useTranslation('alerts');
  return <section><h2>{t('deliveryPage.sections.escalation')}</h2></section>;
}
```

Locales — add a `deliveryPage` block to every `alerts.json` (place it right after `alertsTabStrip`):

`en`:
```json
  "deliveryPage": {
    "loading": "Loading delivery settings…",
    "loadFailed": "Could not load delivery settings.",
    "title": "Delivery",
    "subtitle": "Who gets told, and how.",
    "precedence": "A monitor's own Notify setting wins; otherwise the first matching row from the top.",
    "sections": { "channels": "Channels", "routing": "Routing", "escalation": "Escalation policies" },
    "routing": {
      "everythingElse": "Everything else",
      "everythingElseHint": "Catches every alert no row above matches. Empty its channels for inbox only.",
      "inboxOnly": "Inbox only",
      "partnerRowHint": "Owned by your partner; read-only here.",
      "customizeForOrg": "Customize for this organization",
      "matchAll": "All alerts",
      "severities": "Severities",
      "monitorKinds": "Monitor kinds",
      "sites": "Sites",
      "sendTo": "Send to",
      "escalateVia": "Escalate via",
      "noEscalation": "No escalation",
      "addRule": "Add routing rule",
      "editRule": "Edit routing rule",
      "newRule": "New routing rule",
      "editDefault": "Edit Everything else",
      "priority": "Priority (lower runs first)",
      "leaveEmptyForAll": "Leave empty to match all",
      "defaultSaved": "Everything else row saved",
      "failedToSaveDefault": "Failed to save the Everything else row",
      "deleteConfirm": "Delete routing rule \"{{name}}\"?"
    },
    "escalation": {
      "new": "New escalation policy",
      "edit": "Edit escalation policy",
      "empty": "No escalation policies yet. A policy sends follow-up notifications while an alert stays unacknowledged.",
      "steps": "Steps",
      "addStep": "Add step",
      "removeStep": "Remove step",
      "delayMinutes": "After (minutes)",
      "notifyChannels": "Notify",
      "notifyUsers": "Notify users (in-app)",
      "repeat": "Repeat",
      "everyMinutes": "Every (minutes)",
      "maxTimes": "Additional sends",
      "stepCount_one": "{{count}} step",
      "stepCount_other": "{{count}} steps",
      "created": "Escalation policy created",
      "saved": "Escalation policy saved",
      "deleted": "Escalation policy deleted",
      "failedToSave": "Failed to save escalation policy",
      "failedToDelete": "Failed to delete escalation policy",
      "deleteConfirm": "Delete escalation policy \"{{name}}\"? Monitors and routing rows that reference it will stop escalating."
    }
  },
```

`de-DE`:
```json
  "deliveryPage": {
    "loading": "Zustellungseinstellungen werden geladen…",
    "loadFailed": "Zustellungseinstellungen konnten nicht geladen werden.",
    "title": "Zustellung",
    "subtitle": "Wer benachrichtigt wird – und wie.",
    "precedence": "Die eigene Benachrichtigungseinstellung eines Monitors gewinnt; andernfalls die erste passende Zeile von oben.",
    "sections": { "channels": "Kanäle", "routing": "Weiterleitung", "escalation": "Eskalationsrichtlinien" },
    "routing": {
      "everythingElse": "Alles andere",
      "everythingElseHint": "Fängt jede Warnung ab, auf die keine Zeile darüber passt. Kanäle leeren für „nur Posteingang“.",
      "inboxOnly": "Nur Posteingang",
      "partnerRowHint": "Gehört Ihrem Partner; hier schreibgeschützt.",
      "customizeForOrg": "Für diese Organisation anpassen",
      "matchAll": "Alle Warnungen",
      "severities": "Schweregrade",
      "monitorKinds": "Monitorarten",
      "sites": "Standorte",
      "sendTo": "Senden an",
      "escalateVia": "Eskalieren über",
      "noEscalation": "Keine Eskalation",
      "addRule": "Weiterleitungsregel hinzufügen",
      "editRule": "Weiterleitungsregel bearbeiten",
      "newRule": "Neue Weiterleitungsregel",
      "editDefault": "„Alles andere“ bearbeiten",
      "priority": "Priorität (niedriger läuft zuerst)",
      "leaveEmptyForAll": "Leer lassen, um alle zu treffen",
      "defaultSaved": "Zeile „Alles andere“ gespeichert",
      "failedToSaveDefault": "Zeile „Alles andere“ konnte nicht gespeichert werden",
      "deleteConfirm": "Weiterleitungsregel „{{name}}“ löschen?"
    },
    "escalation": {
      "new": "Neue Eskalationsrichtlinie",
      "edit": "Eskalationsrichtlinie bearbeiten",
      "empty": "Noch keine Eskalationsrichtlinien. Eine Richtlinie sendet Folgebenachrichtigungen, solange eine Warnung unbestätigt bleibt.",
      "steps": "Schritte",
      "addStep": "Schritt hinzufügen",
      "removeStep": "Schritt entfernen",
      "delayMinutes": "Nach (Minuten)",
      "notifyChannels": "Benachrichtigen",
      "notifyUsers": "Benutzer benachrichtigen (in der App)",
      "repeat": "Wiederholen",
      "everyMinutes": "Alle (Minuten)",
      "maxTimes": "Zusätzliche Sendungen",
      "stepCount_one": "{{count}} Schritt",
      "stepCount_other": "{{count}} Schritte",
      "created": "Eskalationsrichtlinie erstellt",
      "saved": "Eskalationsrichtlinie gespeichert",
      "deleted": "Eskalationsrichtlinie gelöscht",
      "failedToSave": "Eskalationsrichtlinie konnte nicht gespeichert werden",
      "failedToDelete": "Eskalationsrichtlinie konnte nicht gelöscht werden",
      "deleteConfirm": "Eskalationsrichtlinie „{{name}}“ löschen? Monitore und Weiterleitungszeilen, die darauf verweisen, eskalieren nicht mehr."
    }
  },
```

`es-419`:
```json
  "deliveryPage": {
    "loading": "Cargando ajustes de entrega…",
    "loadFailed": "No se pudieron cargar los ajustes de entrega.",
    "title": "Entrega",
    "subtitle": "A quién se avisa y cómo.",
    "precedence": "La configuración de notificación propia de un monitor gana; de lo contrario, la primera fila coincidente desde arriba.",
    "sections": { "channels": "Canales", "routing": "Enrutamiento", "escalation": "Políticas de escalamiento" },
    "routing": {
      "everythingElse": "Todo lo demás",
      "everythingElseHint": "Captura toda alerta con la que ninguna fila superior coincida. Vacía sus canales para «solo bandeja de entrada».",
      "inboxOnly": "Solo bandeja de entrada",
      "partnerRowHint": "Pertenece a tu partner; solo lectura aquí.",
      "customizeForOrg": "Personalizar para esta organización",
      "matchAll": "Todas las alertas",
      "severities": "Severidades",
      "monitorKinds": "Tipos de monitor",
      "sites": "Sitios",
      "sendTo": "Enviar a",
      "escalateVia": "Escalar mediante",
      "noEscalation": "Sin escalamiento",
      "addRule": "Agregar regla de enrutamiento",
      "editRule": "Editar regla de enrutamiento",
      "newRule": "Nueva regla de enrutamiento",
      "editDefault": "Editar «Todo lo demás»",
      "priority": "Prioridad (la menor se ejecuta primero)",
      "leaveEmptyForAll": "Déjalo vacío para coincidir con todo",
      "defaultSaved": "Fila «Todo lo demás» guardada",
      "failedToSaveDefault": "No se pudo guardar la fila «Todo lo demás»",
      "deleteConfirm": "¿Eliminar la regla de enrutamiento «{{name}}»?"
    },
    "escalation": {
      "new": "Nueva política de escalamiento",
      "edit": "Editar política de escalamiento",
      "empty": "Aún no hay políticas de escalamiento. Una política envía notificaciones de seguimiento mientras una alerta siga sin confirmarse.",
      "steps": "Pasos",
      "addStep": "Agregar paso",
      "removeStep": "Quitar paso",
      "delayMinutes": "Después de (minutos)",
      "notifyChannels": "Notificar",
      "notifyUsers": "Notificar usuarios (en la aplicación)",
      "repeat": "Repetir",
      "everyMinutes": "Cada (minutos)",
      "maxTimes": "Envíos adicionales",
      "stepCount_one": "{{count}} paso",
      "stepCount_other": "{{count}} pasos",
      "created": "Política de escalamiento creada",
      "saved": "Política de escalamiento guardada",
      "deleted": "Política de escalamiento eliminada",
      "failedToSave": "No se pudo guardar la política de escalamiento",
      "failedToDelete": "No se pudo eliminar la política de escalamiento",
      "deleteConfirm": "¿Eliminar la política de escalamiento «{{name}}»? Los monitores y filas de enrutamiento que la referencian dejarán de escalar."
    }
  },
```

`fr-FR` and `fr-CA` (identical text):
```json
  "deliveryPage": {
    "loading": "Chargement des réglages de livraison…",
    "loadFailed": "Impossible de charger les réglages de livraison.",
    "title": "Livraison",
    "subtitle": "Qui est prévenu, et comment.",
    "precedence": "Le réglage de notification propre au moniteur l'emporte ; sinon, la première ligne correspondante en partant du haut.",
    "sections": { "channels": "Canaux", "routing": "Routage", "escalation": "Politiques d'escalade" },
    "routing": {
      "everythingElse": "Tout le reste",
      "everythingElseHint": "Capte toute alerte qu'aucune ligne au-dessus ne couvre. Videz ses canaux pour « boîte de réception seulement ».",
      "inboxOnly": "Boîte de réception seulement",
      "partnerRowHint": "Appartient à votre partenaire ; en lecture seule ici.",
      "customizeForOrg": "Personnaliser pour cette organisation",
      "matchAll": "Toutes les alertes",
      "severities": "Gravités",
      "monitorKinds": "Types de moniteur",
      "sites": "Sites",
      "sendTo": "Envoyer à",
      "escalateVia": "Escalader via",
      "noEscalation": "Pas d'escalade",
      "addRule": "Ajouter une règle de routage",
      "editRule": "Modifier la règle de routage",
      "newRule": "Nouvelle règle de routage",
      "editDefault": "Modifier « Tout le reste »",
      "priority": "Priorité (la plus basse s'exécute en premier)",
      "leaveEmptyForAll": "Laisser vide pour tout faire correspondre",
      "defaultSaved": "Ligne « Tout le reste » enregistrée",
      "failedToSaveDefault": "Échec de l'enregistrement de la ligne « Tout le reste »",
      "deleteConfirm": "Supprimer la règle de routage « {{name}} » ?"
    },
    "escalation": {
      "new": "Nouvelle politique d'escalade",
      "edit": "Modifier la politique d'escalade",
      "empty": "Aucune politique d'escalade pour l'instant. Une politique envoie des notifications de relance tant qu'une alerte reste non acquittée.",
      "steps": "Étapes",
      "addStep": "Ajouter une étape",
      "removeStep": "Retirer l'étape",
      "delayMinutes": "Après (minutes)",
      "notifyChannels": "Notifier",
      "notifyUsers": "Notifier les utilisateurs (dans l’application)",
      "repeat": "Répéter",
      "everyMinutes": "Toutes les (minutes)",
      "maxTimes": "Envois supplémentaires",
      "stepCount_one": "{{count}} étape",
      "stepCount_other": "{{count}} étapes",
      "created": "Politique d'escalade créée",
      "saved": "Politique d'escalade enregistrée",
      "deleted": "Politique d'escalade supprimée",
      "failedToSave": "Échec de l'enregistrement de la politique d'escalade",
      "failedToDelete": "Échec de la suppression de la politique d'escalade",
      "deleteConfirm": "Supprimer la politique d'escalade « {{name}} » ? Les moniteurs et lignes de routage qui la référencent cesseront d'escalader."
    }
  },
```
(`"sites": "Sites"` is an exact cognate; if `translationCoverage.test.ts` trips the fr-FR/fr-CA `alerts.json` cap, raise it by one with the comment `// Cognate: Sites (W05b delivery page)` — the only permitted bump in this wave.)

`it-IT`:
```json
  "deliveryPage": {
    "loading": "Caricamento delle impostazioni di consegna…",
    "loadFailed": "Impossibile caricare le impostazioni di consegna.",
    "title": "Consegna",
    "subtitle": "Chi viene avvisato e come.",
    "precedence": "L'impostazione di notifica del monitor ha la precedenza; altrimenti vale la prima riga corrispondente dall'alto.",
    "sections": { "channels": "Canali", "routing": "Instradamento", "escalation": "Criteri di escalation" },
    "routing": {
      "everythingElse": "Tutto il resto",
      "everythingElseHint": "Cattura ogni avviso che nessuna riga sopra intercetta. Svuota i canali per «solo posta in arrivo».",
      "inboxOnly": "Solo posta in arrivo",
      "partnerRowHint": "Appartiene al tuo partner; qui è in sola lettura.",
      "customizeForOrg": "Personalizza per questa organizzazione",
      "matchAll": "Tutti gli avvisi",
      "severities": "Gravità",
      "monitorKinds": "Tipi di monitor",
      "sites": "Sedi",
      "sendTo": "Invia a",
      "escalateVia": "Escalation tramite",
      "noEscalation": "Nessuna escalation",
      "addRule": "Aggiungi regola di instradamento",
      "editRule": "Modifica regola di instradamento",
      "newRule": "Nuova regola di instradamento",
      "editDefault": "Modifica «Tutto il resto»",
      "priority": "Priorità (la più bassa viene eseguita per prima)",
      "leaveEmptyForAll": "Lascia vuoto per corrispondere a tutto",
      "defaultSaved": "Riga «Tutto il resto» salvata",
      "failedToSaveDefault": "Impossibile salvare la riga «Tutto il resto»",
      "deleteConfirm": "Eliminare la regola di instradamento «{{name}}»?"
    },
    "escalation": {
      "new": "Nuovo criterio di escalation",
      "edit": "Modifica criterio di escalation",
      "empty": "Nessun criterio di escalation. Un criterio invia notifiche di follow-up finché un avviso resta non riconosciuto.",
      "steps": "Passaggi",
      "addStep": "Aggiungi passaggio",
      "removeStep": "Rimuovi passaggio",
      "delayMinutes": "Dopo (minuti)",
      "notifyChannels": "Notifica",
      "notifyUsers": "Notifica utenti (nell’app)",
      "repeat": "Ripeti",
      "everyMinutes": "Ogni (minuti)",
      "maxTimes": "Invii aggiuntivi",
      "stepCount_one": "{{count}} passaggio",
      "stepCount_other": "{{count}} passaggi",
      "created": "Criterio di escalation creato",
      "saved": "Criterio di escalation salvato",
      "deleted": "Criterio di escalation eliminato",
      "failedToSave": "Impossibile salvare il criterio di escalation",
      "failedToDelete": "Impossibile eliminare il criterio di escalation",
      "deleteConfirm": "Eliminare il criterio di escalation «{{name}}»? I monitor e le righe di instradamento che vi fanno riferimento smetteranno di eseguire l'escalation."
    }
  },
```

`pt-BR`:
```json
  "deliveryPage": {
    "loading": "Carregando configurações de entrega…",
    "loadFailed": "Não foi possível carregar as configurações de entrega.",
    "title": "Entrega",
    "subtitle": "Quem é avisado e como.",
    "precedence": "A configuração de notificação do próprio monitor vence; caso contrário, a primeira linha correspondente de cima para baixo.",
    "sections": { "channels": "Canais", "routing": "Roteamento", "escalation": "Políticas de escalonamento" },
    "routing": {
      "everythingElse": "Todo o resto",
      "everythingElseHint": "Captura todo alerta que nenhuma linha acima cobre. Esvazie os canais para “somente caixa de entrada”.",
      "inboxOnly": "Somente caixa de entrada",
      "partnerRowHint": "Pertence ao seu parceiro; somente leitura aqui.",
      "customizeForOrg": "Personalizar para esta organização",
      "matchAll": "Todos os alertas",
      "severities": "Severidades",
      "monitorKinds": "Tipos de monitor",
      "sites": "Locais",
      "sendTo": "Enviar para",
      "escalateVia": "Escalonar via",
      "noEscalation": "Sem escalonamento",
      "addRule": "Adicionar regra de roteamento",
      "editRule": "Editar regra de roteamento",
      "newRule": "Nova regra de roteamento",
      "editDefault": "Editar “Todo o resto”",
      "priority": "Prioridade (menor executa primeiro)",
      "leaveEmptyForAll": "Deixe vazio para corresponder a todos",
      "defaultSaved": "Linha “Todo o resto” salva",
      "failedToSaveDefault": "Falha ao salvar a linha “Todo o resto”",
      "deleteConfirm": "Excluir a regra de roteamento “{{name}}”?"
    },
    "escalation": {
      "new": "Nova política de escalonamento",
      "edit": "Editar política de escalonamento",
      "empty": "Ainda não há políticas de escalonamento. Uma política envia notificações de acompanhamento enquanto um alerta continua sem confirmação.",
      "steps": "Etapas",
      "addStep": "Adicionar etapa",
      "removeStep": "Remover etapa",
      "delayMinutes": "Após (minutos)",
      "notifyChannels": "Notificar",
      "notifyUsers": "Notificar usuários (no aplicativo)",
      "repeat": "Repetir",
      "everyMinutes": "A cada (minutos)",
      "maxTimes": "Envios adicionais",
      "stepCount_one": "{{count}} etapa",
      "stepCount_other": "{{count}} etapas",
      "created": "Política de escalonamento criada",
      "saved": "Política de escalonamento salva",
      "deleted": "Política de escalonamento excluída",
      "failedToSave": "Falha ao salvar a política de escalonamento",
      "failedToDelete": "Falha ao excluir a política de escalonamento",
      "deleteConfirm": "Excluir a política de escalonamento “{{name}}”? Monitores e linhas de roteamento que a referenciam deixarão de escalonar."
    }
  },
```

`tr-TR`:
```json
  "deliveryPage": {
    "loading": "Teslimat ayarları yükleniyor…",
    "loadFailed": "Teslimat ayarları yüklenemedi.",
    "title": "Teslimat",
    "subtitle": "Kime, nasıl haber verilir.",
    "precedence": "Bir monitörün kendi bildirim ayarı önceliklidir; aksi halde yukarıdan itibaren eşleşen ilk satır uygulanır.",
    "sections": { "channels": "Kanallar", "routing": "Yönlendirme", "escalation": "Yükseltme ilkeleri" },
    "routing": {
      "everythingElse": "Diğer her şey",
      "everythingElseHint": "Yukarıdaki hiçbir satırla eşleşmeyen her uyarıyı yakalar. Yalnızca gelen kutusu için kanalları boşaltın.",
      "inboxOnly": "Yalnızca gelen kutusu",
      "partnerRowHint": "İş ortağınıza aittir; burada salt okunur.",
      "customizeForOrg": "Bu kuruluş için özelleştir",
      "matchAll": "Tüm uyarılar",
      "severities": "Önem dereceleri",
      "monitorKinds": "Monitör türleri",
      "sites": "Siteler",
      "sendTo": "Gönderilecek",
      "escalateVia": "Yükseltme yolu",
      "noEscalation": "Yükseltme yok",
      "addRule": "Yönlendirme kuralı ekle",
      "editRule": "Yönlendirme kuralını düzenle",
      "newRule": "Yeni yönlendirme kuralı",
      "editDefault": "\"Diğer her şey\" satırını düzenle",
      "priority": "Öncelik (düşük olan önce çalışır)",
      "leaveEmptyForAll": "Tümüyle eşleşmesi için boş bırakın",
      "defaultSaved": "\"Diğer her şey\" satırı kaydedildi",
      "failedToSaveDefault": "\"Diğer her şey\" satırı kaydedilemedi",
      "deleteConfirm": "\"{{name}}\" yönlendirme kuralı silinsin mi?"
    },
    "escalation": {
      "new": "Yeni yükseltme ilkesi",
      "edit": "Yükseltme ilkesini düzenle",
      "empty": "Henüz yükseltme ilkesi yok. Bir ilke, uyarı onaylanmadığı sürece takip bildirimleri gönderir.",
      "steps": "Adımlar",
      "addStep": "Adım ekle",
      "removeStep": "Adımı kaldır",
      "delayMinutes": "Sonra (dakika)",
      "notifyChannels": "Bildir",
      "notifyUsers": "Kullanıcılara bildir (uygulama içi)",
      "repeat": "Yinele",
      "everyMinutes": "Aralık (dakika)",
      "maxTimes": "Ek gönderimler",
      "stepCount_one": "{{count}} adım",
      "stepCount_other": "{{count}} adım",
      "created": "Yükseltme ilkesi oluşturuldu",
      "saved": "Yükseltme ilkesi kaydedildi",
      "deleted": "Yükseltme ilkesi silindi",
      "failedToSave": "Yükseltme ilkesi kaydedilemedi",
      "failedToDelete": "Yükseltme ilkesi silinemedi",
      "deleteConfirm": "\"{{name}}\" yükseltme ilkesi silinsin mi? Buna başvuran monitörler ve yönlendirme satırları yükseltmeyi durduracak."
    }
  },
```

- [ ] **Step 4: Run, expect PASS**

```bash
cd apps/web && npx vitest run src/components/alerts/delivery src/components/alerts/AlertsTabStrip.test.tsx src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/no-translated-comparisons.test.ts && npx tsc --noEmit -p .
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/alerts/DeliveryPage.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/components/alerts/DeliveryPage.tsx apps/web/src/components/alerts/delivery apps/web/src/locales
git commit -m "feat(web): Delivery page — channels + routing with the Everything else row (W05b)"
```

---

### Task 12: Escalation policy CRUD on the Delivery page

**Files:**
- Create: `apps/web/src/components/alerts/delivery/EscalationPoliciesSection.tsx` (replaces the Task 11 stub), `EscalationPolicyDrawer.tsx`, `EscalationPoliciesSection.test.tsx`
- Modify: `apps/web/src/components/alerts/delivery/deliveryActions.ts` (+ `runEscalationPolicySave`, `runEscalationPolicyDelete`), `deliveryActions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function runEscalationPolicySave(policy: { id?: string; name: string; steps: Array<{ delayMinutes: number; channelIds: string[]; userIds?: string[]; repeat?: { everyMinutes: number; maxTimes: number } }>; ownerScope?: 'organization' | 'partner'; orgId?: string | null }, deps): Promise<void>; // POST /alerts/policies | PUT /alerts/policies/:id
  export async function runEscalationPolicyDelete(policy: { id: string; name: string }, deps): Promise<void>; // DELETE /alerts/policies/:id
  ```
- Consumes: `POST /alerts/policies` (`policies.ts:113-186`, body `{ orgId?, ownerScope?, name, steps }`), `PUT /alerts/policies/:id` (`:189-241`), `DELETE /alerts/policies/:id` (`:244-273`). Note the policy routes return the bare row (`c.json(policy, 201)`), not `{ data }`.

- [ ] **Step 1: Write the failing tests**

`deliveryActions.test.ts` — append:

```ts
describe('runEscalationPolicySave / runEscalationPolicyDelete (W05b)', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('POSTs a new policy with ownerScope + orgId and toasts success', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'ep-new' }));
    await runEscalationPolicySave({ name: 'On-call', steps: [{ delayMinutes: 15, channelIds: ['ch-1'] }], ownerScope: 'organization', orgId: 'org-1' }, { onUnauthorized: ON_UNAUTHORIZED });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/alerts/policies', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse((fetchWithAuthMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ name: 'On-call', steps: [{ delayMinutes: 15, channelIds: ['ch-1'] }], ownerScope: 'organization', orgId: 'org-1' });
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });
  it('PUTs an existing policy without ownerScope/orgId', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'ep-1' }));
    await runEscalationPolicySave({ id: 'ep-1', name: 'On-call', steps: [{ delayMinutes: 5, channelIds: ['ch-1'] }], ownerScope: 'partner' }, { onUnauthorized: ON_UNAUTHORIZED });
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/alerts/policies/ep-1', expect.objectContaining({ method: 'PUT' }));
    expect(JSON.parse((fetchWithAuthMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ name: 'On-call', steps: [{ delayMinutes: 5, channelIds: ['ch-1'] }] });
  });
  it('DELETE failure toasts an error', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'nope' }, false, 500));
    await expect(runEscalationPolicyDelete({ id: 'ep-1', name: 'On-call' }, { onUnauthorized: ON_UNAUTHORIZED })).rejects.toBeInstanceOf(ActionError);
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
```

`EscalationPoliciesSection.test.tsx`:

```tsx
import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import EscalationPoliciesSection from './EscalationPoliciesSection';
import type { EscalationPolicy, EditableEscalationPolicy } from './deliveryActions';
import type { NotificationChannel } from '../NotificationChannelList';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;
const channels = [{ id: 'ch-1', name: 'NOC Slack', type: 'slack', enabled: true, config: {} }] as unknown as NotificationChannel[];

function renderSection(policies: EscalationPolicy[], isPartnerScope = true) {
  const onChanged = vi.fn(async () => {});
  render(<EscalationPoliciesSection policies={policies} channels={channels} currentOrgId="org-1" isPartnerScope={isPartnerScope} defaultOwnerScope="organization" onChanged={onChanged} onUnauthorized={() => {}} />);
  return { onChanged };
}

beforeEach(() => { vi.clearAllMocks(); fetchMock.mockImplementation(async url => url.startsWith('/alerts/delivery/rails') ? json({ data: [{ id: 'user-1', name: 'Alex' }] }) : json({ id: 'ep' })); });

describe('EscalationPoliciesSection (W05b)', () => {
  it('lists policies with owner badge and step count; empty state otherwise', () => {
    renderSection([{ id: 'ep-1', name: 'On-call', stepCount: 2, inherited: true }]);
    const row = screen.getByTestId('escalation-row-ep-1');
    expect(within(row).getByText('On-call')).toBeInTheDocument();
    expect(within(row).getByText('2 steps')).toBeInTheDocument();
    expect(within(row).getByTestId('escalation-partner-wide-badge')).toBeInTheDocument();
    expect(within(row).queryByTestId('escalation-row-edit')).toBeNull();
    expect(within(row).queryByTestId('escalation-row-delete')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('renders the empty state', () => {
    renderSection([]);
    expect(screen.getByTestId('escalation-empty')).toBeInTheDocument();
  });
  it('creates a policy from the drawer: name, one step with delay + channel, POST body typed', async () => {
    const { onChanged } = renderSection([]);
    fireEvent.click(screen.getByTestId('escalation-new'));
    const drawer = await screen.findByTestId('escalation-policy-drawer');
    fireEvent.change(within(drawer).getByTestId('escalation-name'), { target: { value: 'Page on-call' } });
    fireEvent.change(within(drawer).getByTestId('escalation-step-0-delay'), { target: { value: '15' } });
    fireEvent.click(within(drawer).getByLabelText('NOC Slack'));
    await waitFor(() => expect(within(drawer).getByTestId('escalation-policy-drawer-save')).toBeEnabled());
    fireEvent.click(within(drawer).getByTestId('escalation-policy-drawer-save'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const post = fetchMock.mock.calls.find(([u, i]) => u === '/alerts/policies' && (i as RequestInit)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ name: 'Page on-call', steps: [{ delayMinutes: 15, channelIds: ['ch-1'] }] });
  });
  it('saves user-only targets and repeats, preserving both when editing', async () => {
    renderSection([{ id: 'ep-user', orgId: 'org-1', partnerId: null, name: 'Alex on-call',
      steps: [{ delayMinutes: 5, channelIds: [], userIds: ['user-1'], repeat: { everyMinutes: 10, maxTimes: 2 } }] }]);
    fireEvent.click(within(screen.getByTestId('escalation-row-ep-user')).getByTestId('escalation-row-edit'));
    expect(await screen.findByLabelText('Alex')).toBeChecked();
    expect(screen.getByTestId('escalation-step-0-every')).toHaveValue(10);
    fireEvent.click(screen.getByTestId('escalation-policy-drawer-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/alerts/policies/ep-user', expect.objectContaining({ method: 'PUT' })));
    const call = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')!;
    expect(JSON.parse(call[1]!.body as string).steps[0]).toEqual({ delayMinutes: 5, channelIds: [], userIds: ['user-1'], repeat: { everyMinutes: 10, maxTimes: 2 } });
  });
  it('save is disabled while a step has no target', async () => {
    renderSection([]);
    fireEvent.click(screen.getByTestId('escalation-new'));
    const drawer = await screen.findByTestId('escalation-policy-drawer');
    fireEvent.change(within(drawer).getByTestId('escalation-name'), { target: { value: 'x' } });
    expect(within(drawer).getByTestId('escalation-policy-drawer-save')).toBeDisabled();
  });
  it('delete asks for confirmation then DELETEs', async () => {
    const { onChanged } = renderSection([{ id: 'ep-1', orgId: 'org-1', partnerId: null, name: 'On-call', steps: [{ delayMinutes: 5, channelIds: ['ch-1'] }] }]);
    fireEvent.click(within(screen.getByTestId('escalation-row-ep-1')).getByTestId('escalation-row-delete'));
    fireEvent.click(await screen.findByTestId('escalation-delete-confirm'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/alerts/policies/ep-1', expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd apps/web && npx vitest run src/components/alerts/delivery/EscalationPoliciesSection.test.tsx src/components/alerts/delivery/deliveryActions.test.ts
```
Expected: `runEscalationPolicySave is not a function`; `Unable to find an element by: [data-testid="escalation-new"]` (stub section).

- [ ] **Step 3: Implement**

`deliveryActions.ts` — append:

```ts
export async function runEscalationPolicySave(
  policy: { id?: string; name: string; steps: Array<{ delayMinutes: number; channelIds: string[]; userIds?: string[]; repeat?: { everyMinutes: number; maxTimes: number } }>; ownerScope?: 'organization' | 'partner'; orgId?: string | null },
  deps: { onUnauthorized: () => void }
): Promise<void> {
  const isEdit = !!policy.id;
  const body = isEdit
    ? { name: policy.name, steps: policy.steps }
    : { name: policy.name, steps: policy.steps, ...(policy.ownerScope ? { ownerScope: policy.ownerScope } : {}), ...(policy.ownerScope !== 'partner' && policy.orgId ? { orgId: policy.orgId } : {}) };
  await runAction({
    request: () => fetchWithAuth(isEdit ? `/alerts/policies/${policy.id}` : '/alerts/policies', { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(body) }),
    successMessage: isEdit ? i18n.t('alerts:deliveryPage.escalation.saved') : i18n.t('alerts:deliveryPage.escalation.created'),
    errorFallback: i18n.t('alerts:deliveryPage.escalation.failedToSave'),
    onUnauthorized: deps.onUnauthorized,
  });
}

export async function runEscalationPolicyDelete(policy: { id: string; name: string }, deps: { onUnauthorized: () => void }): Promise<void> {
  await runAction({
    request: () => fetchWithAuth(`/alerts/policies/${policy.id}`, { method: 'DELETE' }),
    successMessage: i18n.t('alerts:deliveryPage.escalation.deleted'),
    errorFallback: i18n.t('alerts:deliveryPage.escalation.failedToDelete'),
    onUnauthorized: deps.onUnauthorized,
  });
}
```

`EscalationPolicyDrawer.tsx`:

```tsx
import { useState } from 'react';
import { useDeliveryResource } from './useDeliveryResource';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { Drawer } from '../../shared/Drawer';
import type { ChannelChoice } from './useDeliveryResource';
import type { EscalationPolicy, EditableEscalationPolicy } from './deliveryActions';

type Step = { delayMinutes: number; channelIds: string[]; userIds: string[]; repeat?: { everyMinutes: number; maxTimes: number } };
export type EscalationDrawerValues = { name: string; steps: Step[]; ownerScope: 'organization' | 'partner' };

export default function EscalationPolicyDrawer({ open, policy, channels, orgId, ownerScope, showOwnerScope, saving, onSave, onCancel }: {
  open: boolean; policy: EditableEscalationPolicy | null; channels: ChannelChoice[]; orgId: string | null;
  ownerScope: 'organization' | 'partner'; showOwnerScope: boolean; saving: boolean;
  onSave: (values: EscalationDrawerValues) => void; onCancel: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [values, setValues] = useState<EscalationDrawerValues>(() => ({
    name: policy?.name ?? '',
    steps: policy?.steps?.length ? policy.steps.map((s) => ({ ...s, channelIds: [...s.channelIds], userIds: [...(s.userIds ?? [])] })) : [{ delayMinutes: 15, channelIds: [], userIds: [] }],
    ownerScope,
  }));
  const targetQuery = new URLSearchParams({ rail: 'users', ownerScope: values.ownerScope });
  if (orgId && values.ownerScope !== 'partner') targetQuery.set('orgId', orgId);
  const users = useDeliveryResource<{ id: string; name: string }>(`/alerts/delivery/rails?${targetQuery}`);
  const setStep = (i: number, patch: Partial<Step>) => setValues((v) => ({ ...v, steps: v.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const toggleChannel = (i: number, id: string) => setStep(i, { channelIds: values.steps[i]!.channelIds.includes(id) ? values.steps[i]!.channelIds.filter((c) => c !== id) : [...values.steps[i]!.channelIds, id] });
  const canSave = users.status === 'success' && values.name.trim().length > 0 && values.steps.length > 0 && values.steps.length <= 10
    && values.steps.every((s) => Number.isInteger(s.delayMinutes) && s.delayMinutes >= 1 && s.delayMinutes <= 10080 && s.channelIds.length + s.userIds.length > 0
      && (!s.repeat || (Number.isInteger(s.repeat.everyMinutes) && s.repeat.everyMinutes >= 1 && s.repeat.everyMinutes <= 10080
        && Number.isInteger(s.repeat.maxTimes) && s.repeat.maxTimes >= 1 && s.repeat.maxTimes <= 100)));

  return (
    <Drawer open={open} onClose={onCancel} title={policy ? t('deliveryPage.escalation.edit') : t('deliveryPage.escalation.new')} width="max-w-lg" dataTestId="escalation-policy-drawer" closeDisabled={saving}>
      <div className="space-y-5 p-1">
        {!policy && showOwnerScope && (
          <fieldset className="space-y-2 rounded-md border p-3" data-testid="escalation-owner">
            <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('notificationChannelsPage.scope')}</legend>
            {(['partner', 'organization'] as const).map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input type="radio" checked={values.ownerScope === scope} onChange={() => setValues((v) => ({ ...v, ownerScope: scope, steps: v.steps.map(step => ({ ...step, userIds: [] })) }))} data-testid={`escalation-owner-${scope === 'partner' ? 'partner' : 'org'}`} />
                {scope === 'partner' ? t('notificationChannelsPage.allOrganizations') : t('notificationChannelsPage.thisOrganizationOnly')}
              </label>
            ))}
          </fieldset>
        )}
        <label className="block text-xs font-medium text-muted-foreground">{t('notificationChannelsPage.name')}
          <input value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} data-testid="escalation-name" className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" />
        </label>
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">{t('deliveryPage.escalation.steps')}</p>
          {values.steps.map((step, i) => (
            <div key={i} className="space-y-2 rounded-md border p-3" data-testid={`escalation-step-${i}`}>
              <div className="flex items-end gap-3">
                <label className="block flex-1 text-xs font-medium text-muted-foreground">{t('deliveryPage.escalation.delayMinutes')}
                  <input type="number" min={1} max={10080} value={step.delayMinutes} onChange={(e) => setStep(i, { delayMinutes: Number(e.target.value) })} data-testid={`escalation-step-${i}-delay`} className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm" />
                </label>
                {values.steps.length > 1 && (
                  <button type="button" onClick={() => setValues((v) => ({ ...v, steps: v.steps.filter((_, j) => j !== i) }))} aria-label={t('deliveryPage.escalation.removeStep')} data-testid={`escalation-step-${i}-remove`} className="h-9 rounded-md p-2 text-destructive hover:bg-muted"><Trash2 className="h-4 w-4" /></button>
                )}
              </div>
              <p className="text-xs font-medium text-muted-foreground">{t('deliveryPage.escalation.notifyChannels')}</p>
              {channels.map((ch) => (
                <label key={ch.id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-muted">
                  <input type="checkbox" checked={step.channelIds.includes(ch.id)} onChange={() => toggleChannel(i, ch.id)} className="h-4 w-4 rounded border-muted" />
                  <span className="text-sm">{ch.name}</span><span className="text-xs text-muted-foreground">({ch.type})</span>
                </label>
              ))}
              <p>{t('deliveryPage.escalation.notifyUsers')}</p>
              {users.status === 'error' && <div role="alert">{t('deliveryPage.loadFailed')} <button type="button" onClick={users.reload}>{t('common:actions.retry')}</button></div>}
              {users.status === 'loading' && <p role="status">{t('deliveryPage.loading')}</p>}
              {users.data.map(user => <label key={user.id} className="flex gap-2">
                <input type="checkbox" checked={step.userIds.includes(user.id)}
                  onChange={() => setStep(i, { userIds: step.userIds.includes(user.id)
                    ? step.userIds.filter(id => id !== user.id) : [...step.userIds, user.id] })} />{user.name}
              </label>)}
              <label className="flex gap-2"><input type="checkbox" checked={!!step.repeat}
                data-testid={`escalation-step-${i}-repeat`}
                onChange={e => setStep(i, { repeat: e.target.checked ? { everyMinutes: 15, maxTimes: 1 } : undefined })} />
                {t('deliveryPage.escalation.repeat')}
              </label>
              {step.repeat && <div className="grid grid-cols-2 gap-3">
                <label>{t('deliveryPage.escalation.everyMinutes')}<input type="number" min={1} max={10080}
                  data-testid={`escalation-step-${i}-every`} value={step.repeat.everyMinutes}
                  onChange={e => setStep(i, { repeat: { ...step.repeat!, everyMinutes: Number(e.target.value) } })} /></label>
                <label>{t('deliveryPage.escalation.maxTimes')}<input type="number" min={1} max={100}
                  data-testid={`escalation-step-${i}-times`} value={step.repeat.maxTimes}
                  onChange={e => setStep(i, { repeat: { ...step.repeat!, maxTimes: Number(e.target.value) } })} /></label>
              </div>}

            </div>
          ))}
          {values.steps.length < 10 && (
            <button type="button" onClick={() => setValues((v) => ({ ...v, steps: [...v.steps, { delayMinutes: (v.steps.at(-1)?.delayMinutes ?? 0) + 15, channelIds: [], userIds: [] }] }))} data-testid="escalation-add-step" className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted">
              <Plus className="h-3.5 w-3.5" /> {t('deliveryPage.escalation.addStep')}
            </button>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onCancel} disabled={saving} className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground">{t('common:actions.cancel')}</button>
          <button type="button" onClick={() => onSave(values)} disabled={!canSave || saving} data-testid="escalation-policy-drawer-save" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">{t('common:actions.save')}</button>
        </div>
      </div>
    </Drawer>
  );
}
```

`EscalationPoliciesSection.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import { ActionError } from '../../../lib/runAction';
import type { ChannelChoice } from './useDeliveryResource';
import EscalationPolicyDrawer, { type EscalationDrawerValues } from './EscalationPolicyDrawer';
import { runEscalationPolicyDelete, runEscalationPolicySave, isEditableEscalationPolicy, isPartnerRail, type EditableEscalationPolicy, type EscalationPolicy } from './deliveryActions';

export default function EscalationPoliciesSection({ policies, channels, currentOrgId, isPartnerScope, defaultOwnerScope, onChanged, onUnauthorized }: {
  policies: EscalationPolicy[]; channels: ChannelChoice[]; currentOrgId: string | null;
  isPartnerScope: boolean; defaultOwnerScope: 'organization' | 'partner';
  onChanged: () => Promise<void>; onUnauthorized: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [drawer, setDrawer] = useState<{ open: boolean; policy: EditableEscalationPolicy | null }>({ open: false, policy: null });
  const [deleting, setDeleting] = useState<EditableEscalationPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setSaving(true); setError(undefined);
    try { await fn(); await onChanged(); setDrawer({ open: false, policy: null }); setDeleting(null); }
    catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) setError(err instanceof Error ? err.message : fallback);
    } finally { setSaving(false); }
  };
  const save = (values: EscalationDrawerValues) => run(() => runEscalationPolicySave({
    ...(drawer.policy ? { id: drawer.policy.id } : {}),
    name: values.name.trim(), steps: values.steps,
    ...(!drawer.policy ? { ownerScope: isPartnerScope ? values.ownerScope : 'organization', orgId: currentOrgId } : {}),
  }, { onUnauthorized }), t('deliveryPage.escalation.failedToSave'));
  const canEdit = (p: EscalationPolicy): p is EditableEscalationPolicy => isEditableEscalationPolicy(p)
    && (p.orgId !== null || (isPartnerScope && currentOrgId === null));

  return (
    <section className="space-y-3" data-testid="delivery-escalation">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('deliveryPage.sections.escalation')}</h2>
        <button type="button" onClick={() => setDrawer({ open: true, policy: null })} data-testid="escalation-new" className="inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-muted">
          <Plus className="h-3.5 w-3.5" /> {t('deliveryPage.escalation.new')}
        </button>
      </div>
      {error && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
      {policies.length === 0 ? (
        <div className="rounded-md border border-dashed py-8 text-center" data-testid="escalation-empty">
          <p className="text-sm text-muted-foreground">{t('deliveryPage.escalation.empty')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {policies.map((p) => (
            <li key={p.id} data-testid={`escalation-row-${p.id}`} className="flex items-center gap-3 rounded-md border bg-muted/20 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                  {isPartnerRail(p) && <span className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary" data-testid="escalation-partner-wide-badge">{t('notificationChannelsPage.allOrgs')}</span>}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('deliveryPage.escalation.stepCount', { count: p.inherited === true ? p.stepCount : p.steps.length })}
                  {p.inherited !== true && p.steps.length ? ` · ${p.steps.map((s) => `${s.delayMinutes}m`).join(' → ')}` : ''}
                </p>
              </div>
              {canEdit(p) && (
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setDrawer({ open: true, policy: p })} data-testid="escalation-row-edit" className="rounded-md px-2 py-1 text-xs font-medium hover:bg-muted">{t('common:actions.edit')}</button>
                  <button type="button" onClick={() => setDeleting(p)} data-testid="escalation-row-delete" aria-label={t('common:actions.delete')} className="rounded-md p-1 text-destructive hover:bg-muted"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {drawer.open && (
        <EscalationPolicyDrawer key={drawer.policy?.id ?? 'new'} open policy={drawer.policy} channels={channels} orgId={drawer.policy?.orgId ?? currentOrgId} ownerScope={drawer.policy ? (drawer.policy.orgId === null ? 'partner' : 'organization') : defaultOwnerScope} showOwnerScope={isPartnerScope} saving={saving} onSave={save} onCancel={() => setDrawer({ open: false, policy: null })} />
      )}
      <ConfirmDialog
        open={deleting !== null} onClose={() => setDeleting(null)} isLoading={saving} variant="destructive"
        title={t('common:actions.delete')} message={t('deliveryPage.escalation.deleteConfirm', { name: deleting?.name ?? '' })}
        confirmTestId="escalation-delete-confirm"
        onConfirm={() => { if (deleting) void run(() => runEscalationPolicyDelete(deleting, { onUnauthorized }), t('deliveryPage.escalation.failedToDelete')); }}
      />
    </section>
  );
}
```
(`confirmTestId` is the verified `ConfirmDialog` prop at `apps/web/src/components/shared/ConfirmDialog.tsx:23`.)

- [ ] **Step 4: Run, expect PASS**

```bash
cd apps/web && npx vitest run src/components/alerts src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts && npx tsc --noEmit -p .
```

- [ ] **Step 5: Commit + open PR 2**

```bash
git add apps/web/src/components/alerts/delivery apps/web/src/components/alerts/DeliveryPage.tsx
git commit -m "feat(web): escalation policy CRUD on the Delivery page (W05b)"
```
PR 2 body must include the Settings-rule-9 statement (Global Constraints) and both machine-draft locale lines.

---

## PR 3 — Preview, Notify inheritance, AI and documentation (Tasks 13–16)

### Task 13: Delivery preview endpoint + readable provenance + the full Postgres agreement gate

**Files:**
- Create: `apps/api/src/routes/alerts/delivery.ts`, `delivery.test.ts`
- Create: `apps/api/src/services/delivery/describeDelivery.ts`, `describeDelivery.test.ts`
- Modify: `apps/api/src/routes/alerts/index.ts:8-21` (mount before the catch-all)
- Extend: `apps/api/src/__tests__/integration/deliveryResolution.integration.test.ts` (created in Task 7; retain its fixtures and all Task 7/8 cases)
- Read/consume: `apps/api/src/middleware/auth.ts:75-151,212-219,480-518`, `apps/api/src/routes/alerts/helpers.ts:52-113`, `apps/api/src/services/notificationDispatcher.ts:71-84,380-450,1306-1397`, `apps/api/src/db/schema/monitorDefinitions.ts:57-106`, `apps/api/src/__tests__/integration/notificationRailsPartnerRls.integration.test.ts:106-143`. These ranges were opened on the planning checkout; new files have no pre-existing line ranges.

**Interfaces:**
- Consumes: Task 2's `ResolveDeliveryInput`, `ResolvedDelivery`, `resolveDelivery(input, executor?)`, `DbExecutor`, `partnerIdForOrg`, `railOwnershipCondition`; `monitorKindSchema`, `monitorSeveritySchema`; request `AuthContext`, including `canAccessOrg`, `allowedSiteIds`.
- Produces: `deliveryRoutes`; `deliveryPreviewQuerySchema`; `previewDelivery(input, auth): Promise<DeliveryPreview>` exported from `services/delivery/describeDelivery.ts` for the route and AI tool. This validates the requested org/site/monitor before calling the resolver. No system-context elevation.
- Produces: `describeDelivery(input, resolved, executor?): Promise<DeliveryPreview>`; `DeliveryPreview = ResolvedDelivery & { display: string; description: { channels: Array<{ id: string; name: string; enabled: boolean }>; escalationPolicy: { id: string; name: string } | null; owner: 'organization' | 'partner' | null } }`. `description` is additive: clients localize surrounding text without parsing the English `display` or changing the fixed cross-wave resolver contract.
- HTTP: `GET /alerts/delivery/resolve?orgId=<uuid>&severity=<severity>[&kind=<kind>&siteId=<uuid>&monitorId=<uuid>]` → **bare** `DeliveryPreview`, not `{ data }`. `orgId` and `severity` required; invalid query 400; missing authentication 401; missing `alerts:read`/foreign org/disallowed site 403; missing or wrong-owner org/site/monitor 404; unexpected resolver failure 500. A supplied kind describes a draft condition and takes precedence over the saved monitor kind, matching Task 2. No legacy override is accepted from a browser.
- A partner monitor requires a concrete organization to preview its inherited routing. An omitted site means site-scoped rows fail closed; it does not mean “all sites”. The endpoint never queues a test notification.

- [ ] **Step 1: Write the failing route and description tests**

`apps/api/src/routes/alerts/delivery.test.ts`:

```ts
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ authenticated: true, read: true, preview: vi.fn() }));
vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => {
    if (!state.authenticated) return c.json({ error: 'Not authenticated' }, 401);
    c.set('auth', { scope: 'organization' });
    await next();
  },
  requirePermission: () => async (c: any, next: any) => {
    if (!state.read) return c.json({ error: 'Forbidden' }, 403);
    await next();
  },
}));
vi.mock('../../services/delivery/describeDelivery', () => ({ previewDelivery: state.preview }));
import { deliveryRoutes } from './delivery';
import { DeliveryWriteError } from '../../services/delivery/routingRuleWrites';
const ORG = '11111111-1111-4111-8111-111111111111';
const app = new Hono().route('/alerts', deliveryRoutes);
const path = `/alerts/delivery/resolve?orgId=${ORG}&severity=critical&kind=cpu`;
beforeEach(() => {
  vi.clearAllMocks(); state.authenticated = true; state.read = true;
  state.preview.mockResolvedValue({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null,
    source: 'none', display: 'Critical → Inbox only (no delivery row)',
    description: { channels: [], escalationPolicy: null, owner: null } });
});
describe('GET /alerts/delivery/resolve', () => {
  it('returns the resolver result and display without an envelope or mutation', async () => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: 'none', channelIds: [], display: expect.stringContaining('Inbox only') });
    expect(state.preview).toHaveBeenCalledWith({ orgId: ORG, severity: 'critical', kind: 'cpu' }, { scope: 'organization' });
  });
  it.each(['', '?severity=high', `?orgId=${ORG}`, `?orgId=${ORG}&severity=urgent`,
    `?orgId=${ORG}&severity=high&kind=unknown`, `?orgId=${ORG}&severity=high&siteId=bad`])('rejects invalid query %s', async (query) => {
    expect((await app.request('/alerts/delivery/resolve' + query)).status).toBe(400);
    expect(state.preview).not.toHaveBeenCalled();
  });
  it('requires authentication and read permission', async () => {
    state.authenticated = false;
    expect((await app.request(path)).status).toBe(401);
    state.authenticated = true; state.read = false;
    expect((await app.request(path)).status).toBe(403);
    expect(state.preview).not.toHaveBeenCalled();
  });
  it.each([403, 404] as const)('preserves access errors (%s)', async (status) => {
    state.preview.mockRejectedValue(new DeliveryWriteError(status, 'Not available'));
    expect((await app.request(path)).status).toBe(status);
  });
  it('returns a safe 500 when resolution fails', async () => {
    state.preview.mockRejectedValue(new Error('database detail'));
    const res = await app.request(path);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('database detail');
  });
});
```

`apps/api/src/services/delivery/describeDelivery.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ rows: [] as unknown[][], resolve: vi.fn() }));
vi.mock('../../db', () => ({ db: { select: () => {
  const chain: any = { from: () => chain, where: () => chain, limit: () => chain,
    then: (ok: any, fail: any) => Promise.resolve(state.rows.shift() ?? []).then(ok, fail) };
  return chain;
} } }));
vi.mock('./resolveDelivery', () => ({ resolveDelivery: state.resolve }));
import { describeDelivery, previewDelivery } from './describeDelivery';
import type { AuthContext } from '../../middleware/auth';
const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const auth = { scope: 'organization', orgId: ORG, partnerId: PARTNER,
  canAccessOrg: (id: string) => id === ORG, allowedSiteIds: undefined } as AuthContext;
const input = { orgId: ORG, severity: 'critical' as const };
beforeEach(() => { state.rows.length = 0; vi.clearAllMocks(); });
describe('delivery description and preview access', () => {
  it('names the partner rule, channels, and independent escalation', async () => {
    state.rows.push([{ partnerId: PARTNER }], [{ id: 'ch', name: 'PagerDuty', enabled: true }],
      [{ id: 'ep', name: 'On-call' }], [{ orgId: null }]);
    const out = await describeDelivery(input, { skippedChannelIds: [], channelIds: ['ch'], escalationPolicyId: 'ep',
      source: 'routing_rule', routingRuleId: 'r', routingRuleName: 'Pages' });
    expect(out.display).toBe('Critical → PagerDuty (partner rule "Pages"), escalates via On-call');
    expect(out.description.owner).toBe('partner');
  });
  it('does not mistake an empty default for no configuration', async () => {
    state.rows.push([{ partnerId: PARTNER }], [{ orgId: ORG }]);
    const out = await describeDelivery(input, { skippedChannelIds: [], channelIds: [], escalationPolicyId: null,
      source: 'default_row', routingRuleId: 'r', routingRuleName: 'Everything else' });
    expect(out.display).toBe('Critical → Inbox only (organization default "Everything else")');
  });
  it('rejects foreign orgs before any query', async () => {
    await expect(previewDelivery({ ...input, orgId: PARTNER }, auth)).rejects.toMatchObject({ status: 403 });
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it('requires an allowed site for site-limited callers', async () => {
    await expect(previewDelivery(input, { ...auth, allowedSiteIds: [] })).rejects.toMatchObject({ status: 403 });
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it('rejects a missing org, a site in another org, and a monitor outside the org rails', async () => {
    state.rows.push([]);
    await expect(previewDelivery(input, auth)).rejects.toMatchObject({ status: 404 });
    state.rows.push([{ partnerId: PARTNER }], []);
    await expect(previewDelivery({ ...input, siteId: 'site' }, auth)).rejects.toMatchObject({ status: 404 });
    state.rows.push([{ partnerId: PARTNER }], []);
    await expect(previewDelivery({ ...input, monitorId: 'monitor' }, auth)).rejects.toMatchObject({ status: 404 });
    expect(state.resolve).not.toHaveBeenCalled();
  });
  it('passes only authorized facts to the shared resolver', async () => {
    state.rows.push([{ partnerId: PARTNER }], [{ id: 'site' }], [{ id: 'monitor' }], [{ partnerId: PARTNER }]);
    state.resolve.mockResolvedValue({ skippedChannelIds: [], channelIds: [], escalationPolicyId: null, source: 'monitor_none' });
    const facts = { ...input, siteId: 'site', monitorId: 'monitor' };
    expect((await previewDelivery(facts, auth)).source).toBe('monitor_none');
    expect(state.resolve).toHaveBeenCalledWith(facts);
  });
});
```

**Step 1 (continued): Extend Task 7's real-Postgres suite before implementing the endpoint**

Retain Task 7's `vi`, `sql`, `getNotificationQueue`, and `orgCtx` imports/helpers. Merge the following imports into that file and extend Task 8's existing middleware mock to this single definition (do not duplicate `Hono`, `deliveryRailsRoutes`, or the mock). Add the request/preview helpers below. Only HTTP authentication/permission injection is mocked; the resolver, ownership queries, route validation, description lookup, and `breeze_app` RLS all remain real. Authentication denials are covered by the route unit suite above. Queue transport is spied, so this gate never sends anything externally.

```ts
import { Hono } from 'hono';
import type { AuthContext } from '../../middleware/auth';
import type { ResolveDeliveryInput } from '../../services/delivery/resolveDelivery';
import type { DeliveryPreview } from '../../services/delivery/describeDelivery';
vi.mock('../../middleware/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return { ...actual,
    requireMfa: () => async (_c: any, next: any) => next(),
    requireScope: () => async (_c: any, next: any) => next(),
    requirePermission: () => async (_c: any, next: any) => next(),
  };
});
import { deliveryRoutes } from '../../routes/alerts/delivery';
import { deliveryRailsRoutes } from '../../routes/alerts/deliveryRails';
import { channelsRoutes } from '../../routes/alerts/channels';
import { routingRoutes } from '../../routes/alerts/routing';
import { policiesRoutes } from '../../routes/alerts/policies';

function requestAsOrg(f: DeliveryFixture, path: string, init?: RequestInit) {
  const auth = { scope: 'organization', orgId: f.orgId, partnerId: f.partnerId,
    canAccessOrg: (id: string) => id === f.orgId, allowedSiteIds: undefined } as AuthContext;
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('auth', auth); await next(); });
  app.route('/alerts', deliveryRoutes);
  app.route('/alerts', deliveryRailsRoutes);
  app.route('/alerts', channelsRoutes);
  app.route('/alerts', routingRoutes);
  app.route('/alerts', policiesRoutes);
  return withDbAccessContext(orgCtx(f), async () => {
    const role = await db.execute(sql`select current_user as role`);
    expect(role[0]?.role).toBe('breeze_app');
    return app.request(path, init);
  });
}

function previewAs(f: DeliveryFixture, facts: ResolveDeliveryInput) {
  const query = new URLSearchParams({ orgId: facts.orgId, severity: facts.severity });
  if (facts.kind) query.set('kind', facts.kind);
  if (facts.monitorId) query.set('monitorId', facts.monitorId);
  if (facts.siteId) query.set('siteId', facts.siteId);
  return requestAsOrg(f, `/alerts/delivery/resolve?${query}`);
}

async function agree(f: DeliveryFixture, facts: ResolveDeliveryInput, expectedChannels: string[], expectedEscalationChannels: string[] = []) {
  const response = await previewAs(f, facts);
  expect(response.status).toBe(200);
  const preview = await response.json() as DeliveryPreview;
  const resolved = await sys(() => resolveDelivery(facts));
  const { display, description, ...decision } = preview;
  expect(decision).toEqual(resolved);
  expect(display.length).toBeGreaterThan(0);
  expect([...decision.channelIds].sort()).toEqual([...expectedChannels].sort());
  expect(description.channels.map(c => c.id).sort()).toEqual([...expectedChannels].sort());
  const bulk = vi.spyOn(getNotificationQueue(), 'addBulk').mockResolvedValue([]);
  const single = vi.spyOn(getNotificationQueue(), 'add').mockResolvedValue({ getState: async () => 'waiting' } as never);
  try {
    const result = await dispatch(await seedAlert(f, facts.severity as 'high', facts.monitorId ?? null));
    const queuedIds = bulk.mock.calls.flatMap(([jobs]) => jobs.map(job => job.data.channelId));
    expect(queuedIds.sort()).toEqual([...expectedChannels].sort());
    const escalationIds = single.mock.calls.map(([, job]) => job.channelId);
    expect(escalationIds.sort()).toEqual([...expectedEscalationChannels].sort());
    expect(result.queued).toBe(expectedChannels.length);
    expect(result.inAppSent).toBe(true);
  } finally { bulk.mockRestore(); single.mockRestore(); }
}

describe('full W05b gate — dispatch ⇄ resolver ⇄ GET preview', () => {
  runDb('org-row wins at equal priority and schedules the winning row escalation', async () => {
    const f = await seedFixture();
    const [policy] = await sys(() => db.insert(escalationPolicies).values({ orgId: f.orgId, name: 'On-call',
      steps: [{ delayMinutes: 5, channelIds: [f.orgChannel] }] }).returning());
    created.policies.push(policy!.id);
    await seedRule({ partnerId: f.partnerId, conditions: { severities: ['critical'] }, channelIds: [f.partnerChannel] });
    await seedRule({ orgId: f.orgId, conditions: { severities: ['critical'] }, channelIds: [f.orgChannel], escalationPolicyId: policy!.id });
    await agree(f, { orgId: f.orgId, severity: 'critical', siteId: f.siteId }, [f.orgChannel], [f.orgChannel]);
  });
  runDb('org token inherits a partner row; foreign-partner rows cannot win', async () => {
    const f = await seedFixture();
    const foreign = await createPartner();
    await seedRule({ partnerId: foreign.id, priority: 0, channelIds: [f.orgChannel] });
    await seedRule({ partnerId: f.partnerId, channelIds: [f.partnerChannel] });
    await agree(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId }, [f.partnerChannel]);
  });
  runDb('org default shadows partner default, then partner default covers an org with no override', async () => {
    const f = await seedFixture();
    await seedRule({ partnerId: f.partnerId, isDefault: true, channelIds: [f.partnerChannel] });
    const override = await seedRule({ orgId: f.orgId, isDefault: true, channelIds: [f.orgChannel, f.partnerChannel] });
    await agree(f, { orgId: f.orgId, severity: 'low', siteId: f.siteId }, [f.orgChannel, f.partnerChannel]);
    // Fixture removal models the absence of an optional org row; it is not a UI delete contract.
    await sys(() => db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, override.id)));
    await agree(f, { orgId: f.orgId, severity: 'low', siteId: f.siteId }, [f.partnerChannel]);
  });
  runDb('all three inbox-only paths agree and none never schedules monitor escalation', async () => {
    const f = await seedFixture();
    await agree(f, { orgId: f.orgId, severity: 'medium', siteId: f.siteId }, []);
    await seedRule({ orgId: f.orgId, isDefault: true, channelIds: [] });
    await agree(f, { orgId: f.orgId, severity: 'medium', siteId: f.siteId }, []);
    const [monitor] = await sys(() => db.insert(monitorDefinitions).values({ orgId: f.orgId, name: 'Quiet preview',
      kind: 'cpu', severity: 'high', condition: { operator: 'gt', value: 90 }, deliveryMode: 'none' }).returning());
    created.monitors.push(monitor!.id);
    await seedRule({ partnerId: f.partnerId, channelIds: [f.partnerChannel] });
    await agree(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId, monitorId: monitor!.id }, []);
  });
  runDb('preview and dispatch agree on disabled and unavailable references and retain escalation', async () => {
    const f = await seedFixture();
    const other = await seedFixture();
    const missing = '99999999-9999-4999-8999-999999999999';
    await sys(() => db.update(notificationChannels).set({ enabled: false }).where(eq(notificationChannels.id, f.orgChannel)));
    const [policy] = await sys(() => db.insert(escalationPolicies).values({ orgId: f.orgId, name: 'Still escalate',
      steps: [{ delayMinutes: 5, channelIds: [f.partnerChannel] }] }).returning());
    created.policies.push(policy!.id);
    await seedRule({ orgId: f.orgId, channelIds: [f.orgChannel, other.orgChannel, missing], escalationPolicyId: policy!.id });
    await agree(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId }, [], [f.partnerChannel]);
    const result = await (await previewAs(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId })).json();
    expect(result.skippedChannelIds).toEqual([
      { id: f.orgChannel, reason: 'disabled' }, { id: other.orgChannel, reason: 'unavailable' }, { id: missing, reason: 'unavailable' },
    ]);
  });
  runDb('foreign and absent channel IDs have identical preview reasons and HTTP shapes; rails reveal neither', async () => {
    const f = await seedFixture();
    const foreign = await seedFixture();
    const missing = '99999999-9999-4999-8999-999999999999';
    const row = await seedRule({ orgId: f.orgId, channelIds: [foreign.orgChannel] });
    const observations = [];
    for (const id of [foreign.orgChannel, missing]) {
      await sys(() => db.update(notificationRoutingRules).set({ channelIds: [id] })
        .where(eq(notificationRoutingRules.id, row.id)));
      const response = await previewAs(f, { orgId: f.orgId, severity: 'high', siteId: f.siteId });
      const body = await response.json() as DeliveryPreview;
      expect(body.skippedChannelIds).toEqual([{ id, reason: 'unavailable' }]);
      // Only the caller's echoed reference differs; no name, owner or existence bit is returned.
      const normalized = { ...body, skippedChannelIds: body.skippedChannelIds.map(item => ({ ...item, id: '<requested>' })) };
      const railsResponse = await requestAsOrg(f, '/alerts/delivery/rails?rail=channels');
      const rails = await railsResponse.json();
      expect([...rails.data, ...rails.inherited].filter((channel: { id: string }) => channel.id === id)).toEqual([]);
      observations.push({ previewStatus: response.status, preview: normalized,
        railsStatus: railsResponse.status, rails });
    }
    expect(observations[0]).toEqual(observations[1]);
    expect(observations[0]?.previewStatus).toBe(200);
    expect(observations[0]?.railsStatus).toBe(200);
    // The existing rails API lists visible choices; it has no ID lookup or skip-reason field.
    // Both references are absent from the same safe list; preview carries the identical reason.
  });

  runDb('org HTTP reads inherit only the safe partner channel DTO, with no config key', async () => {
    const f = await seedFixture();
    const response = await requestAsOrg(f, '/alerts/delivery/rails?rail=channels');
    expect(response.status).toBe(200);
    const rails = await response.json();
    expect(rails.inherited).toEqual([{ id: f.partnerChannel, name: 'Partner NOC',
      type: 'slack', enabled: true, inherited: true }]);
    expect(rails.inherited[0]).not.toHaveProperty('config');
  });

  runDb('org HTTP writes cannot create partner channels, routing rows or escalation policies (403)', async () => {
    const f = await seedFixture();
    const attempts = [
      { path: '/alerts/channels', body: { name: 'Forbidden', type: 'slack', config: {}, ownerScope: 'partner' } },
      { path: '/alerts/routing-rules', body: { name: 'Forbidden', conditions: {}, channelIds: [f.partnerChannel], ownerScope: 'partner' } },
      { path: '/alerts/policies', body: { name: 'Forbidden', steps: [{ delayMinutes: 5, channelIds: [f.partnerChannel] }], ownerScope: 'partner' } },
    ];
    for (const { path, body } of attempts) {
      const response = await requestAsOrg(f, path, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(403);
    }
  });

  runDb('rejects an otherwise readable monitor from a sibling org', async () => {
    const f = await seedFixture();
    const other = await createOrganization({ partnerId: f.partnerId });
    const [monitor] = await sys(() => db.insert(monitorDefinitions).values({ orgId: other.id, name: 'Foreign',
      kind: 'cpu', severity: 'high', condition: {}, deliveryMode: 'channels', deliveryChannelIds: [f.orgChannel] }).returning());
    created.monitors.push(monitor!.id);
    const response = await previewAs(f, { orgId: f.orgId, severity: 'high', monitorId: monitor!.id });
    expect(response.status).toBe(404);
    expect((await previewAs(f, { orgId: other.id, severity: 'high' })).status).toBe(403);
  });
});
```

Run this extension before creating `delivery.ts` to see `Failed to load url ../../routes/alerts/delivery`; with the file mounted incorrectly the HTTP leg fails `expected 404 to be 200`. A destination mismatch fails the array comparison even when `queued` counts agree. Keep the Task 7 cases: they cover `monitorKinds` and the non-null policy on a `none` monitor as well.

- [ ] **Step 2: Run, expect FAIL** (all commands in this task start at the repository root; subshells keep the next command there)

```bash
(cd apps/api && npx vitest run src/routes/alerts/delivery.test.ts src/services/delivery/describeDelivery.test.ts)
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deliveryResolution.integration.test.ts)
```
Expected: `Failed to load url ./delivery` / `Failed to load url ./describeDelivery` (Vitest may phrase module discovery as `Cannot find module`).

- [ ] **Step 3: Implement the shared authorized preview and mount its route**

`apps/api/src/services/delivery/describeDelivery.ts`:

```ts
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { organizations, sites, monitorDefinitions, notificationChannels, escalationPolicies, notificationRoutingRules } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { siteAccessCheck } from '../../middleware/auth';
import { resolveDelivery, type ResolveDeliveryInput, type ResolvedDelivery } from './resolveDelivery';
import { partnerIdForOrg, railOwnershipCondition, type DbExecutor } from './railOwnership';
import { DeliveryWriteError } from './routingRuleWrites';

export interface DeliveryPreview extends ResolvedDelivery {
  display: string;
  description: {
    channels: Array<{ id: string; name: string; enabled: boolean }>;
    escalationPolicy: { id: string; name: string } | null;
    owner: 'organization' | 'partner' | null;
  };
}

export async function previewDelivery(input: ResolveDeliveryInput, auth: AuthContext): Promise<DeliveryPreview> {
  if (!auth.canAccessOrg(input.orgId) || (auth.scope === 'organization' && auth.orgId !== input.orgId)) {
    throw new DeliveryWriteError(403, 'Access to this organization denied');
  }
  if (auth.allowedSiteIds !== undefined && !siteAccessCheck(auth.allowedSiteIds)(input.siteId)) {
    throw new DeliveryWriteError(403, 'An authorized site is required');
  }
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, input.orgId)).limit(1);
  if (!org) throw new DeliveryWriteError(404, 'Organization not found');
  if (input.siteId) {
    const [site] = await db.select({ id: sites.id }).from(sites)
      .where(and(eq(sites.id, input.siteId), eq(sites.orgId, input.orgId))).limit(1);
    if (!site) throw new DeliveryWriteError(404, 'Site not found');
  }
  if (input.monitorId) {
    const [monitor] = await db.select({ id: monitorDefinitions.id }).from(monitorDefinitions)
      .where(and(eq(monitorDefinitions.id, input.monitorId),
        railOwnershipCondition(monitorDefinitions.orgId, monitorDefinitions.partnerId, input.orgId, org.partnerId))).limit(1);
    if (!monitor) throw new DeliveryWriteError(404, 'Monitor not found');
  }
  const resolved = await resolveDelivery(input);
  return describeDelivery(input, resolved);
}

export async function describeDelivery(
  input: ResolveDeliveryInput, resolved: ResolvedDelivery, executor: DbExecutor = db,
): Promise<DeliveryPreview> {
  const partnerId = await partnerIdForOrg(input.orgId, executor);
  const channels = resolved.channelIds.length ? await executor.select({
    id: notificationChannels.id, name: notificationChannels.name, enabled: notificationChannels.enabled,
  }).from(notificationChannels).where(and(
    inArray(notificationChannels.id, resolved.channelIds),
    railOwnershipCondition(notificationChannels.orgId, notificationChannels.partnerId, input.orgId, partnerId),
  )) : [];
  const [policy] = resolved.escalationPolicyId ? await executor.select({ id: escalationPolicies.id, name: escalationPolicies.name })
    .from(escalationPolicies).where(and(eq(escalationPolicies.id, resolved.escalationPolicyId),
      railOwnershipCondition(escalationPolicies.orgId, escalationPolicies.partnerId, input.orgId, partnerId))).limit(1) : [];
  const [rule] = resolved.routingRuleId ? await executor.select({ orgId: notificationRoutingRules.orgId })
    .from(notificationRoutingRules).where(and(eq(notificationRoutingRules.id, resolved.routingRuleId),
      railOwnershipCondition(notificationRoutingRules.orgId, notificationRoutingRules.partnerId, input.orgId, partnerId))).limit(1) : [];
  const owner = rule ? (rule.orgId === null ? 'partner' : 'organization') : null;
  const names = resolved.channelIds.map(id => {
    const channel = channels.find(c => c.id === id);
    return channel ? `${channel.name}${channel.enabled ? '' : ' (disabled)'}` : 'Unavailable channel';
  });
  const origin = resolved.source === 'routing_rule' || resolved.source === 'default_row'
    ? `${owner ?? 'unavailable'} ${resolved.source === 'default_row' ? 'default' : 'rule'} "${resolved.routingRuleName ?? ''}"`
    : { monitor_none: 'monitor: inbox only', monitor_channels: 'monitor override',
        legacy_override: 'legacy override', none: 'no delivery row' }[resolved.source];
  const severity = input.severity[0]!.toUpperCase() + input.severity.slice(1);
  return {
    ...resolved,
    display: `${severity} → ${names.join(', ') || 'Inbox only'} (${origin})${resolved.escalationPolicyId ? `, escalates via ${policy?.name ?? 'Unavailable policy'}` : ''}`,
    description: { channels, escalationPolicy: policy ?? null, owner },
  };
}
```

`apps/api/src/routes/alerts/delivery.ts`:

```ts
import { Hono } from 'hono';
import { z } from 'zod';
import { monitorKindSchema, monitorSeveritySchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { previewDelivery } from '../../services/delivery/describeDelivery';
import { DeliveryWriteError } from '../../services/delivery/routingRuleWrites';

export const deliveryPreviewQuerySchema = z.object({
  orgId: z.string().guid(), severity: monitorSeveritySchema,
  kind: monitorKindSchema.optional(), siteId: z.string().guid().optional(), monitorId: z.string().guid().optional(),
}).strict();
export const deliveryRoutes = new Hono();
deliveryRoutes.get('/delivery/resolve',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ALERTS_READ.resource, PERMISSIONS.ALERTS_READ.action),
  zValidator('query', deliveryPreviewQuerySchema),
  async c => {
    try {
      return c.json(await previewDelivery(c.req.valid('query'), c.get('auth')));
    } catch (error) {
      if (error instanceof DeliveryWriteError) return c.json({ error: error.message }, error.status);
      console.error('[DeliveryPreview] Failed to resolve delivery', error);
      return c.json({ error: 'Failed to resolve delivery' }, 500);
    }
  },
);
```

Add these two lines to `routes/alerts/index.ts`, the import with the other imports and the mount immediately before `alertRoutes.route('/', alertsRoutes)`:

```ts
import { deliveryRoutes } from './delivery';
alertRoutes.route('/', deliveryRoutes);
```

- [ ] **Step 4: Run, expect PASS**

```bash
(cd apps/api && npx vitest run src/routes/alerts/delivery.test.ts src/services/delivery/describeDelivery.test.ts)
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deliveryResolution.integration.test.ts src/__tests__/integration/notificationRailsPartnerRls.integration.test.ts)
```
Expected: 200/403/404 assertions above pass, all delivery integration cases execute, zero skipped. Start the isolated test stack under Task 17 if it is not already running; do not substitute mocked database tests for this gate.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/alerts/delivery.ts apps/api/src/routes/alerts/delivery.test.ts apps/api/src/routes/alerts/index.ts apps/api/src/services/delivery/describeDelivery.ts apps/api/src/services/delivery/describeDelivery.test.ts apps/api/src/__tests__/integration/deliveryResolution.integration.test.ts
git commit -m "feat(api): preview delivery with provenance and prove dispatcher agreement (W05b)"
```

---

### Task 14: Notify card shows resolved inheritance; Delivery offers the same read-only preview

**Files:**
- Modify: `apps/web/src/components/monitoring/MonitorEditor.tsx:179-221,255-265,291-301,344-352,776-815,871-888`; extend `MonitorEditor.test.tsx:1-120,480-510`'s fetch harness and append tests
- Create: `apps/web/src/components/alerts/delivery/DeliveryPreview.tsx`, `DeliveryPreview.test.tsx`, `DeliveryRuleSetPreview.tsx`
- Modify: `apps/web/src/components/alerts/DeliveryPage.tsx` (Task 11 composition; add preview after Routing)
- Modify: all eight `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/monitoring.json` (`editor.deliveryPreview`)
- Consume: `apps/web/src/lib/useHashState.ts:1-84`, `apps/web/src/locales/README.md:15-54`, `apps/web/src/locales/en/monitoring.json:80-84,191-197` (existing delivery and severity labels). Opened locale directory contains exactly the eight locales listed above.

**Interfaces:**
- Consumes: Task 8's `/alerts/delivery/rails?rail=channels|escalation&orgId=<uuid>` and safe inherited channel metadata; Task 10's `useDeliveryResource`; Task 13's bare `DeliveryPreview` JSON; existing `fetchWithAuth`, `asList`, `useHashState`, `monitoring:severities.*`, `monitoring:kinds.*`, `monitoring:editor.deliveryModes.*`.
- Produces: `DeliveryPreview({ orgId, severity, kind?, siteId?, monitorId?, escalationOverride? })`. New monitors and an editor currently choosing **Inherit** request the routing baseline **without `monitorId`**: otherwise a saved `channels`/`none` mode would incorrectly override an unsaved switch to Inherit. An explicit draft escalation selection is displayed independently of the routing baseline, using the already loaded policy name. The resolver still computes all inherited choices. No client reimplementation of routing precedence.
- Produces: `DeliveryRuleSetPreview({ orgId })` on Delivery, with severity/kind/site inputs and a shared preview. No channel-send mutation. Selection is stored in `location.hash` (`#preview/<severity>/<kind-or-all>/<site-or-all>`). Monitor settings/activity hashes stay unchanged. API query strings carry request facts; they never store browser UI state.
- Mode `none` retains the existing localized Inbox-only choice and hides the escalation-policy selector. Mode `channels` retains the existing channel picker, but loads its choices from the delivery rails endpoint, merging channel `data` with safe `inherited` metadata. Load escalation choices from the same endpoint with `rail=escalation`, then apply the DTO-aware `compatibleEscalationPolicies` filter below; neither picker reads `/alerts/channels` or `/alerts/policies`. Move the existing policy selector from the recurrence card into Notify, below these choices, for modes other than `none`; preserve its field name, test ID, and owner-compatible choices. Empty escalation selection means inherit, consistent with independent escalation resolution.
- Preview states: selected org required, loading, response, failure with Retry. A changed org/kind/severity/site immediately hides stale data. Never label a failed request “Inbox only”. Without a site the card explicitly explains that site-specific rows are excluded. Existing monitor saves stay on `runAction`; these new requests are GET only.

- [ ] **Step 1: Write the failing tests**

`DeliveryPreview.test.tsx`:

```tsx
import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
import DeliveryPreview from './DeliveryPreview';
import DeliveryRuleSetPreview from './DeliveryRuleSetPreview';
const fetchMock = vi.mocked(fetchWithAuth);
const json = (body: unknown, status = 200) => ({ ok: status === 200, status, json: async () => body }) as Response;
const answer = { skippedChannelIds: [], source: 'routing_rule', channelIds: ['ch'], escalationPolicyId: 'ep',
  routingRuleId: 'r', routingRuleName: 'Pages', display: 'API English display',
  description: { channels: [{ id: 'ch', name: 'PagerDuty', enabled: true }],
    escalationPolicy: { id: 'ep', name: 'On-call' }, owner: 'partner' } };
beforeEach(() => { vi.clearAllMocks(); window.location.hash = ''; fetchMock.mockResolvedValue(json(answer)); });
describe('DeliveryPreview', () => {
  it('shows channel names, partner provenance, and independently resolved escalation', async () => {
    render(<DeliveryPreview orgId="org-1" severity="critical" kind="cpu" />);
    expect(await screen.findByTestId('delivery-preview-result')).toHaveTextContent('Critical → PagerDuty');
    expect(screen.getByTestId('delivery-preview-result')).toHaveTextContent('Partner rule: Pages');
    expect(screen.getByTestId('delivery-preview-result')).toHaveTextContent('Escalates via On-call');
    expect(fetchMock.mock.calls[0]![0]).toContain('kind=cpu');
    expect(fetchMock.mock.calls[0]![0]).not.toContain('monitorId=');
  });
  it('shows skipped destinations and still shows independent escalation', async () => {
    fetchMock.mockResolvedValue(json({ ...answer, channelIds: [], skippedChannelIds: [
      { id: 'disabled-channel', reason: 'disabled' }, { id: 'foreign-channel', reason: 'unavailable' }, { id: 'gone-channel', reason: 'unavailable' },
    ] }));
    render(<DeliveryPreview orgId="org-1" severity="high" />);
    const result = await screen.findByTestId('delivery-preview-result');
    expect(result).toHaveTextContent('disabled-channel: disabled');
    expect(result).toHaveTextContent('foreign-channel: unavailable');
    expect(result).toHaveTextContent('gone-channel: unavailable');
    expect(result).toHaveTextContent('Escalates via On-call');
  });
  it('shows the explicit draft escalation instead of the row escalation', async () => {
    render(<DeliveryPreview orgId="org-1" severity="critical" escalationOverride={{ id: 'draft', name: 'Weekend' }} />);
    expect(await screen.findByTestId('delivery-preview-result')).toHaveTextContent('Escalates via Weekend');
    expect(screen.getByTestId('delivery-preview-result')).not.toHaveTextContent('On-call');
  });
  it('asks for a concrete organization without guessing a partner-wide result', () => {
    render(<DeliveryPreview orgId={null} severity="high" />);
    expect(screen.getByText('Select an organization to preview delivery.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('shows errors and retries instead of inventing an inbox-only result', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'Unavailable' }, 500));
    render(<DeliveryPreview orgId="org-1" severity="high" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not preview delivery.');
    expect(screen.queryByTestId('delivery-preview-result')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('delivery-preview-result')).toBeInTheDocument();
  });
  it('does not render an old response after changing organization', async () => {
    let finishOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishOld = resolve; }));
    const view = render(<DeliveryPreview orgId="old" severity="high" />);
    view.rerender(<DeliveryPreview orgId="new" severity="high" />);
    await screen.findByTestId('delivery-preview-result');
    await act(async () => finishOld(json({ ...answer, routingRuleName: 'Old org' })));
    expect(screen.getByTestId('delivery-preview-result')).not.toHaveTextContent('Old org');
  });
  it('stores rule-set preview selection in the hash, not the page query', async () => {
    fetchMock.mockImplementation(async url => url.startsWith('/orgs/sites') ? json({ data: [] }) : json(answer));
    render(<DeliveryRuleSetPreview orgId="org-1" />);
    fireEvent.change(screen.getByTestId('delivery-preview-severity'), { target: { value: 'critical' } });
    await waitFor(() => expect(window.location.hash).toBe('#preview/critical/all/all'));
    expect(window.location.search).toBe('');
  });
});
```

In `MonitorEditor.test.tsx`, replace the old channel/policy interceptors in `defaultFetchImpl` and the existing policy/channel tests with `/alerts/delivery/rails?rail=channels` and `/alerts/delivery/rails?rail=escalation` prefix checks (the query includes `orgId`). The default harness returns `{ data: [], inherited: [] }` for channels and `{ data: [] }` for escalation; existing tests keep their channel/policy fixtures under the new endpoint interceptors. In the saved-owner test, await the populated policy options with `waitFor` instead of relying on the monitor request finishing last. Retain the incompatible-owner regression. Add the following preview branch before the fallback, then append inside the existing `describe` (its `beforeEach` remains):

```ts
if (input.startsWith('/alerts/delivery/resolve')) return json({ skippedChannelIds: [], channelIds: [],
  escalationPolicyId: null, source: 'none', description: { channels: [], escalationPolicy: null, owner: null } });
```

```tsx
  it('previews unsaved Inherit instead of the saved channels mode, and keeps delivery configuration at its home', async () => {
    fetchMock.mockImplementation(async input => {
      if (input === '/monitor-definitions/m1') return json({ data: { ...MONITOR_M1_FIXTURE, deliveryMode: 'channels', deliveryChannelIds: ['ch'] } });
      if (input.startsWith('/alerts/delivery/resolve')) return json({ skippedChannelIds: [], channelIds: ['ch'], escalationPolicyId: null,
        source: 'default_row', routingRuleName: 'Everything else', description: {
          channels: [{ id: 'ch', name: 'NOC', enabled: true }], escalationPolicy: null, owner: 'partner' } });
      return defaultFetchImpl(input);
    });
    render(<MonitorEditor monitorId="m1" />);
    await screen.findByDisplayValue('Disk full');
    fireEvent.click(screen.getByTestId('monitor-editor-delivery-inherit'));
    expect(await screen.findByTestId('delivery-preview-result')).toHaveTextContent('NOC');
    const calls = fetchMock.mock.calls.filter(([url]) => url.startsWith('/alerts/delivery/resolve'));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([url]) => !url.includes('monitorId='))).toBe(true);
    expect(screen.getByTestId('monitor-editor-delivery-home')).toHaveAttribute('href', '/alerts/delivery');
    fireEvent.click(screen.getByTestId('monitor-editor-delivery-none'));
    expect(screen.queryByTestId('delivery-preview-result')).toBeNull();
    expect(screen.queryByTestId('monitor-editor-escalation-policy')).toBeNull();
  });
```

Add this top-level mock to `MonitorEditor.test.tsx` (the existing auth mock provides only `fetchWithAuth`):

```tsx
vi.mock('../../lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'partner-1' } }),
}));
```

Append these editor regressions using the existing `json`, `defaultFetchImpl`, and `MONITOR_M1_FIXTURE` helpers. Only the rails response supplies the inherited choices; legacy administrative endpoints must never be called.

```tsx
it.each(['create', 'edit'] as const)('%s selects inherited channels and escalation and saves their IDs', async mode => {
  const inheritedChannel = { id: 'partner-channel', name: 'Partner NOC', type: 'slack', enabled: true, inherited: true };
  const inheritedPolicy = { id: 'partner-policy', name: 'Partner escalation', stepCount: 1, inherited: true };
  const saved = { ...MONITOR_M1_FIXTURE, deliveryMode: 'channels',
    deliveryChannelIds: [inheritedChannel.id], escalationPolicyId: inheritedPolicy.id };
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input.startsWith('/alerts/delivery/rails?rail=channels')) return json({
      data: [{ id: 'org-channel', name: 'Org email', type: 'email', config: {} }], inherited: [inheritedChannel],
    });
    if (input.startsWith('/alerts/delivery/rails?rail=escalation')) return json({ data: [inheritedPolicy] });
    if (input === '/monitor-definitions/m1') return json({ data: saved });
    if (input === '/monitor-definitions' && init?.method === 'POST') return json({ data: { id: 'new-1' } }, true, 201);
    return defaultFetchImpl(input);
  });
  render(<MonitorEditor monitorId={mode === 'edit' ? 'm1' : undefined} />);
  await screen.findByTestId('monitor-editor-name');
  if (mode === 'create') {
    fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Disk full' } });
    fireEvent.click(screen.getByTestId('monitor-editor-delivery-channels'));
  }
  await screen.findByRole('option', { name: 'Partner NOC (slack)' });
  await screen.findByRole('option', { name: 'Partner escalation' });
  const channelPicker = screen.getByTestId('monitor-editor-channels') as HTMLSelectElement;
  const policyPicker = screen.getByTestId('monitor-editor-escalation-policy');
  expect(Array.from(channelPicker.options, option => option.value)).toEqual(['org-channel', 'partner-channel']);
  if (mode === 'create') {
    for (const option of channelPicker.options) option.selected = option.value === inheritedChannel.id;
    fireEvent.change(channelPicker);
    fireEvent.change(policyPicker, { target: { value: inheritedPolicy.id } });
  }
  expect(channelPicker).toHaveValue([inheritedChannel.id]);
  expect(policyPicker).toHaveValue(inheritedPolicy.id);
  fireEvent.click(screen.getByTestId('monitor-editor-save'));
  const method = mode === 'edit' ? 'PATCH' : 'POST';
  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === method)).toBe(true));
  const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === method)!;
  expect(JSON.parse(init!.body as string)).toMatchObject({ deliveryMode: 'channels',
    deliveryChannelIds: [inheritedChannel.id], escalationPolicyId: inheritedPolicy.id });
  const rails = fetchMock.mock.calls.filter(([url]) => url.startsWith('/alerts/delivery/rails'));
  expect(rails.some(([url]) => url === '/alerts/delivery/rails?rail=channels&orgId=org-1')).toBe(true);
  expect(rails.some(([url]) => url === '/alerts/delivery/rails?rail=escalation&orgId=org-1')).toBe(true);
  expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/alerts/channels') || url.startsWith('/alerts/policies'))).toBe(false);
});
it('late inherited choices do not refetch the monitor or overwrite unsaved edits', async () => {
  let finishChannels!: (response: Response) => void;
  fetchMock.mockImplementation(async (input: string) => {
    if (input === '/monitor-definitions/m1') return json({ data: { ...MONITOR_M1_FIXTURE,
      deliveryMode: 'channels', deliveryChannelIds: ['partner-channel'], escalationPolicyId: 'partner-policy' } });
    if (input.startsWith('/alerts/delivery/rails?rail=channels')) return new Promise<Response>(resolve => { finishChannels = resolve; });
    if (input.startsWith('/alerts/delivery/rails?rail=escalation')) return json({ data: [
      { id: 'partner-policy', name: 'Partner escalation', stepCount: 1, inherited: true },
    ] });
    return defaultFetchImpl(input);
  });
  render(<MonitorEditor monitorId="m1" />);
  await screen.findByDisplayValue('Disk full');
  fireEvent.change(screen.getByTestId('monitor-editor-name'), { target: { value: 'Draft name' } });
  await act(async () => finishChannels(json({ data: [], inherited: [{ id: 'partner-channel', name: 'Partner NOC', type: 'slack', enabled: true, inherited: true }] })));
  expect(await screen.findByRole('option', { name: 'Partner NOC (slack)' })).toBeInTheDocument();
  expect(screen.getByTestId('monitor-editor-channels')).toHaveValue(['partner-channel']);
  expect(screen.getByTestId('monitor-editor-escalation-policy')).toHaveValue('partner-policy');
  expect(screen.getByTestId('monitor-editor-name')).toHaveValue('Draft name');
  expect(fetchMock.mock.calls.filter(([url]) => url === '/monitor-definitions/m1')).toHaveLength(1);
});
```

Add `act` to this test file's existing Testing Library import. Keep the Task 10 hook’s stale-org and failure/retry tests as prerequisites; neither a pending read nor a failed read clears form IDs.

- [ ] **Step 2: Run, expect FAIL**

```bash
(cd apps/web && npx vitest run src/components/alerts/delivery/DeliveryPreview.test.tsx src/components/monitoring/MonitorEditor.test.tsx)
```
Expected: missing `./DeliveryPreview` module and `Unable to find an element by: [data-testid="delivery-preview-result"]` in the editor regression.

- [ ] **Step 3: Implement the reusable preview and connect both homes**

`DeliveryPreview.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import type { AlertSeverity, MonitorKind } from '@breeze/shared';

type Answer = {
  source: 'monitor_none' | 'monitor_channels' | 'legacy_override' | 'routing_rule' | 'default_row' | 'none';
  channelIds: string[]; skippedChannelIds: Array<{ id: string; reason: 'disabled' | 'unavailable' }>; escalationPolicyId: string | null; routingRuleName?: string;
  description: { channels: Array<{ id: string; name: string; enabled: boolean }>;
    escalationPolicy: { id: string; name: string } | null; owner: 'partner' | 'organization' | null };
};
export default function DeliveryPreview({ orgId, severity, kind, siteId, monitorId, escalationOverride }: {
  orgId: string | null; severity: AlertSeverity; kind?: MonitorKind; siteId?: string; monitorId?: string;
  escalationOverride?: { id: string; name: string } | null;
}) {
  const { t, i18n } = useTranslation('monitoring');
  const [attempt, retry] = useState(0);
  const query = new URLSearchParams({ orgId: orgId ?? '', severity });
  if (kind) query.set('kind', kind);
  if (siteId) query.set('siteId', siteId);
  if (monitorId) query.set('monitorId', monitorId);
  const key = query.toString();
  const [state, setState] = useState<{ key: string; answer?: Answer; error?: boolean }>({ key: '' });
  useEffect(() => {
    if (!orgId) return;
    let active = true;
    setState({ key });
    void fetchWithAuth(`/alerts/delivery/resolve?${key}`)
      .then(async response => {
        if (response.status === 401) { void navigateTo('/login', { replace: true }); return; }
        if (!response.ok) throw new Error('Delivery preview failed');
        const answer = await response.json() as Answer;
        if (!answer.description || !Array.isArray(answer.channelIds)) throw new Error('Invalid delivery preview');
        if (active) setState({ key, answer });
      })
      .catch(() => { if (active) setState({ key, error: true }); });
    return () => { active = false; };
  }, [orgId, key, attempt]);
  if (!orgId) return <p className="text-sm text-muted-foreground">{t('editor.deliveryPreview.selectOrg')}</p>;
  if (state.key === key && state.error) return <div role="alert" className="text-sm text-destructive">
    {t('editor.deliveryPreview.failed')} <button type="button" onClick={() => retry(n => n + 1)}>{t('common:actions.retry')}</button>
  </div>;
  const answer = state.key === key ? state.answer : undefined;
  if (!answer) return <p role="status" className="text-sm text-muted-foreground">{t('editor.deliveryPreview.loading')}</p>;
  const channelNames = answer.channelIds.map(id => {
    const channel = answer.description.channels.find(c => c.id === id);
    return channel ? (channel.enabled ? channel.name : t('editor.deliveryPreview.disabled', { name: channel.name })) : t('editor.deliveryPreview.unavailable');
  });
  const channels = channelNames.length ? new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' }).format(channelNames) : t('editor.deliveryModes.none');
  const sourceKey = answer.source === 'routing_rule'
    ? (answer.description.owner === 'partner' ? 'partnerRule' : 'orgRule')
    : answer.source === 'default_row'
      ? (answer.description.owner === 'partner' ? 'partnerDefault' : 'orgDefault')
      : answer.source === 'none' ? 'noRow' : 'monitorOverride';
  const escalation = escalationOverride ?? answer.description.escalationPolicy;
  return <div className="space-y-1 rounded-md border bg-muted/20 p-3 text-sm" data-testid="delivery-preview-result" aria-live="polite">
    <p>{t('editor.deliveryPreview.destination', { severity: t(/* i18n-dynamic */ `severities.${severity}`), channels })}</p>
    <p className="text-muted-foreground">{t(/* i18n-dynamic */ `editor.deliveryPreview.${sourceKey}`, { name: answer.routingRuleName ?? '' })}</p>
    {escalation && <p>{t('editor.deliveryPreview.escalation', { name: escalation.name })}</p>}
    <ul data-testid="delivery-preview-skipped">{answer.skippedChannelIds.map(channel => <li key={channel.id}>
      {t('editor.deliveryPreview.skipped', { id: channel.id,
        reason: t(/* i18n-dynamic */ `editor.deliveryPreview.skipReasons.${channel.reason}`) })}
    </li>)}</ul>
    {!siteId && <p className="text-xs text-muted-foreground">{t('editor.deliveryPreview.withoutSite')}</p>}
  </div>;
}
```

Static labels use literal keys; the finite provenance-key union carries `/* i18n-dynamic */`. `common:actions.retry` is existing at `apps/web/src/locales/en/common.json:142`.

`DeliveryRuleSetPreview.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MONITOR_KINDS, monitorKindSchema, monitorSeveritySchema, type MonitorKind } from '@breeze/shared';
import { useHashState } from '@/lib/useHashState';
import { fetchWithAuth } from '../../../stores/auth';
import { asList } from '@/lib/asList';
import DeliveryPreview from './DeliveryPreview';
const initial = 'preview/high/all/all';
function parseHash(hash: string): string | undefined {
  const [prefix, severity, kind, site, extra] = hash.split('/');
  if (prefix !== 'preview' || extra || !monitorSeveritySchema.safeParse(severity).success) return undefined;
  if (kind !== 'all' && !monitorKindSchema.safeParse(kind).success) return undefined;
  if (site !== 'all' && !/^[0-9a-f-]{36}$/i.test(site ?? '')) return undefined;
  return hash;
}
export default function DeliveryRuleSetPreview({ orgId }: { orgId: string | null }) {
  const { t } = useTranslation('monitoring');
  const [hash, setHash] = useHashState<string>(initial, parseHash);
  const [, severityValue, kindValue, siteValue] = hash.split('/');
  const severity = monitorSeveritySchema.parse(severityValue);
  const kind = kindValue === 'all' ? undefined : kindValue as MonitorKind;
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  const [sitesError, setSitesError] = useState(false);
  useEffect(() => {
    let active = true; setSites([]); setSitesError(false);
    if (orgId) void fetchWithAuth(`/orgs/sites?organizationId=${encodeURIComponent(orgId)}&limit=100`)
      .then(async response => {
        if (!response.ok) throw new Error('Sites unavailable');
        const rows = asList<{ id: string; name: string }>(await response.json(), 'sites');
        if (active) setSites(rows);
      }).catch(() => { if (active) setSitesError(true); });
    return () => { active = false; };
  }, [orgId]);
  const site = sites.some(s => s.id === siteValue) ? siteValue : undefined;
  const change = (severity: string, kind: string, site: string) => {
    const next = `preview/${severity}/${kind}/${site}`;
    setHash(next);
    window.location.hash = next;
  };
  return <section className="space-y-3" data-testid="delivery-rule-set-preview">
    <h2 className="text-lg font-semibold">{t('editor.deliveryPreview.testRules')}</h2>
    <div className="flex flex-wrap gap-3">
      <label>{t('editor.fields.severity')}<select data-testid="delivery-preview-severity" value={severity}
        onChange={e => change(e.target.value, kindValue!, siteValue!)}>
        {(['critical', 'high', 'medium', 'low', 'info'] as const).map(s => <option key={s} value={s}>{t(/* i18n-dynamic */ `severities.${s}`)}</option>)}
      </select></label>
      <label>{t('editor.deliveryPreview.kind')}<select value={kindValue} data-testid="delivery-preview-kind"
        onChange={e => change(severity, e.target.value, siteValue!)}>
        <option value="all">{t('editor.deliveryPreview.noKind')}</option>
        {MONITOR_KINDS.map(k => <option key={k} value={k}>{t(/* i18n-dynamic */ `kinds.${k}`)}</option>)}
      </select></label>
      <label>{t('editor.deliveryPreview.site')}<select value={site ?? 'all'} data-testid="delivery-preview-site"
        onChange={e => change(severity, kindValue!, e.target.value)}>
        <option value="all">{t('editor.deliveryPreview.noSite')}</option>
        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label>
    </div>
    {sitesError && <p role="alert">{t('editor.deliveryPreview.sitesFailed')}</p>}
    <DeliveryPreview orgId={orgId} severity={severity} kind={kind} siteId={site} />
  </section>;
}
```

`MonitorEditor.tsx`: replace the old `notificationChannels`/`escalationPolicies` state and both `fetchChannels`/`fetchEscalationPolicies` callbacks with Task 10's independent rails hook. Remove those callbacks from the initialization effect and its dependency list; keep `fetchMonitor` and the other loaders there. Rail URL changes must never trigger `fetchMonitor`/`reset`.

Add this import, watch, and choice loading immediately after `ownerOrgId` and before the existing `compatibleEscalationPolicies` memo:

```tsx
import { useDeliveryResource } from '../alerts/delivery/useDeliveryResource';
import type { EscalationPolicy } from '../alerts/delivery/deliveryActions';
import { useJwtClaims } from '../../lib/authScope';
// Remove MonitorEditor’s local EscalationPolicy alias; use the DTO union.
const jwt = useJwtClaims();
const currentPartnerId = jwt.status === 'resolved' ? jwt.claims.partnerId : null;
// Alongside the other watch calls:
const watchDeliveryChannelIds = watch('deliveryChannelIds');

// After ownerOrgId: saved org monitors use their persisted org, new monitors
// use the selected org, and partner monitors use that org's inherited rails.
const deliveryChoiceOrgId = ownerOrgId ?? currentOrgId;
const deliveryChoiceSuffix = deliveryChoiceOrgId ? `&orgId=${encodeURIComponent(deliveryChoiceOrgId)}` : '';
const channelRail = useDeliveryResource<NotificationChannel>(`/alerts/delivery/rails?rail=channels${deliveryChoiceSuffix}`);
const escalationRail = useDeliveryResource<EscalationPolicy>(`/alerts/delivery/rails?rail=escalation${deliveryChoiceSuffix}`);
const notificationChannels = useMemo(() => [...new Map([
  ...channelRail.data.map(({ id, name, type }) => ({ id, name, type })),
  ...channelRail.inherited,
].map(channel => [channel.id, channel] as const)).values()], [channelRail.data, channelRail.inherited]);
const escalationPolicies = escalationRail.data;
```

`NotificationChannel` from `components/automations/ActionsEditor.tsx:15` already is `{ id; name; type }`, so no synthetic config fields are needed. Replace the policy ownership memo as follows; inherited DTOs are already pinned by the rails service to the selected org’s partner. A saved partner monitor must belong to the active partner before those choices can be used. Keep new-monitor owner-change validation and the saved-choice preservation tests.

```tsx
const compatibleEscalationPolicies = useMemo(() => escalationPolicies.filter(policy => {
  if (policy.inherited === true) {
    return !isPartnerOwned || isNew || monitorPartnerId === currentPartnerId;
  }
  if (policy.orgId === null && policy.partnerId !== null) {
    return !isPartnerOwned || isNew || policy.partnerId === monitorPartnerId;
  }
  return !isPartnerOwned && policy.orgId === ownerOrgId;
}), [escalationPolicies, isPartnerOwned, isNew, monitorPartnerId, currentPartnerId, ownerOrgId]);
```
 Do not intersect saved form IDs with a loading or failed result. On the existing channel multi-select add `value={watchDeliveryChannelIds}` and `disabled={channelRail.status !== 'success'}` while retaining `register('deliveryChannelIds')`; the controlled value restores saved selections when options arrive. The policy select below likewise uses the watched value. Use the merged safe choices for the existing action editors as well.

Render independent read states inside Notify before the pickers, using Task 11's existing translated keys (no additional locale files):

```tsx
{[channelRail, escalationRail].map((rail, index) => rail.status === 'error'
  ? <div key={index} role="alert">{t('alerts:deliveryPage.loadFailed')}
      <button type="button" onClick={rail.reload}>{t('common:actions.retry')}</button></div>
  : rail.status === 'loading' ? <p key={index} role="status">{t('alerts:deliveryPage.loading')}</p> : null)}
```

Additional imports/watch and exact JSX insertion at the end of Notify, before its closing `</section>`:

```tsx
import DeliveryPreview from '../alerts/delivery/DeliveryPreview';
// Alongside the other watch calls:
const watchSeverity = watch('severity');

// JSX inside Notify:
{watchDeliveryMode === 'inherit' && (
  <DeliveryPreview
    orgId={monitorOrgId ?? currentOrgId}
    severity={watchSeverity}
    kind={watchKind}
    escalationOverride={compatibleEscalationPolicies.find(p => p.id === watchEscalationPolicyId) ?? null}
  />
)}
{watchDeliveryMode !== 'none' && (
  <div className="space-y-2">
    <label htmlFor="monitor-editor-escalation-policy" className="text-xs font-medium text-muted-foreground">
      {t('monitoring:editor.fields.escalationPolicy')}
    </label>
    <select id="monitor-editor-escalation-policy" data-testid="monitor-editor-escalation-policy"
      className="h-9 w-full rounded-md border bg-background px-3 text-sm" {...register('escalationPolicyId')}
      value={watchEscalationPolicyId ?? ''} disabled={escalationRail.status !== 'success'}>
      <option value="">{t('monitoring:editor.deliveryModes.inherit')}</option>
      {compatibleEscalationPolicies.map(policy => <option key={policy.id} value={policy.id}>{policy.name}</option>)}
    </select>
  </div>
)}
<a href="/alerts/delivery" data-testid="monitor-editor-delivery-home" className="text-sm text-primary underline">
  {t('monitoring:editor.deliveryPreview.manage')}
</a>
```

Delete the old policy selector block at `MonitorEditor.tsx:871-888` when moving it; leave recurrence threshold/window/actions and their `runAction` submission unchanged. `DeliveryPage.tsx` imports and renders the rule-set preview after `RoutingSection`:

```tsx
import DeliveryRuleSetPreview from './delivery/DeliveryRuleSetPreview';
// Immediately after <RoutingSection ... />:
<DeliveryRuleSetPreview orgId={currentOrgId} />
```

- [ ] **Step 4: Add real translations in every locale**

Run this implementation-time script from the repository root. It merges only `editor.deliveryPreview`; it does not replace the existing locale object. All rows have the same 22 keys, in the `keys` order.

```python
import json
from pathlib import Path
keys = ['selectOrg','failed','loading','disabled','unavailable','destination','partnerRule','orgRule','partnerDefault','orgDefault','noRow','monitorOverride','escalation','withoutSite','testRules','kind','noKind','site','noSite','sitesFailed','manage','draft']
translations = {
'en': ['Select an organization to preview delivery.','Could not preview delivery.','Resolving delivery…','{{name}} (disabled)','Unavailable channel','{{severity}} → {{channels}}','Partner rule: {{name}}','Organization rule: {{name}}','Partner default: {{name}}','Organization default: {{name}}','No delivery row is configured.','Monitor override','Escalates via {{name}}','No site selected; site-specific routing rows are excluded.','Test this rule set','Monitor kind','No monitor kind','Site','No site','Could not load sites.','Manage delivery','Preview uses the current editor values.'],
'de-DE': ['Wählen Sie eine Organisation für die Zustellungsvorschau.','Zustellungsvorschau fehlgeschlagen.','Zustellung wird ermittelt…','{{name}} (deaktiviert)','Kanal nicht verfügbar','Zustellung bei {{severity}}: {{channels}}','Partnerregel: {{name}}','Organisationsregel: {{name}}','Partnerstandard: {{name}}','Organisationsstandard: {{name}}','Keine Zustellungszeile konfiguriert.','Monitorüberschreibung','Eskaliert über {{name}}','Kein Standort ausgewählt; standortspezifische Regeln werden ausgeschlossen.','Diesen Regelsatz testen','Monitorart','Keine Monitorart','Standort','Kein Standort','Standorte konnten nicht geladen werden.','Zustellung verwalten','Die Vorschau verwendet die aktuellen Editorwerte.'],
'es-419': ['Selecciona una organización para ver la entrega.','No se pudo obtener la vista previa.','Resolviendo la entrega…','{{name}} (deshabilitado)','Canal no disponible','Entrega para {{severity}}: {{channels}}','Regla del partner: {{name}}','Regla de la organización: {{name}}','Valor predeterminado del partner: {{name}}','Valor predeterminado de la organización: {{name}}','No hay ninguna fila de entrega configurada.','Configuración propia del monitor','Escala mediante {{name}}','Sin sitio seleccionado; se excluyen las reglas específicas de sitio.','Probar este conjunto de reglas','Tipo de monitor','Sin tipo de monitor','Sitio','Sin sitio','No se pudieron cargar los sitios.','Administrar la entrega','La vista previa usa los valores actuales del editor.'],
'fr-FR': ["Sélectionnez une organisation pour prévisualiser la livraison.","Impossible de prévisualiser la livraison.","Résolution de la livraison…","{{name}} (désactivé)","Canal indisponible","Livraison pour {{severity}} : {{channels}}","Règle du partenaire : {{name}}","Règle de l’organisation : {{name}}","Valeur par défaut du partenaire : {{name}}","Valeur par défaut de l’organisation : {{name}}","Aucune ligne de livraison n’est configurée.","Réglage propre au moniteur","Escalade via {{name}}","Aucun site sélectionné ; les règles propres à un site sont exclues.","Tester cet ensemble de règles","Type de moniteur","Aucun type de moniteur",'Site concerné',"Aucun site","Impossible de charger les sites.","Gérer la livraison","L’aperçu utilise les valeurs actuelles de l’éditeur."],
'fr-CA': ["Sélectionnez une organisation pour prévisualiser la livraison.","Impossible de prévisualiser la livraison.","Résolution de la livraison…","{{name}} (désactivé)","Canal indisponible","Livraison pour {{severity}} : {{channels}}","Règle du partenaire : {{name}}","Règle de l’organisation : {{name}}","Valeur par défaut du partenaire : {{name}}","Valeur par défaut de l’organisation : {{name}}","Aucune ligne de livraison n’est configurée.","Réglage propre au moniteur","Escalade via {{name}}","Aucun site sélectionné ; les règles propres à un site sont exclues.","Tester cet ensemble de règles","Type de moniteur","Aucun type de moniteur",'Site concerné',"Aucun site","Impossible de charger les sites.","Gérer la livraison","L’aperçu utilise les valeurs actuelles de l’éditeur."],
'it-IT': ['Seleziona un’organizzazione per visualizzare la consegna.','Impossibile visualizzare l’anteprima.','Risoluzione della consegna…','{{name}} (disabilitato)','Canale non disponibile','Consegna per {{severity}}: {{channels}}','Regola del partner: {{name}}','Regola dell’organizzazione: {{name}}','Impostazione predefinita del partner: {{name}}','Impostazione predefinita dell’organizzazione: {{name}}','Nessuna riga di consegna configurata.','Impostazione propria del monitor','Escalation tramite {{name}}','Nessuna sede selezionata; le regole specifiche della sede sono escluse.','Prova questo insieme di regole','Tipo di monitor','Nessun tipo di monitor','Sede','Nessuna sede','Impossibile caricare le sedi.','Gestisci la consegna','L’anteprima usa i valori attuali dell’editor.'],
'pt-BR': ['Selecione uma organização para visualizar a entrega.','Não foi possível visualizar a entrega.','Resolvendo a entrega…','{{name}} (desativado)','Canal indisponível','Entrega para {{severity}}: {{channels}}','Regra do parceiro: {{name}}','Regra da organização: {{name}}','Padrão do parceiro: {{name}}','Padrão da organização: {{name}}','Nenhuma linha de entrega configurada.','Configuração própria do monitor','Escalona via {{name}}','Nenhum local selecionado; regras específicas de local são excluídas.','Testar este conjunto de regras','Tipo de monitor','Sem tipo de monitor','Local','Sem local','Não foi possível carregar os locais.','Gerenciar entrega','A prévia usa os valores atuais do editor.'],
 'tr-TR': ['Teslimatı önizlemek için bir kuruluş seçin.','Teslimat önizlenemedi.','Teslimat çözümleniyor…','{{name}} (devre dışı)','Kanal kullanılamıyor','{{severity}} için teslimat: {{channels}}','İş ortağı kuralı: {{name}}','Kuruluş kuralı: {{name}}','İş ortağı varsayılanı: {{name}}','Kuruluş varsayılanı: {{name}}','Teslimat satırı yapılandırılmamış.','Monitöre özel ayar','{{name}} üzerinden yükseltilir','Site seçilmedi; siteye özel kurallar uygulanmaz.','Bu kural kümesini test et','Monitör türü','Monitör türü yok','Konum','Site yok','Siteler yüklenemedi.','Teslimatı yönet','Önizleme düzenleyicideki güncel değerleri kullanır.'],
}
skip_labels = {
'en': ['Skipped {{id}}: {{reason}}', 'disabled', 'unavailable'],
'de-DE': ['Übersprungen {{id}}: {{reason}}', 'deaktiviert', 'nicht verfügbar'],
'es-419': ['Omitido {{id}}: {{reason}}', 'deshabilitado', 'no disponible'],
'fr-FR': ['Ignoré {{id}} : {{reason}}', 'désactivé', 'indisponible'],
'fr-CA': ['Ignoré {{id}} : {{reason}}', 'désactivé', 'indisponible'],
'it-IT': ['Ignorato {{id}}: {{reason}}', 'disabilitato', 'non disponibile'],
'pt-BR': ['Ignorado {{id}}: {{reason}}', 'desativado', 'indisponível'],
 'tr-TR': ['Atlandı {{id}}: {{reason}}', 'devre dışı', 'kullanılamıyor'],
}
root = Path('apps/web/src/locales')
assert {p.name for p in root.iterdir() if p.is_dir()} == set(translations)
for locale, values in translations.items():
    assert len(values) == len(keys), locale
    path = root / locale / 'monitoring.json'
    data = json.loads(path.read_text())
    data['editor']['deliveryPreview'] = dict(zip(keys, values))
    skipped, disabled, unavailable = skip_labels[locale]
    data['editor']['deliveryPreview'].update(skipped=skipped, skipReasons=dict(disabled=disabled, unavailable=unavailable))
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
```

Render the `draft` key immediately above the editor preview (not on the Delivery test panel):

```tsx
{watchDeliveryMode === 'inherit' && <p className="text-xs text-muted-foreground">{t('monitoring:editor.deliveryPreview.draft')}</p>}
```

- [ ] **Step 5: Run, expect PASS**

```bash
(cd apps/web && npx vitest run src/components/alerts/delivery/DeliveryPreview.test.tsx src/components/monitoring/MonitorEditor.test.tsx src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/no-translated-comparisons.test.ts)
(cd apps/web && npx tsc --noEmit -p .)
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/monitoring/MonitorEditor.tsx apps/web/src/components/monitoring/MonitorEditor.test.tsx apps/web/src/components/alerts/DeliveryPage.tsx apps/web/src/components/alerts/delivery/DeliveryPreview.tsx apps/web/src/components/alerts/delivery/DeliveryPreview.test.tsx apps/web/src/components/alerts/delivery/DeliveryRuleSetPreview.tsx apps/web/src/locales/*/monitoring.json
git commit -m "feat(web): show resolved Notify inheritance and preview delivery rules (W05b)"
```

---

### Task 15: Register `manage_delivery` across chat, MCP, guardrails, and the agent catalog

**Files:**
- Create: `apps/api/src/services/aiToolsDelivery.ts`, `aiToolsDelivery.test.ts`
- Modify: `apps/api/src/services/aiTools.ts:68,318`, `aiToolSchemas.ts:100,1580`, `aiGuardrails.ts:142,1263,1613`, `aiAgents/agentToolCatalog.ts:84`, `aiAgentSystemPrompt.ts:108`
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:163,279,2507` (mandatory SDK registration surface)
- Modify: `apps/api/src/routes/alerts/routing.ts:24-48,97-117` (export schemas and `getRoutingRuleWithAccess`; site helper exports already ship in Task 8/PR 1)
- Extend: `apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts:12-28,88`, `aiAgents/agentToolCatalog.contract.test.ts:48-54`
- Verify unchanged: `apps/api/src/services/aiAgents/__snapshots__/agentToolCatalog.contract.test.ts.snap:50`; run `aiAgentSdkTools.mcpCoverage.test.ts:16-38` without updating snapshots
- Consume: `apps/api/src/services/aiToolsConfigPolicy.ts:51-76`, `middleware/auth.ts:915-918`, `services/aiGuardrails.ts:1808-1815`, `routes/alerts/helpers.ts:435-447` (verified constraints on MFA, agent principals, tiers, and legacy binding validation).

**Interfaces:**
- Produces: `registerDeliveryTools(registry: Map<string, AiTool>): void`; tool name exactly **`manage_delivery`**; `deliveryToolShape`, `deliveryToolSchema` in `aiToolSchemas.ts`.
- Resolve output is exactly `DeliveryPreview`: eligible `channelIds`, `skippedChannelIds: Array<{ id: string; reason: 'disabled' | 'unavailable' }>`, escalation, provenance and safe description. Unavailable never distinguishes a foreign ID from a nonexistent ID; no channel configuration or escalation step targets are returned. Inherited list results must use Task 8’s service DTO projections too.
- Actions: `resolve | list_routing | create_routing | update_routing | delete_routing | set_default | list_escalation | create_escalation | update_escalation | delete_escalation`. Top-level ownership (`orgId`, `ownerScope`) is create/list/default-only; `id` chooses update/delete targets and their immutable owner; `data` contains rule/policy fields. Resolve requires `orgId` and `severity`, with optional `kind`, `siteId`, `monitorId`.
- Consumes: Task 13's **`previewDelivery` from `./delivery/describeDelivery`**, Task 3's `upsertDefaultRow`, `assertDefaultRowPatch`, `escalationPolicyCompatible`, `DeliveryWriteError`; Task 5's policy schemas; Task 8's `routingSiteIds` and `canAccessRoutingSites` exports. No alternate delivery resolver and no HTTP bridge: HTTP `requireScope` refuses `ai_agent` principals.
- Read actions: tier 1, `alerts:read`; writes: tier 2, `alerts:write`, existing mutation guardrails and audit path. Tier 2 does **not** mean approval-required in this repository (`aiGuardrails.ts:1808-1815`); do not falsely promise a confirmation dialog. Human writes additionally require MFA; authenticated agent writes use the existing agent guardrails instead. All writes reject site/device ceilings and enforce partner-wide capability.
- `manage_notification_channels` retains channel CRUD/test. Routing, defaults, escalation CRUD, and resolution have one AI home: `manage_delivery`. Do not copy those actions into the channel tool. The old tool's frozen missing-tier entry and unreachable snapshot entry remain unchanged; `manage_delivery` must be present on every surface from its first commit.
- Default deletion is already rejected on both axes by Task 3 and absent from Task 11's UI; keep the AI refusal identical.

- [ ] **Step 1: Write failing handler and registry tests**

`aiToolsDelivery.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } }));
vi.mock('../middleware/auth', async original => ({ ...await original<typeof import('../middleware/auth')>(), hasSatisfiedMfa: vi.fn(() => true) }));
vi.mock('../routes/alerts/routing', async original => ({ ...await original<typeof import('../routes/alerts/routing')>(), getRoutingRuleWithAccess: vi.fn(), canAccessRoutingSites: vi.fn(async () => true) }));
vi.mock('../routes/alerts/helpers', async original => ({ ...await original<typeof import('../routes/alerts/helpers')>(), getEscalationPolicyWithOrgCheck: vi.fn() }));
vi.mock('./delivery/describeDelivery', () => ({ previewDelivery: vi.fn() }));
vi.mock('./delivery/inheritedRails', () => ({ readInheritedRails: vi.fn(async () => []) }));
vi.mock('./delivery/railOwnership', async original => ({ ...await original<typeof import('./delivery/railOwnership')>(), partnerIdForOrg: vi.fn(async () => null) }));
vi.mock('./delivery/routingRuleWrites', async original => ({ ...await original<typeof import('./delivery/routingRuleWrites')>(), upsertDefaultRow: vi.fn(), escalationPolicyCompatible: vi.fn(async () => true) }));
import { db } from '../db';
import { hasSatisfiedMfa, type AuthContext } from '../middleware/auth';
import { getRoutingRuleWithAccess } from '../routes/alerts/routing';
import { getEscalationPolicyWithOrgCheck } from '../routes/alerts/helpers';
import { previewDelivery } from './delivery/describeDelivery';
import { readInheritedRails } from './delivery/inheritedRails';
import { validateEscalationUsers } from './delivery/escalationExecution';
import { upsertDefaultRow, escalationPolicyCompatible } from './delivery/routingRuleWrites';
import { registerDeliveryTools } from './aiToolsDelivery';
import type { AiTool } from './aiTools';
const ORG = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002';
const ID = '20000000-0000-4000-8000-000000000001', CH = '30000000-0000-4000-8000-000000000001';
const auth = (patch: Partial<AuthContext> = {}) => ({ principal: { kind: 'user_session' }, scope: 'organization',
  orgId: ORG, partnerId: null, accessibleOrgIds: [ORG], token: { mfa: true }, canAccessOrg: (id: string) => id === ORG, ...patch }) as AuthContext;
const registry = new Map<string, AiTool>(); registerDeliveryTools(registry);
const call = async (input: Record<string, unknown>, identity = auth()) => JSON.parse(await registry.get('manage_delivery')!.handler(input, identity));
const row = { id: ID, orgId: ORG, partnerId: null, name: 'Everything else', isDefault: true, conditions: {}, channelIds: [], escalationPolicyId: null };
function channels(ids: string[]) { vi.mocked(db.select).mockReturnValue({ from: () => ({ where: async () => ids.map(id => ({ id })) }) } as never); }
function insertReturning(value: unknown) {
  const values = vi.fn(() => ({ returning: async () => [value] }));
  vi.mocked(db.insert).mockReturnValue({ values } as never); return values;
}
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(hasSatisfiedMfa).mockReturnValue(true);
  vi.mocked(escalationPolicyCompatible).mockResolvedValue(true);
  vi.mocked(readInheritedRails).mockResolvedValue([]);
  vi.mocked(getRoutingRuleWithAccess).mockResolvedValue(row as never);
  vi.mocked(upsertDefaultRow).mockResolvedValue(row as never);
});
describe('manage_delivery', () => {
  it('returns the authorized shared preview unchanged', async () => {
    const result = { channelIds: [CH], skippedChannelIds: [{ id: ID, reason: 'unavailable' }, { id: OTHER, reason: 'disabled' }],
      escalationPolicyId: null, source: 'default_row', display: 'On-call',
      description: { channels: [{ id: CH, name: 'On-call', enabled: true }], escalationPolicy: null, owner: 'org' } };
    vi.mocked(previewDelivery).mockResolvedValue(result as never);
    expect(await call({ action: 'resolve', orgId: ORG, severity: 'high' })).toEqual(result);
    expect(previewDelivery).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, severity: 'high' }), expect.objectContaining({ orgId: ORG }));
  });
  it.each(['create_routing','update_routing','delete_routing','set_default','create_escalation','update_escalation','delete_escalation'])('%s rejects site/device ceilings', async action => {
    for (const ceiling of [{ allowedSiteIds: [] }, { allowedDeviceIds: [] }]) {
      expect(await call({ action, id: ID, data: {} }, auth(ceiling))).toMatchObject({ status: 403 });
    }
    expect(db.insert).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled(); expect(db.delete).not.toHaveBeenCalled();
  });
  it('requires human MFA', async () => {
    vi.mocked(hasSatisfiedMfa).mockReturnValue(false);
    expect(await call({ action: 'set_default', data: { channelIds: [] } })).toMatchObject({ status: 403, error: 'MFA required' });
    expect(upsertDefaultRow).not.toHaveBeenCalled();
  });
  it('rejects invalid shape and inaccessible ownership', async () => {
    for (const input of [{ action: 'set_default' }, { action: 'resolve', severity: 'high' }, { action: 'other' }, { action: 'delete_routing', id: 'bad' }]) {
      expect(await call(input)).toMatchObject({ status: 400 });
    }
    expect(await call({ action: 'set_default', orgId: OTHER, data: { channelIds: [] } })).toMatchObject({ status: 403 });
    expect(await call({ action: 'set_default', ownerScope: 'partner', data: { channelIds: [] } },
      auth({ scope: 'partner', partnerId: OTHER, partnerOrgAccess: 'selected' }))).toMatchObject({ status: 403 });
  });
  it('writes an inbox-only default through the shared writer', async () => {
    expect(await call({ action: 'set_default', data: { channelIds: [] } })).toEqual({ data: row });
    expect(upsertDefaultRow).toHaveBeenCalledWith({ orgId: ORG, partnerId: null }, { channelIds: [], escalationPolicyId: null }, expect.anything());
  });
  it('rejects foreign channels, foreign escalation, default rename, and deletion on either axis', async () => {
    channels([]);
    expect(await call({ action: 'set_default', data: { channelIds: [CH] } })).toMatchObject({ status: 400 });
    vi.mocked(escalationPolicyCompatible).mockResolvedValue(false);
    expect(await call({ action: 'set_default', data: { channelIds: [], escalationPolicyId: ID } })).toMatchObject({ status: 400 });
    expect(await call({ action: 'update_routing', id: ID, data: { name: 'changed' } })).toMatchObject({ status: 400 });
    expect(await call({ action: 'delete_routing', id: ID })).toMatchObject({ status: 409 });
    vi.mocked(getRoutingRuleWithAccess).mockResolvedValue({ ...row, orgId: null, partnerId: OTHER } as never);
    expect(await call({ action: 'delete_routing', id: ID }, auth({ scope: 'partner', partnerId: OTHER, partnerOrgAccess: 'all' }))).toMatchObject({ status: 409 });
  });
  it('creates routing and escalation rows with the selected owner', async () => {
    channels([CH]); const values = insertReturning(row);
    expect(await call({ action: 'create_routing', data: { name: 'High', priority: 1, conditions: { severities: ['high'] }, channelIds: [CH] } })).toEqual({ data: row });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, partnerId: null, isDefault: false }));
    expect(await call({ action: 'create_escalation', data: { name: 'On-call', steps: [{ delayMinutes: 15, channelIds: [CH] }] } })).toEqual({ data: row });
  });
  it('lists bounded routing and policy rows', async () => {
    const limit = vi.fn(async () => [row]);
    vi.mocked(db.select).mockReturnValue({ from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }) } as never);
    expect(await call({ action: 'list_routing' })).toEqual({ data: [row] });
    expect(await call({ action: 'list_escalation' })).toEqual({ data: [row] });
    expect(limit).toHaveBeenCalledWith(100);
  });
  it('returns inherited list DTOs unchanged, without policy targets or owner metadata', async () => {
    const { partnerIdForOrg } = await import('./delivery/railOwnership');
    vi.mocked(partnerIdForOrg).mockResolvedValueOnce(OTHER).mockResolvedValueOnce(OTHER);
    const limit = vi.fn(async () => []);
    vi.mocked(db.select).mockReturnValue({ from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }) } as never);
    const inheritedRule = { id: ID, name: 'Partner route', priority: 10, enabled: true, isDefault: false,
      conditions: { severities: [], monitorKinds: [], siteIds: [] }, channelIds: [CH], escalationPolicyId: null, inherited: true as const };
    const inheritedPolicy = { id: ID, name: 'On-call', stepCount: 2, inherited: true as const };
    vi.mocked(readInheritedRails).mockResolvedValueOnce([inheritedRule]).mockResolvedValueOnce([inheritedPolicy]);
    expect(await call({ action: 'list_routing' })).toEqual({ data: [inheritedRule] });
    expect(await call({ action: 'list_escalation' })).toEqual({ data: [inheritedPolicy] });
    expect(readInheritedRails).toHaveBeenCalledWith('escalation',
      { orgId: ORG, partnerId: OTHER, allowedSiteIds: undefined }, db);
  });
  it('updates and deletes normal routing rows and escalation policies', async () => {
    vi.mocked(getRoutingRuleWithAccess).mockResolvedValue({ ...row, isDefault: false } as never);
    vi.mocked(getEscalationPolicyWithOrgCheck).mockResolvedValue({ ...row, steps: [] } as never);
    vi.mocked(db.update).mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{ id: ID }] }) }) } as never);
    vi.mocked(db.delete).mockReturnValue({ where: () => ({ returning: async () => [{ id: ID }] }) } as never);
    channels([CH]);
    expect(await call({ action: 'update_routing', id: ID, data: { name: 'Changed' } })).toEqual({ data: { id: ID } });
    expect(await call({ action: 'delete_routing', id: ID })).toEqual({ data: { id: ID, deleted: true } });
    expect(await call({ action: 'update_escalation', id: ID, data: { steps: [{ delayMinutes: 20, channelIds: [CH] }] } })).toEqual({ data: { id: ID } });
    expect(await call({ action: 'delete_escalation', id: ID })).toEqual({ data: { id: ID, deleted: true } });
  });
  it('rejects inert filters, bad delays, not-found rows, and reports safe runtime failures', async () => {
    expect(await call({ action: 'create_routing', data: { name: 'x', priority: 1, conditions: { deviceTags: ['x'] }, channelIds: [CH] } })).toMatchObject({ status: 400 });
    expect(await call({ action: 'create_escalation', data: { name: 'x', steps: [{ delayMinutes: 0, channelIds: [CH] }] } })).toMatchObject({ status: 400 });
    vi.mocked(getRoutingRuleWithAccess).mockResolvedValue(null);
    expect(await call({ action: 'delete_routing', id: ID })).toMatchObject({ status: 404 });
    vi.mocked(upsertDefaultRow).mockRejectedValue(new Error('private database text'));
    expect(await call({ action: 'set_default', data: { channelIds: [] } })).toEqual({ error: 'Delivery operation failed' });
  });
});
```

Append to `aiAgentSdkTools.registryParity.contract.test.ts`; add imports of `checkGuardrails`, `requiredPermissionsForTool` from `./aiGuardrails` and `validateToolInput` from `./aiToolSchemas`:

```ts
describe('manage_delivery has every registration', () => {
  it('does not add a frozen-gap exception', () => {
    expect(getAllRegisteredToolNames()).toContain('manage_delivery');
    expect(TOOL_TIERS.manage_delivery).toBe(1);
    expect(KNOWN_MISSING_TOOL_TIERS.has('manage_delivery')).toBe(false);
  });
  it.each(['resolve', 'list_routing', 'list_escalation'])('%s is read-only', action => {
    expect(checkGuardrails('manage_delivery', { action }).tier).toBe(1);
    expect(requiredPermissionsForTool('manage_delivery', { action })).toEqual([{ resource: 'alerts', action: 'read' }]);
  });
  it.each(['create_routing','update_routing','delete_routing','set_default','create_escalation','update_escalation','delete_escalation'])('%s uses mutation tier and write permission', action => {
    expect(checkGuardrails('manage_delivery', { action })).toMatchObject({ tier: 2, requiresApproval: false });
    expect(requiredPermissionsForTool('manage_delivery', { action })).toEqual([{ resource: 'alerts', action: 'write' }]);
  });
  it('fails closed on unknown actions', () => {
    expect(requiredPermissionsForTool('manage_delivery', { action: 'unknown' })).toBeNull();
    expect(validateToolInput('manage_delivery', { action: 'unknown' }).success).toBe(false);
  });
});
```

Append to `aiAgents/agentToolCatalog.contract.test.ts` (all imports already present):

```ts
it('makes delivery reachable without changing prior frozen gaps', () => {
  expect(TOOL_CAPABILITY.manage_delivery).toBe('alerts_monitoring');
  expect(listAgentReachableTools()).toContain('manage_delivery');
  expect(listUnreachableRegisteredTools()).not.toContain('manage_delivery');
  expect(listUnreachableRegisteredTools()).toContain('manage_notification_channels');
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
(cd apps/api && npx vitest run src/services/aiToolsDelivery.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts)
```
Expected: missing `./aiToolsDelivery`, then `expected ... to include 'manage_delivery'` until registration is complete.

- [ ] **Step 3: Implement schema, handler, and default-row protection**

In `aiToolSchemas.ts`, above `toolInputSchemas` (reuse its existing `z`, `uuid`, `monitorKindSchema` imports/constants):

```ts
export const deliveryToolShape = {
  action: z.enum(['resolve','list_routing','create_routing','update_routing','delete_routing','set_default','list_escalation','create_escalation','update_escalation','delete_escalation']),
  orgId: uuid.optional(), ownerScope: z.enum(['organization', 'partner']).optional(), id: uuid.optional(),
  severity: z.enum(['critical','high','medium','low','info']).optional(), kind: monitorKindSchema.optional(),
  siteId: uuid.optional(), monitorId: uuid.optional(), data: z.record(z.string(), z.unknown()).optional(),
};
export const deliveryToolSchema = z.object(deliveryToolShape).strict().superRefine((v, ctx) => {
  if (v.action === 'resolve' && (!v.severity || !v.orgId)) ctx.addIssue({ code: 'custom', message: 'orgId and severity are required for resolve' });
  if (/^(update|delete)_/.test(v.action) && !v.id) ctx.addIssue({ code: 'custom', path: ['id'], message: 'id is required for update/delete' });
  if ((/^(create|update)_/.test(v.action) || v.action === 'set_default') && !v.data) ctx.addIssue({ code: 'custom', path: ['data'], message: 'data is required for writes' });
});
// Add inside toolInputSchemas:
// manage_delivery: deliveryToolSchema,
```

Export the following existing declarations in `routes/alerts/routing.ts` (bodies unchanged from Task 3/current code): `createRoutingRuleSchema`, `updateRoutingRuleSchema`, `upsertDefaultRowSchema`, `getRoutingRuleWithAccess`. The concrete edit is adding `export` before each `const` or `async function` declaration. Consume `routingSiteIds` and `canAccessRoutingSites` already exported in Task 8/PR 1; do not defer those exports to this task. The AI module never invokes Hono middleware.

`aiToolsDelivery.ts`:

```ts
import { z } from 'zod';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { notificationChannels, notificationRoutingRules, escalationPolicies } from '../db/schema';
import { hasSatisfiedMfa, type AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { deliveryToolSchema } from './aiToolSchemas';
import { createRoutingRuleSchema, updateRoutingRuleSchema, upsertDefaultRowSchema,
  canAccessRoutingSites, routingSiteIds, getRoutingRuleWithAccess } from '../routes/alerts/routing';
import { createPolicySchema, updatePolicySchema } from '../routes/alerts/schemas';
import { resolveWriteOrgId, getEscalationPolicyWithOrgCheck } from '../routes/alerts/helpers';
import { canManagePartnerWidePolicies, canReadPartnerWideRows, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from './siteCeilingAccess';
import { DeliveryWriteError, assertDefaultRowPatch, escalationPolicyCompatible,
  upsertDefaultRow, type RoutingOwner } from './delivery/routingRuleWrites';
import { railOwnershipCondition, partnerIdForOrg } from './delivery/railOwnership';
import { previewDelivery } from './delivery/describeDelivery';
import { readInheritedRails } from './delivery/inheritedRails';
import { validateEscalationUsers } from './delivery/escalationExecution';

const READS = new Set(['resolve', 'list_routing', 'list_escalation']);
type Input = z.infer<typeof deliveryToolSchema>;
function fail(status: 400 | 403 | 404 | 409, message: string): never { throw new DeliveryWriteError(status, message); }
function resolveOwner(input: Input, auth: AuthContext): RoutingOwner {
  if (input.ownerScope === 'partner') {
    if (!auth.partnerId || !canReadPartnerWideRows(auth, auth.partnerId)) fail(403, PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    return { orgId: null, partnerId: auth.partnerId };
  }
  const owner = resolveWriteOrgId(auth, input.orgId);
  if (owner.error || !owner.orgId) fail(owner.status ?? 400, owner.error ?? 'Organization context required');
  if (!auth.canAccessOrg(owner.orgId)) fail(403, 'Access to this organization denied');
  return { orgId: owner.orgId, partnerId: null };
}
function assertWritable(owner: RoutingOwner, auth: AuthContext): void {
  if (owner.orgId === null && !canManagePartnerWidePolicies(auth)) fail(403, PARTNER_WIDE_WRITE_DENIED_MESSAGE);
}
async function validateChannels(ids: string[], owner: RoutingOwner): Promise<void> {
  const unique = [...new Set(ids)]; if (!unique.length) return;
  const axis = owner.orgId !== null
    ? railOwnershipCondition(notificationChannels.orgId, notificationChannels.partnerId, owner.orgId, await partnerIdForOrg(owner.orgId))
    : and(isNull(notificationChannels.orgId), eq(notificationChannels.partnerId, owner.partnerId!));
  const rows = await db.select({ id: notificationChannels.id }).from(notificationChannels).where(and(axis, inArray(notificationChannels.id, unique)));
  if (rows.length !== unique.length) fail(400, 'Notification channels are not available to this owner');
}
async function validateRouting(data: { channelIds?: string[]; escalationPolicyId?: string | null; conditions?: unknown }, owner: RoutingOwner, auth: AuthContext): Promise<void> {
  if (data.channelIds !== undefined) await validateChannels(data.channelIds, owner);
  if (data.escalationPolicyId && !(await escalationPolicyCompatible(data.escalationPolicyId, owner))) fail(400, 'Escalation policy is not available to this rule owner');
  if (data.conditions !== undefined && !(await canAccessRoutingSites(auth, owner, routingSiteIds(data.conditions), true))) fail(403, 'Routing rule sites are outside your permitted sites');
}
async function execute(input: Input, auth: AuthContext): Promise<unknown> {
  if (!['organization','partner','system'].includes(auth.scope)) fail(403, 'Scope not permitted');
  if (!READS.has(input.action)) {
    if (!canMutateOrgWideGovernance(auth)) fail(403, SITE_CEILING_WRITE_DENIED_MESSAGE);
    if (auth.principal?.kind !== 'ai_agent' && !hasSatisfiedMfa(auth)) fail(403, 'MFA required');
  }
  if (input.action === 'resolve') return previewDelivery({ orgId: input.orgId!, severity: input.severity!, kind: input.kind, siteId: input.siteId, monitorId: input.monitorId }, auth);
  if (input.action === 'list_routing' || input.action === 'list_escalation') {
    const owner = resolveOwner(input, auth);
    const partnerId = owner.orgId ? await partnerIdForOrg(owner.orgId, db) : null;
    const inherited = owner.orgId && partnerId ? await readInheritedRails(
      input.action === 'list_routing' ? 'routing' : 'escalation',
      { orgId: owner.orgId, partnerId, allowedSiteIds: auth.allowedSiteIds }, db,
    ) : [];
    if (input.action === 'list_routing') {
      const axis = owner.orgId !== null ? eq(notificationRoutingRules.orgId, owner.orgId)
        : and(isNull(notificationRoutingRules.orgId), eq(notificationRoutingRules.partnerId, owner.partnerId!));
      const rows = await db.select().from(notificationRoutingRules).where(axis)
        .orderBy(asc(notificationRoutingRules.isDefault), asc(notificationRoutingRules.priority), asc(notificationRoutingRules.id)).limit(100);
      const visible = await Promise.all(rows.map(async row =>
        await canAccessRoutingSites(auth, owner, routingSiteIds(row.conditions), false) ? row : null));
      return { data: [...visible.filter(row => row !== null), ...inherited].slice(0, 100) };
    }
    const axis = owner.orgId !== null ? eq(escalationPolicies.orgId, owner.orgId)
      : and(isNull(escalationPolicies.orgId), eq(escalationPolicies.partnerId, owner.partnerId!));
    const own = await db.select().from(escalationPolicies).where(axis).orderBy(asc(escalationPolicies.id)).limit(100);
    return { data: [...own, ...inherited].slice(0, 100) };
  }
  if (input.action === 'create_routing' || input.action === 'set_default') {
    const owner = resolveOwner(input, auth); assertWritable(owner, auth);
    if (input.action === 'set_default') {
      const data = upsertDefaultRowSchema.omit({ ownerScope: true }).strict().parse(input.data);
      await validateRouting(data, owner, auth);
      return { data: await upsertDefaultRow(owner, { channelIds: data.channelIds, escalationPolicyId: data.escalationPolicyId ?? null }, auth) };
    }
    const data = createRoutingRuleSchema.omit({ ownerScope: true }).strict().parse(input.data);
    await validateRouting(data, owner, auth);
    const [row] = await db.insert(notificationRoutingRules).values({ ...owner, name: data.name, priority: data.priority,
      conditions: data.conditions, channelIds: [...new Set(data.channelIds)], enabled: data.enabled,
      escalationPolicyId: data.escalationPolicyId ?? null, isDefault: false }).returning();
    if (!row) throw new Error('Insert returned no row');
    return { data: row };
  }
  if (input.action === 'update_routing' || input.action === 'delete_routing') {
    const row = await getRoutingRuleWithAccess(input.id!, auth);
    if (!row) fail(404, 'Routing rule not found');
    const owner = { orgId: row.orgId, partnerId: row.partnerId }; assertWritable(owner, auth);
    if (!(await canAccessRoutingSites(auth, owner, routingSiteIds(row.conditions), true))) fail(403, 'Routing rule sites are outside your permitted sites');
    if (input.action === 'delete_routing') {
      if (row.isDefault) fail(409, 'The Everything else row cannot be deleted; empty its channels for inbox only');
      const deleted = await db.delete(notificationRoutingRules).where(eq(notificationRoutingRules.id, row.id)).returning({ id: notificationRoutingRules.id });
      if (!deleted.length) fail(404, 'Routing rule not found');
      return { data: { id: row.id, deleted: true } };
    }
    const data = updateRoutingRuleSchema.strict().parse(input.data);
    if (!Object.keys(data).length) fail(400, 'No updates provided');
    if (row.isDefault) assertDefaultRowPatch(data);
    else if (data.channelIds?.length === 0) fail(400, 'channelIds must contain at least one channel');
    await validateRouting(data, owner, auth);
    const [updated] = await db.update(notificationRoutingRules).set({ ...data, updatedAt: new Date() })
      .where(eq(notificationRoutingRules.id, row.id)).returning();
    if (!updated) fail(404, 'Routing rule not found');
    return { data: updated };
  }
  if (input.action === 'create_escalation') {
    const owner = resolveOwner(input, auth); assertWritable(owner, auth);
    const data = createPolicySchema.omit({ ownerScope: true, orgId: true }).strict().parse(input.data);
    await validateChannels(data.steps.flatMap(step => step.channelIds), owner);
    await validateEscalationUsers(data.steps, owner);
    const [row] = await db.insert(escalationPolicies).values({ ...owner, name: data.name, steps: data.steps }).returning();
    if (!row) throw new Error('Insert returned no row');
    return { data: row };
  }
  const row = await getEscalationPolicyWithOrgCheck(input.id!, auth);
  if (!row) fail(404, 'Escalation policy not found');
  const owner = { orgId: row.orgId, partnerId: row.partnerId }; assertWritable(owner, auth);
  if (input.action === 'delete_escalation') {
    const deleted = await db.delete(escalationPolicies).where(eq(escalationPolicies.id, row.id)).returning({ id: escalationPolicies.id });
    if (!deleted.length) fail(404, 'Escalation policy not found');
    return { data: { id: row.id, deleted: true } };
  }
  const data = updatePolicySchema.strict().parse(input.data);
  if (!Object.keys(data).length) fail(400, 'No updates provided');
  if (data.steps) {
    await validateChannels(data.steps.flatMap(step => step.channelIds), owner);
    await validateEscalationUsers(data.steps, owner);
  }
  const [updated] = await db.update(escalationPolicies).set({ ...data, updatedAt: new Date() }).where(eq(escalationPolicies.id, row.id)).returning();
  if (!updated) fail(404, 'Escalation policy not found');
  return { data: updated };
}
export function registerDeliveryTools(registry: Map<string, AiTool>): void {
  registry.set('manage_delivery', {
    tier: 1,
    definition: {
      name: 'manage_delivery',
      description: 'Resolve alert delivery or manage routing and escalation policies. Set ownership with orgId/ownerScope, write fields in data, and update/delete targets with id. set_default edits Everything else; empty channelIds means inbox only. Channel CRUD remains manage_notification_channels.',
      input_schema: z.toJSONSchema(deliveryToolSchema) as AiTool['definition']['input_schema'],
    },
    handler: async (raw, auth) => {
      try { return JSON.stringify(await execute(deliveryToolSchema.parse(raw), auth)); }
      catch (error) {
        if (error instanceof z.ZodError) return JSON.stringify({ error: error.issues[0]?.message ?? 'Invalid delivery request', status: 400 });
        if (error instanceof DeliveryWriteError) return JSON.stringify({ error: error.message, status: error.status });
        console.error('[manage_delivery] Operation failed', error);
        return JSON.stringify({ error: 'Delivery operation failed' });
      }
    },
  });
}
```

- [ ] **Step 4: Wire every registry and prompt**

```ts
// aiTools.ts: imports and registration beside registerAlertTools
import { registerDeliveryTools } from './aiToolsDelivery';
registerDeliveryTools(aiTools);

// aiToolSchemas.ts: inside toolInputSchemas
manage_delivery: deliveryToolSchema,

// aiAgentSdkTools.ts: import; inside TOOL_TIERS; inside createBreezeMcpServer's tool array
import { deliveryToolShape } from './aiToolSchemas';
manage_delivery: 1,
tool('manage_delivery', 'Resolve delivery or manage routing rules and escalation policies. Channel CRUD remains manage_notification_channels.',
  deliveryToolShape, makeHandler('manage_delivery', getAuth, onPreToolUse, onPostToolUse)),

// aiGuardrails.ts: inside TIER2_ACTIONS
manage_delivery: ['create_routing','update_routing','delete_routing','set_default','create_escalation','update_escalation','delete_escalation'],
// inside TOOL_PERMISSIONS
manage_delivery: {
  resolve: { resource: 'alerts', action: 'read' },
  list_routing: { resource: 'alerts', action: 'read' },
  list_escalation: { resource: 'alerts', action: 'read' },
  create_routing: { resource: 'alerts', action: 'write' },
  update_routing: { resource: 'alerts', action: 'write' },
  delete_routing: { resource: 'alerts', action: 'write' },
  set_default: { resource: 'alerts', action: 'write' },
  create_escalation: { resource: 'alerts', action: 'write' },
  update_escalation: { resource: 'alerts', action: 'write' },
  delete_escalation: { resource: 'alerts', action: 'write' },
},
// inside TOOL_RATE_LIMITS
manage_delivery: { limit: 10, windowSeconds: 300 },

// aiAgents/agentToolCatalog.ts: inside TOOL_CAPABILITY
manage_delivery: 'alerts_monitoring',
```

Insert this exact bullet in the tool section of `aiAgentSystemPrompt.ts`'s existing prompt string (no new template-string delimiters):

```text
- **Alert delivery**: manage_delivery (resolve/list_routing/create_routing/update_routing/delete_routing/set_default/list_escalation/create_escalation/update_escalation/delete_escalation). Resolve inheritance before changing delivery. An empty channelIds list on set_default means inbox only. Default rows cannot be deleted. Channel CRUD remains manage_notification_channels.
```

- [ ] **Step 5: Run, expect PASS**

```bash
(cd apps/api && npx vitest run src/services/aiToolsDelivery.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiAgentSystemPrompt.test.ts src/routes/alerts/routing.defaultRow.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts)
(cd apps/web && npx vitest run src/components/alerts/delivery/RoutingSection.test.tsx src/components/alerts/delivery/deliveryActions.test.ts)
git diff --exit-code -- apps/api/src/services/aiAgents/__snapshots__/agentToolCatalog.contract.test.ts.snap
```

The frozen snapshot must pass without `-u`: this wave adds a reachable tool and does not make the existing channel tool reachable. This explicitly covers the snapshot promised in File Structure; changing it would conceal an unrelated reachability change.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiToolsDelivery.ts apps/api/src/services/aiToolsDelivery.test.ts apps/api/src/services/aiTools.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/aiAgentSystemPrompt.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts apps/api/src/services/aiAgents/agentToolCatalog.contract.test.ts apps/api/src/routes/alerts/routing.ts
git commit -m "feat(ai): manage delivery through shared resolution and guarded writes (W05b)"
```

---

### Task 16: Document the Delivery home, visible defaults, preview, and upgrade behavior

**Files:**
- Modify: `apps/docs/src/content/docs/features/notifications.mdx:8,352-403,611-614`
- Modify: `apps/docs/src/content/docs/features/alerts.mdx:2-10,188-236`
- Read/verify: `apps/docs/package.json:7-11` (`check`, `build`), `apps/web/src/locales/README.md:32-42` (required PR locale disclosure lines)
- No docs redirects are removed in this task; W05c2/W05d own the alert-template/service-monitoring retirements and migration guides.

**Interfaces:**
- Consumes: `/alerts/delivery`, web-only 301s from `/alerts/channels` and `/alerts/routing-rules`; HTTP channel APIs remain `/alerts/channels*`. `GET /alerts/delivery/resolve` returns a bare decision plus `display`; `manage_delivery` is the routing/escalation/preview AI home.
- Produces: domain navigation **Inbox · Monitors · Delivery**, honest transitional legacy-override wording, explicit default ownership/precedence, opt-in new-channel release note, instructions for the Notify preview and Delivery rule-set preview. No promise that W05d's retirements already shipped.
- Release-note text is checked into the Notifications page's upgrade callout and copied verbatim into PR 3's release notes; do not guess the release version before the orchestrator assigns it.

- [ ] **Step 1: Write the documentation regression assertion**

This is an inline test, not a new production/test file. Run exactly this Python program from the repository root before and after the edit:

```bash
python3 - <<'PY'
from pathlib import Path
root = Path('apps/docs/src/content/docs/features')
notifications = (root / 'notifications.mdx').read_text()
alerts = (root / 'alerts.mdx').read_text()
for document in (notifications, alerts):
    assert '**Alerts > Delivery**' in document, 'missing Delivery navigation'
    assert 'Everything else' in document, 'missing explicit default'
    assert 'all enabled org channels' not in document, 'stale all-channel fallback'
    assert '**Alerts > Channels**' not in document, 'stale Channels page'
assert 'GET /alerts/delivery/resolve' in notifications, 'missing preview endpoint'
assert 'New notification channels are not subscribed to anything until added to a routing row.' in notifications, 'missing upgrade notice'
assert 'monitorKinds' in notifications and 'manage_delivery' in notifications
assert '`disabled` or `unavailable`' in notifications, 'stale skip vocabulary'
assert 'never include channel configuration or escalation step targets' in notifications, 'missing inherited metadata boundary'
assert 'API-only today' not in alerts, 'stale escalation UI claim'
assert '**Condition types**' not in alerts and '**Device tags**' not in alerts, 'inert routing filters still documented'
assert '| Inbox |' in alerts and '| Monitors |' in alerts and '| Delivery |' in alerts
print('delivery docs contract: PASS')
PY
```

- [ ] **Step 2: Run, expect FAIL**

Run Step 1's command. Expected first failure on the current checkout: `AssertionError: missing Delivery navigation`. It must not be bypassed by weakening the assertion or suppressing its exit code.

- [ ] **Step 3: Implement the documentation replacements**

Replace the opening paragraph at `notifications.mdx:8` with:

```mdx
Breeze delivers alert notifications through the channels configured in **Alerts > Delivery**. The page has three sections: Channels, Routing, and Escalation policies. Channels and routing can belong to one organization or to its partner. Every alert still creates in-app notifications; external delivery follows the monitor's Notify choice and the visible routing rows, ending at **Everything else**.
```

Replace the entire section from `## Notification Routing` through the separator immediately before `## API Reference` with this content (leave all sender configuration and API channel examples intact):

````mdx
## Notification Routing

Open **Alerts > Delivery**, then **Routing**. A monitor's own Notify setting wins; otherwise the first matching row from the top decides delivery.

<Steps>
1. In-app notifications are created independently of external delivery.
2. A monitor set to **Inbox only** sends no external notifications and does not escalate. A monitor set to **Use these channels instead** uses its own channel list.
3. During the conversion period, an unretired legacy rule's explicit channel override still applies. Conversion carries that choice onto the monitor; upgrading Delivery does not silently remove it.
4. Other alerts use the first matching enabled routing row. Rows match severity, monitor kind (`monitorKinds`), and site. Lower priority numbers run first; organization rows win ties with partner rows. Non-default rows are considered before defaults.
5. If no ordinary row matches, the organization's **Everything else** row applies when present; otherwise the partner's **Everything else** row applies. Empty default channels mean **Inbox only**. With no default row, delivery is also inbox only.
</Steps>

A site-specific row matches only a known matching site. A monitor-kind row cannot match an alert with no monitor kind. The old condition-type and device-tag routing inputs never affected delivery and are no longer accepted.

**Everything else** is always shown last and cannot be reordered or deleted. Its channels and escalation policy can be edited. In an organization view, **Customize for this organization** creates the optional org default from the partner's current choices. That row then shadows the partner default for that organization.

### Preview delivery

A monitor's **Notify > Inherit** card shows the channel names, the matching row and its owner, and the escalation policy. Its link opens **Alerts > Delivery**. Changing severity or monitor kind refreshes the preview using the current editor values. Explicit channel and inbox-only choices remain editable on the monitor.

On Delivery, **Test this rule set** previews a severity, optional monitor kind, and optional site. Select an organization first for partner-wide monitors. Without a site, site-specific rows are excluded. This preview does not send notifications.

The API is `GET /alerts/delivery/resolve?orgId=<uuid>&severity=critical&kind=cpu&siteId=<uuid>&monitorId=<uuid>`. Only `orgId` and `severity` are required. It returns eligible `channelIds`, `skippedChannelIds`, `escalationPolicyId`, `source`, optional `routingRuleId`/`routingRuleName`, a readable `display`, and structured names in `description`. A supplied monitor ID uses that saved monitor's Notify settings. The request is read-only and requires `alerts:read`; an inaccessible org/site/monitor is rejected.

The decision returns eligible `channelIds` and `skippedChannelIds` with `disabled` or `unavailable` reasons. Unavailable channels may be missing, outside the organization’s ownership, or invisible to the current session; the preview does not distinguish those cases. The preview shows both, and escalation resolves independently. Channel test results, send failures, throttles, suppression, and acknowledgement can affect actual delivery after a decision is made; a preview is not a delivery receipt.

### Escalation policies

Open **Alerts > Delivery > Escalation policies** to create, edit, or delete a policy. Give it a name and timed steps, then choose it on a routing row or in a monitor's Notify card. Partner-wide policies have an **All orgs** badge and require partner-wide management access to change.

Steps notify channels, users in-app, or both. Optional `repeat: { everyMinutes, maxTimes }` repeats a step at that interval; `maxTimes` is the number of additional sends after its first notification.

Escalation resolves independently of the initial channel list: an explicit monitor escalation wins unless Notify is **Inbox only**; otherwise the winning routing/default row's escalation applies. During conversion, a legacy rule's explicit escalation is the final fallback. An empty default channel list can therefore mean inbox now and escalation later. Acknowledging or resolving the alert cancels pending escalation jobs.

```json
{
  "name": "On-call",
  "steps": [
    { "delayMinutes": 15, "channelIds": ["channel-uuid-1"] },
    { "delayMinutes": 60, "channelIds": ["channel-uuid-1"], "userIds": ["user-uuid-1"], "repeat": { "everyMinutes": 15, "maxTimes": 2 } }
  ]
}
```

### From automations

An automation's `send_notification` action targets its configured channel explicitly. It does not change the alert delivery defaults.

### AI and MCP

Use `manage_delivery` to resolve delivery, list/create/update/delete ordinary routing rows, edit the default with `set_default`, and list/create/update/delete escalation policies. Reads require `alerts:read`; mutations require `alerts:write` and the applicable ownership and MFA/agent guards. Use `manage_notification_channels` for channel CRUD and test sends.

### Upgrade note: explicit defaults

<Aside type="caution" title="New channels are opt-in">
New notification channels are not subscribed to anything until added to a routing row.

The upgrade creates **Everything else** rows from the previously effective enabled-channel set. A partner row contains its enabled partner-wide channels. An org row is created only when that org has enabled org-owned channels, and contains those channels plus the partner's enabled partner-wide channels. Existing ordinary routing rows and explicit overrides retain precedence. Review the resulting rows in Delivery before adding new destinations.
</Aside>

## Partner-wide Channels and Routing

Choose **All organizations** when creating a partner-owned channel, routing row, or escalation policy. Ownership is fixed at creation. The org view shows its rows together with inherited partner rows; inherited rows are labelled and read-only. Manage partner rows from the partner view. Inherited reads never include channel configuration or escalation step targets: channels show identity, type and enabled state, routing shows site-filtered conditions and destination IDs, and escalation policies show identity and step count.

Partner-wide channels do not automatically subscribe new alerts merely because they exist. Add them to a routing/default row or a monitor's explicit channel choice. Test sends on a shared channel require partner-wide management access. Delivery history, throttling, and send records remain scoped to the firing device's organization.

---

````

Replace the answer beneath `**No notifications being sent for alerts.**` at `notifications.mdx:614` with:

```mdx
Open the monitor's Notify preview or **Alerts > Delivery > Test this rule set** with the alert's organization, severity, kind, and site. Check which row won, whether it has channels, and whether those channels are enabled and pass a channel test. A new channel receives no alerts until it is explicitly selected. An empty Everything else row or no default row produces only in-app notifications unless an independent escalation is configured. Existing legacy overrides remain effective during conversion. Confirm the notification dispatcher is running and inspect delivery history for failed or throttled sends.
```

In `alerts.mdx`, change frontmatter to `title: Alerts`, `sidebar.label: "Alerts"`, and `description: Manage the alert inbox, author monitors, and configure delivery in Breeze RMM.` Replace its opening paragraph at line 10 with:

```mdx
Alerts is the home for the conditions you monitor, the problems that need attention, and the people who get told.

| Facet | Purpose | Console route |
|---|---|---|
| Inbox | Review and acknowledge active alerts | `/alerts` |
| Monitors | Define a condition, automated response, and Notify choice | `/alerts/monitors` |
| Delivery | Configure channels, routing, defaults, and escalation | `/alerts/delivery` |

Create new conditions as [Monitors](/features/monitors/). Existing legacy rules remain available during the conversion period. The delivery changes below do not retire those rules or change their explicit notification overrides.
```

Replace from `### Setting Up a Channel` through the separator before `## Offline Duration for Configuration Policy Rules` with:

```mdx
### Setting Up a Channel

<Steps>
1. Go to **Alerts > Delivery**, then **Channels**, and click **New channel**.
2. Enter a name, choose a type, and fill in its connection settings.
3. Choose **This organization only** or, with partner-wide management access, **All organizations**. Ownership cannot change later.
4. Save, then use **Test** to verify the destination.
5. Add the channel to a routing row, **Everything else**, or a monitor's explicit Notify choice. Creating a channel alone does not subscribe it to alerts.
</Steps>

## Notification Routing Rules

Open **Alerts > Delivery > Routing**. Add a rule with a name, priority, optional severities, monitor kinds, and sites, plus notification channels and an optional escalation policy. Save in the row drawer.

The monitor's Notify override wins. Otherwise the first matching enabled ordinary row wins: priority ascending, organization before partner at equal priority. If none matches, the optional organization **Everything else** row wins over the partner default. A default with empty channels means inbox only; default rows cannot be deleted or reordered. During conversion an unretired legacy rule's explicit delivery override also retains precedence.

Use **Test this rule set** to inspect the decision for one organization, severity, kind, and site without sending a notification. The monitor's **Notify > Inherit** card uses the same resolver and shows the inherited destinations and their source.

## Escalation Policies

Create and edit policies in **Alerts > Delivery > Escalation policies**, then select one on a routing row or in the monitor's Notify card. Escalation is independent of initial channels: an explicit monitor escalation wins except in Inbox-only mode, followed by the winning routing row's escalation and the transitional legacy override. Acknowledging or resolving an alert cancels pending escalation jobs.

See [Notifications](/features/notifications/#notification-routing) for the complete precedence, API preview, and upgrade note. Existing bookmarks to the Channels and Routing Rules console pages redirect permanently to Delivery; the channel API URLs remain unchanged.

---

```

- [ ] **Step 4: Run, expect PASS; include exact release text in PR 3**

Run Step 1's Python assertion again; expected `delivery docs contract: PASS`. Then:

```bash
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
```

PR 3 release-note text:

```text
Alerts now has a Delivery page for channels, routing, and escalation policies. The monitor Notify card and the Delivery rule-set preview show the same decision the dispatcher uses.

New notification channels are not subscribed to anything until added to a routing row. Existing enabled destinations are preserved in visible Everything else rows created during upgrade. Unretired legacy rules keep their explicit delivery overrides during conversion.

Settings home: /alerts/delivery. Levels: partner default → organization override. Resolver: resolveDelivery. Configuration places before: 2; after: 2 (Delivery plus a monitor's explicit Notify override).

pt-BR strings are machine-drafted pending native review
es-419, fr-FR, fr-CA, de-DE, and it-IT strings are machine-drafted pending native review
```

- [ ] **Step 5: Commit**

```bash
git add apps/docs/src/content/docs/features/notifications.mdx apps/docs/src/content/docs/features/alerts.mdx
git commit -m "docs(alerts): explain Delivery previews, explicit defaults, and opt-in channels (W05b)"
```

---

### Task 17: Verify each PR and the complete W05b delivery contract

**Files:**
- Verify: every production/test path in Tasks 1–16, including the migration and existing tenant export/RLS/cascade registrations
- Verify: `apps/api/src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts`, `deliveryResolution.integration.test.ts`, `notificationRailsPartnerRls.integration.test.ts`, `rls-coverage.integration.test.ts`, `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `tenantCascade.integration.test.ts`
- Verify: `apps/api/src/db/migrationRlsScope.test.ts`, `autoMigrate.test.ts`, `migrationOrdering.test.ts`; `apps/web/src/lib/i18n/translationCoverage.test.ts`, `lib/__tests__/no-silent-mutations.test.ts`
- Modify only if the checks identify a defect in this wave: its owning implementation and regression test, using the Task 1–16 file lists. Verification itself adds no production feature, migration, or empty commit.

**Interfaces:**
- Consumes: PR 1 Tasks 1–8; PR 2 Tasks 9–12 on PR 1; PR 3 Tasks 13–16 on PRs 1–2. Run the relevant blocks **before each PR**; absent future-PR files are not failure waivers for the final wave gate.
- Produces: passing typecheck/build; unit, i18n, guardrail, migration replay, and real `breeze_app` integration evidence; no all-enabled-channel fallback or old console destinations; stable cross-wave names. The spec gate requires exact channel IDs and independent escalation agreement, not just equal counts or a mocked database. D21 additionally requires identical unavailable results and HTTP shapes for foreign/missing references, exact inherited DTO keys (no config or step targets), and denial of partner writes from org tokens (42501/403). No new policy or RLS allowlist edit is permitted; the replay suite covers only migration row/column/index behavior.
- Migration ordering: before pushing, inspect the newest migration on **origin/main** and compare with `2026-10-23-100000-delivery-routing-default-rows.sql`; rename only an unshipped migration if needed and update every filename reference in this plan's implemented tests. Never rename a shipped migration.
- Commands below are **implementation-time instructions**. The plan-finishing author must not execute them while appending this document. All commands start from the repository root; parentheses prevent accumulated `cd` state. Any failure stops the pass; no `grep`-filtered typecheck, `|| echo` success mask, or snapshots updated to hide mismatches.

- [ ] **Step 1: Write/run the acceptance assertions before calling the wave complete**

This root-level inline check is the failing test for missing wiring. It reads files only; it does not import application modules or need Docker.

```bash
python3 - <<'PY'
from pathlib import Path
required = [
 'apps/api/src/services/delivery/resolveDelivery.ts',
 'apps/api/src/services/delivery/describeDelivery.ts',
 'apps/api/src/services/delivery/escalationExecution.ts',
 'apps/api/src/services/delivery/inheritedRails.ts',
 'apps/api/src/routes/alerts/deliveryRails.ts',
 'apps/api/src/routes/alerts/delivery.ts',
 'apps/api/src/services/aiToolsDelivery.ts',
 'apps/api/src/__tests__/integration/deliveryResolution.integration.test.ts',
 'apps/api/src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts',
 'apps/web/src/pages/alerts/delivery.astro',
 'apps/web/src/components/alerts/DeliveryPage.tsx',
 'apps/web/src/components/alerts/delivery/DeliveryPreview.tsx',
 'apps/web/src/components/alerts/delivery/useDeliveryResource.ts',
]
for name in required:
    assert Path(name).is_file(), f'missing W05b artifact: {name}'
router = Path('apps/api/src/routes/alerts/index.ts').read_text()
assert router.index("route('/', deliveryRoutes)") < router.index("route('/', alertsRoutes)"), 'preview must precede catch-all'
dispatcher = Path('apps/api/src/services/notificationDispatcher.ts').read_text()
assert 'resolveDelivery({' in dispatcher, 'dispatcher bypasses shared resolver'
assert 'async function resolveRoutingRules' not in dispatcher, 'old resolver survived'
for name in ['channels/index.astro', 'routing-rules.astro']:
    source = (Path('apps/web/src/pages/alerts') / name).read_text()
    assert "Astro.redirect('/alerts/delivery', 301)" in source, f'wrong redirect: {name}'
for path in ['aiTools.ts', 'aiToolSchemas.ts', 'aiGuardrails.ts', 'aiAgentSdkTools.ts', 'aiAgents/agentToolCatalog.ts']:
    source = (Path('apps/api/src/services') / path).read_text()
    expected = 'registerDeliveryTools' if path == 'aiTools.ts' else 'manage_delivery'
    assert expected in source, f'missing AI registration: {path}'
resolver = Path('apps/api/src/services/delivery/resolveDelivery.ts').read_text()
assert "'disabled' | 'unavailable'" in resolver, 'stale channel skip contract'
for name in ['resolveDelivery', 'inheritedRails', 'describeDelivery', 'escalationExecution']:
    source = (Path('apps/api/src/services/delivery') / f'{name}.ts').read_text()
    assert 'withSystemDbAccessContext(' not in source and 'runOutsideDbContext(' not in source, 'runtime scope change'
for locale in ['en','de-DE','es-419','fr-CA','fr-FR','it-IT','pt-BR','tr-TR']:
    import json
    labels = json.loads((Path('apps/web/src/locales') / locale / 'monitoring.json').read_text())
    assert set(labels['editor']['deliveryPreview']['skipReasons']) == {'disabled', 'unavailable'}, locale
print('W05b artifact/wiring assertions: PASS')
PY
```

- [ ] **Step 2: Expect FAIL on incomplete work, then resolve the specific failing gate**

Before PR 3 exists, Step 1 reports `AssertionError: missing W05b artifact: apps/api/src/services/delivery/describeDelivery.ts`. After Task 13, a missing SDK registration reports `missing AI registration: aiAgentSdkTools.ts`. Run the checks for the PR that exists; run the entire assertion after Tasks 13–16. A missing future artifact is expected on PR 1/2, not a reason to claim full-wave success.

The mandatory PR-1 independent-escalation regression covers the old `notificationDispatcher.ts:398-400` early return; Tasks 2/4 eliminate that second filter. Add this case to `notificationDispatcher.monitorDelivery.test.ts` using Task 4's queue harness:

```ts
it('inherit escalation survives filtering all disabled baseline channels', async () => {
  channelEligibilityMock.mockResolvedValueOnce([{ id: 'aaaaaaaa-0000-4000-8000-000000000014', orgId: 'org-1', partnerId: null, enabled: false }]);
  selectQueue.push(
    [makeAlert({ ruleId: null, configPolicyId: null, monitorId: 'monitor-1' })],
    [{ id: 'device-1', displayName: 'Server-1' }], ORG_LOOKUP, ORG_LOOKUP,
    [{ kind: 'cpu', deliveryMode: 'inherit', deliveryChannelIds: [], escalationPolicyId: 'ep1' }],
    [DEFAULT_ROW],
    [{ id: 'ep1', orgId: 'org-1', partnerId: null, steps: [{ delayMinutes: 5, channelIds: ['aaaaaaaa-0000-4000-8000-000000000011'] }] }],
    [{ id: 'aaaaaaaa-0000-4000-8000-000000000011' }],
  );
  const result = await processAlertNotifications({ type: 'process-alert', alertId: 'alert-1' });
  expect(result.queued).toBe(0);
  expect(queueAddBulkMock).not.toHaveBeenCalled();
  expect(queueAddMock).toHaveBeenCalledTimes(1);
});
```

```bash
(cd apps/api && npx vitest run src/services/notificationDispatcher.monitorDelivery.test.ts)
```

Expected before the correction: `expected "spy" to be called 1 times, but got 0 times`.

- [ ] **Step 3: Verify independent escalation and run unfiltered builds/checks**

Task 2 performs all channel eligibility filtering and Task 4 schedules escalation even for an empty eligible set. If the regression fails, repair those tasks before PR 1; do not reintroduce a second dispatcher filter. This is a mandatory gate before every PR.

Build/typecheck (API on all PRs; web on PRs 2/3; docs on PR 3):

```bash
pnpm --filter @breeze/api build
(cd apps/web && npx tsc --noEmit -p .)
pnpm --filter @breeze/docs check
pnpm --filter @breeze/docs build
```

Unit checks for PR 1 and each dependent PR:

```bash
(cd apps/api && npx vitest run src/services/delivery/escalationExecution.test.ts src/services/delivery/inheritedRails.test.ts src/routes/alerts/deliveryRails.test.ts src/services/delivery/resolveDelivery.test.ts src/services/delivery/resolveDelivery.sites.test.ts src/services/delivery/routingRuleWrites.test.ts src/services/notificationDispatcher src/routes/alerts/routing.defaultRow.test.ts src/routes/alerts/routing.writes.test.ts src/routes/alerts/routing.authz.test.ts src/routes/alerts/routing.siteScope.test.ts src/routes/alerts/routing.list.test.ts src/routes/alerts/policies.authz.test.ts src/routes/alerts/policies.steps.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts src/db/migrationOrdering.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/site-ceiling-write-coverage.test.ts)
```

Additional PR 2/3 web checks:

```bash
(cd apps/web && npx vitest run src/components/alerts/DeliveryPage.test.tsx src/components/alerts/delivery/useDeliveryResource.test.tsx src/components/alerts/AlertsTabStrip.test.tsx src/components/alerts/delivery/deliveryActions.test.ts src/components/alerts/delivery/RoutingSection.test.tsx src/components/alerts/delivery/EscalationPoliciesSection.test.tsx src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/settingsPageRegistry.test.ts src/lib/__tests__/no-silent-mutations.test.ts src/lib/__tests__/no-translated-comparisons.test.ts)
```

Additional PR 3 checks:

```bash
(cd apps/api && npx vitest run src/routes/alerts/delivery.test.ts src/services/delivery/describeDelivery.test.ts src/services/aiToolsDelivery.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiAgents/agentToolCatalog.contract.test.ts src/services/aiAgentSystemPrompt.test.ts)
(cd apps/web && npx vitest run src/components/alerts/delivery/DeliveryPreview.test.tsx src/components/monitoring/MonitorEditor.test.tsx)
```

- [ ] **Step 4: Run real-database contracts, inspect migration ordering, and expect PASS**

Run once per verification session against the repository's isolated test stack (never against production):

```bash
pnpm test-stack up
(cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/deliveryDefaultRowsMigration.integration.test.ts src/__tests__/integration/deliveryResolution.integration.test.ts src/__tests__/integration/notificationRailsPartnerRls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts)
pnpm db:check-drift
pnpm test-stack down
```

Expected: default-row replay has enabled-only partner and org channel-set equality, both partial unique indexes, and idempotency, with no eligibility routine calls or definition introspection; dispatcher/preview gate executes every applicable case on PR 1 and PR 3, zero skipped; foreign/missing references have the same unavailable reason and HTTP shape, inherited DTOs have exactly the permitted keys and no config, and org partner-rail writes fail with 42501/403; both new scalar columns are classified; schema drift is empty. A missing `DATABASE_URL` that skips every `runDb` test is a failed verification, not a pass. If a command fails, stop the test stack with `pnpm test-stack down` after retaining its error output.

Check only top-level runnable SQL migrations on origin/main (exclude optional/preflight subdirectories):

```bash
git fetch origin && git ls-tree -r --name-only origin/main apps/api/migrations | grep -E '^apps/api/migrations/[0-9]{4}-[^/]+\.sql$' | sort | tail -1
scripts/check-migration-naming.sh --against-ref origin/main
```

Compare filenames; rename only an unshipped migration and update the replay filename if a newer migration has landed. Never rename shipped migrations.

Finish with these read-only assertions and review the output:

```bash
git diff --check
rg -n 'resolveDelivery|previewDelivery|manage_delivery' apps/api/src/services/delivery apps/api/src/routes/alerts/delivery.ts apps/api/src/services/notificationDispatcher.ts apps/api/src/services/aiToolsDelivery.ts
rg -n 'deliveryPreview' apps/web/src/locales/*/monitoring.json
rg -n 'Everything else|New notification channels|GET /alerts/delivery/resolve' apps/docs/src/content/docs/features/notifications.mdx
```

Repeat Task 16's docs assertion and Task 17 Step 1's wiring assertion. Confirm all eight locales have the new keys. Inspect the UI using the existing development environment: inherited partner row in an org, org default shadowing, empty default, independent monitor escalation, preview failure/retry, unsaved mode switch, and hash back/forward. Do not call a channel's **Test** button as part of a read-only preview inspection. These are supplementary visual checks; the automated endpoint/queue/RLS assertions remain the release gate.

- [ ] **Step 5: Commit only verification fixes and record the result before each PR**

Stage only defects found by verification; the independent-escalation correction is mandatory in PR 1. Do not create an empty “verification passed” commit:

```bash
git add apps/api/src/services/notificationDispatcher.ts apps/api/src/services/notificationDispatcher.monitorDelivery.test.ts
if ! git diff --cached --quiet; then
  git commit -m "fix(alerts): preserve independent escalation after channel filtering (W05b)"
fi
git status --short
```

The implementation handoff records each command's pass/fail status, integration cases executed (and zero skips), migration ordering result, and any baseline failures separately. PRs 1/2 reference the wave with a scope note; PR 3 closes the registered wave issue only when all its promised work and gates pass. Use the assigned issue number, not an invented number. Do not merge as part of this plan.

**Open questions:** None. D21 supersedes D1’s eligibility boundary and skip vocabulary; D16 and D18 settle the other delivery choices raised by the review.
