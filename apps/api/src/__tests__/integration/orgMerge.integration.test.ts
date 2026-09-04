/**
 * End-to-end org-merge gauntlet (org-lifecycle Wave 2, Task 7).
 *
 * `orgMergeCustomExecutors.integration.test.ts` proves each hand-written
 * executor in isolation, inside a rolled-back transaction. This file proves
 * the thing none of those can: that `executeOrgMerge` — fence, advisory locks,
 * deferred constraints, both passes of the ~260-table registry walk, the
 * post-pass fixups, the warning pass, the merge record and the terminal shell
 * — turns a COMMITTED two-org fixture into a correct committed end state, with
 * every policy class exercised simultaneously against every trigger,
 * partial-unique index and composite FK the real schema carries.
 *
 * That "COMMITTED" is load-bearing. Seeding inside the transaction that then
 * merges (which is all the executor-level suite can do) hides two engine bugs
 * this file found, because it makes cascades and export locks behave
 * differently than they ever do in production. See the engine's
 * `MergePolicyPhase` and `stampTerminalShell` comments.
 *
 * The fixture is deliberately NON-UNIFORM. Every policy class gets at least
 * one colliding row AND at least one non-colliding row, because a fixture
 * where every row collides (or none does) silently proves only half of each
 * executor — the branch that never fires is the branch that ships broken:
 *
 *   keep-survivor   portal_branding/org_ticket_settings collide (drop) but
 *                   ai_budgets has no survivor row (move)
 *   repoint-dedupe  tenant_variables/m365_connections each have one colliding
 *                   and one unique loser row
 *   custom          contacts has an org-level primary that must be demoted
 *                   AND a site-level primary that must NOT be; audit_baselines
 *                   exercises both the deactivate and the rename path;
 *                   organization_users has a user with TWO loser memberships
 *                   plus a survivor one (multi-row array union), a user with
 *                   one of each (plain fold), and a loser-only user (move)
 *   custom, re-home discovered_assets / plugin_installations /
 *                   playbook_definitions / pam_signer_groups each have a
 *                   colliding loser row that CARRIES a child on a NO ACTION or
 *                   RESTRICT FK (snmp_devices, plugin_logs,
 *                   playbook_executions, pam_rules). Those children are the
 *                   regression, not scenery: under the old `repoint-dedupe`
 *                   classification every one of them raised 23503 and aborted
 *                   the entire merge, and a fixture without them passes against
 *                   the broken code. discovered_assets additionally has one
 *                   non-colliding loser row, and resolves in the `resolve`
 *                   phase because it rides sites' ON UPDATE CASCADE
 *   custom, neutral incidents has a colliding loser row WITH an incident_actions
 *                   child (neutralized by clearing source_ref, never deleted)
 *                   plus a loser row EXCLUDED from the partial unique by its
 *                   NULL source_ref, which must move untouched even though
 *                   `IS NOT DISTINCT FROM` would happily match it against the
 *                   survivor's NULL
 *   follows-parent  device_commands has no org_id at all and must still end up
 *                   attached to a device that now belongs to the survivor
 *   derived         partner_export_{device,site}_material_state are never
 *                   touched by the engine — their org_id must ride the
 *                   ON UPDATE CASCADE composite FK
 *   leave-for-erasure  audit_logs / audit_log_chain / ml_feedback_events rows
 *                   must STILL be under the loser afterwards
 *
 * Both tests seed the same fixture; the second one makes a policy throw
 * mid-walk and asserts the whole thing rolls back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { createAuditLog } from '../../services/auditService';
import * as orgMergeModule from '../../services/orgMerge';
import { MergeValidationError, POST_PASS_FIXUPS_SUMMARY_KEY } from '../../services/orgMerge';
import { sweepOffboardingTenants } from '../../services/tenantOffboarding';
import { getTenantErasureQueue } from '../../jobs/tenantErasure';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function query<T = Record<string, unknown>>(statement: SQL): Promise<T[]> {
  return withSystemDbAccessContext(async () => (await db.execute(statement)) as unknown as T[]);
}

async function countIn(table: string, orgId: string): Promise<number> {
  const rows = await query<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${orgId}::uuid`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** `writeAuditEvent` is fire-and-forget, so its row lands a tick or two late. */
async function eventually(check: () => Promise<void>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function orgIdOf(table: string, idColumn: string, id: string): Promise<string | null> {
  const rows = await query<{ org_id: string }>(
    sql`SELECT org_id FROM ${sql.identifier(table)} WHERE ${sql.identifier(idColumn)} = ${id}::uuid`,
  );
  return rows[0]?.org_id ?? null;
}

/** Every table the fixture puts loser rows in that the merge MUST empty. */
const MUST_BE_EMPTY_UNDER_LOSER: readonly string[] = [
  'ai_budgets',
  'api_keys',
  'audit_baselines',
  'backup_configs',
  'contacts',
  'device_group_memberships',
  'device_groups',
  'devices',
  'discovered_assets',
  'enrollment_keys',
  'fleet_finding_devices',
  'fleet_findings',
  'fleet_remediation_runs',
  'google_workspace_connections',
  'incident_actions',
  'incidents',
  'invoice_lines',
  'invoices',
  'm365_connections',
  'organization_external_links',
  'organization_users',
  'org_ticket_settings',
  'pam_rules',
  'pam_signer_groups',
  'partner_export_device_material_state',
  'partner_export_site_material_state',
  'pax8_orders',
  'playbook_definitions',
  'playbook_executions',
  'plugin_installations',
  'portal_branding',
  'portal_users',
  'quote_lines',
  'quote_order_lines',
  'quote_orders',
  'quote_recipients',
  'quotes',
  'roles',
  'sites',
  'snmp_devices',
  'tenant_variables',
  'users',
];

/**
 * Append-only tables whose rows CANNOT be re-tenanted (per-org hash chains /
 * unconditional BEFORE UPDATE triggers). They are classified
 * `leave-for-erasure` and must still be under the loser after the merge — they
 * die with the shell in Phase C, which `previewOrgMerge` discloses.
 * `audit_chain_anchors` is the fourth member of the class but is only written
 * by the anchoring job, so there is nothing to seed here.
 */
const APPEND_ONLY_STAYS_UNDER_LOSER: readonly string[] = [
  'audit_logs',
  'audit_log_chain',
  'ml_feedback_events',
];

interface Fixture {
  partner: string;
  loser: string;
  survivor: string;
  suffix: string;
  actor: string;
  actorEmail: string;
  roleViewer: string;
  roleAdmin: string;
  roleOrgL: string;
  userLoserOnly: string;
  userStaffer: string;
  userMulti: string;
  multiEmail: string;
  siteL: string;
  siteL2: string;
  siteS: string;
  deviceL: string;
  groupL: string;
  groupS: string;
  deviceCommand: string;
  quote: string;
  quoteLine: string;
  quoteOrphanLine: string;
  quoteSiteLine: string;
  quoteRecipient: string;
  quoteOrder: string;
  quoteOrderLine: string;
  invoice: string;
  invoiceLineA: string;
  invoiceLineB: string;
  brandingL: string;
  brandingS: string;
  ticketSettingsL: string;
  ticketSettingsS: string;
  aiBudgetL: string;
  tvCollideL: string;
  tvCollideS: string;
  tvOnlyL: string;
  assetCollideL: string;
  assetCollideS: string;
  assetOnlyL: string;
  snmpChildL: string;
  pluginCatalog: string;
  pluginInstallL: string;
  pluginInstallS: string;
  pluginLogL: string;
  playbookCollideL: string;
  playbookCollideS: string;
  playbookExecL: string;
  signerGroupCollideL: string;
  signerGroupCollideS: string;
  pamRuleL: string;
  incidentCollideL: string;
  incidentNullRefL: string;
  incidentActionL: string;
  incidentSourceRef: string;
  contactOrgPrimaryL: string;
  contactSitePrimaryL: string;
  contactPlainL: string;
  contactOrgPrimaryS: string;
  baselineWinL: string;
  baselineMacL: string;
  baselineSharedL: string;
  backupDefaultL: string;
  backupDefaultS: string;
  apiKeyL: string;
  apiKeyS: string;
  enrollKeyL: string;
  enrollKeyS: string;
  findingCollideL: string;
  findingOnlyL: string;
  findingS: string;
  remediationRunL: string;
  pax8Integration: string;
  pax8DirectDraftL: string;
  pax8QuoteDraftL: string;
  gwsL: string;
  m365CollideL: string;
  m365OnlyL: string;
  extLinkL: string;
  portalDupL: string;
  portalOnlyL: string;
  dupPortalEmail: string;
  partnerUserBoth: string;
  partnerUserLoserOnly: string;
  policyCollide: string;
  policyMoves: string;
  assignmentCollideL: string;
  assignmentMovesL: string;
  mlEventL: string;
}

/**
 * Seeds a COMMITTED two-org fixture. Committed on purpose: `executeOrgMerge`
 * exits the ambient context (`runOutsideDbContext`) and opens its own
 * transaction, so it cannot see uncommitted rows. The integration harness
 * TRUNCATEs the tenant roots in its own `beforeEach`, which runs first.
 */
async function seedFixture(): Promise<Fixture> {
  const partner = randomUUID();
  const loser = randomUUID();
  const survivor = randomUUID();
  const suffix = loser.slice(0, 8);

  const f: Fixture = {
    partner,
    loser,
    survivor,
    suffix,
    actor: randomUUID(),
    actorEmail: `actor-${suffix}@x.test`,
    roleViewer: randomUUID(),
    roleAdmin: randomUUID(),
    roleOrgL: randomUUID(),
    userLoserOnly: randomUUID(),
    userStaffer: randomUUID(),
    userMulti: randomUUID(),
    multiEmail: `multi-${suffix}@x.test`,
    siteL: randomUUID(),
    siteL2: randomUUID(),
    siteS: randomUUID(),
    deviceL: randomUUID(),
    groupL: randomUUID(),
    groupS: randomUUID(),
    deviceCommand: randomUUID(),
    quote: randomUUID(),
    quoteLine: randomUUID(),
    quoteOrphanLine: randomUUID(),
    quoteSiteLine: randomUUID(),
    quoteRecipient: randomUUID(),
    quoteOrder: randomUUID(),
    quoteOrderLine: randomUUID(),
    invoice: randomUUID(),
    invoiceLineA: randomUUID(),
    invoiceLineB: randomUUID(),
    brandingL: randomUUID(),
    brandingS: randomUUID(),
    ticketSettingsL: randomUUID(),
    ticketSettingsS: randomUUID(),
    aiBudgetL: randomUUID(),
    tvCollideL: randomUUID(),
    tvCollideS: randomUUID(),
    tvOnlyL: randomUUID(),
    assetCollideL: randomUUID(),
    assetCollideS: randomUUID(),
    assetOnlyL: randomUUID(),
    snmpChildL: randomUUID(),
    pluginCatalog: randomUUID(),
    pluginInstallL: randomUUID(),
    pluginInstallS: randomUUID(),
    pluginLogL: randomUUID(),
    playbookCollideL: randomUUID(),
    playbookCollideS: randomUUID(),
    playbookExecL: randomUUID(),
    signerGroupCollideL: randomUUID(),
    signerGroupCollideS: randomUUID(),
    pamRuleL: randomUUID(),
    incidentCollideL: randomUUID(),
    incidentNullRefL: randomUUID(),
    incidentActionL: randomUUID(),
    incidentSourceRef: `ref-${suffix}`,
    contactOrgPrimaryL: randomUUID(),
    contactSitePrimaryL: randomUUID(),
    contactPlainL: randomUUID(),
    contactOrgPrimaryS: randomUUID(),
    baselineWinL: randomUUID(),
    baselineMacL: randomUUID(),
    baselineSharedL: randomUUID(),
    backupDefaultL: randomUUID(),
    backupDefaultS: randomUUID(),
    apiKeyL: randomUUID(),
    apiKeyS: randomUUID(),
    enrollKeyL: randomUUID(),
    enrollKeyS: randomUUID(),
    findingCollideL: randomUUID(),
    findingOnlyL: randomUUID(),
    findingS: randomUUID(),
    remediationRunL: randomUUID(),
    pax8Integration: randomUUID(),
    pax8DirectDraftL: randomUUID(),
    pax8QuoteDraftL: randomUUID(),
    gwsL: randomUUID(),
    m365CollideL: randomUUID(),
    m365OnlyL: randomUUID(),
    extLinkL: randomUUID(),
    portalDupL: randomUUID(),
    portalOnlyL: randomUUID(),
    dupPortalEmail: `dup-${suffix}@x.test`,
    partnerUserBoth: randomUUID(),
    partnerUserLoserOnly: randomUUID(),
    policyCollide: randomUUID(),
    policyMoves: randomUUID(),
    assignmentCollideL: randomUUID(),
    assignmentMovesL: randomUUID(),
    mlEventL: randomUUID(),
  };

  await withSystemDbAccessContext(async () => {
    await db.execute(sql`
      INSERT INTO partners (id, name, slug) VALUES (${f.partner}::uuid, 'Gauntlet MSP', ${`gauntlet-${suffix}`})`);
    await db.execute(sql`
      INSERT INTO organizations (id, partner_id, name, slug, status, currency_code) VALUES
        (${f.loser}::uuid,    ${f.partner}::uuid, 'Loser Co',    ${`loser-${suffix}`},    'active', 'USD'),
        (${f.survivor}::uuid, ${f.partner}::uuid, 'Survivor Co', ${`survivor-${suffix}`}, 'active', 'USD')`);

    // --- principals ------------------------------------------------------
    await db.execute(sql`
      INSERT INTO users (id, email, name, partner_id, org_id) VALUES
        (${f.actor}::uuid,         ${f.actorEmail},              'Actor',   ${f.partner}::uuid, NULL),
        (${f.userLoserOnly}::uuid, ${`only-${suffix}@x.test`},   'OnlyL',   ${f.partner}::uuid, ${f.loser}::uuid),
        (${f.userStaffer}::uuid,   ${`staff-${suffix}@x.test`},  'Staffer', ${f.partner}::uuid, NULL),
        (${f.userMulti}::uuid,     ${f.multiEmail},              'Multi',   ${f.partner}::uuid, NULL)`);
    // roleViewer/roleAdmin are partner-level (org_id NULL) so they never move;
    // roleOrgL is org-owned and must repoint, proving `roles` is a live
    // repoint table and not just a parent the walk skips.
    await db.execute(sql`
      INSERT INTO roles (id, scope, name, partner_id, org_id) VALUES
        (${f.roleViewer}::uuid, 'organization', 'Org Viewer', ${f.partner}::uuid, NULL),
        (${f.roleAdmin}::uuid,  'organization', 'Org Admin',  ${f.partner}::uuid, NULL),
        (${f.roleOrgL}::uuid,   'organization', ${`Loser Local Role ${suffix}`}, ${f.partner}::uuid, ${f.loser}::uuid)`);

    // --- sites / devices / groups ----------------------------------------
    await db.execute(sql`
      INSERT INTO sites (id, org_id, name) VALUES
        (${f.siteL}::uuid,  ${f.loser}::uuid,    'L Main'),
        (${f.siteL2}::uuid, ${f.loser}::uuid,    'L Branch'),
        (${f.siteS}::uuid,  ${f.survivor}::uuid, 'S Main')`);
    await db.execute(sql`
      INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (${f.deviceL}::uuid, ${f.loser}::uuid, ${f.siteL}::uuid, ${`agent-${suffix}`}, ${`host-${suffix}`}, 'windows', '11', 'x64', '1.0.0')`);
    await db.execute(sql`
      INSERT INTO device_groups (id, org_id, name) VALUES
        (${f.groupL}::uuid, ${f.loser}::uuid,    'L Group'),
        (${f.groupS}::uuid, ${f.survivor}::uuid, 'S Group')`);
    await db.execute(sql`
      INSERT INTO device_group_memberships (device_id, group_id, org_id)
      VALUES (${f.deviceL}::uuid, ${f.groupL}::uuid, ${f.loser}::uuid)`);
    // follows-parent: no org_id at all — tenancy is inferred through device_id.
    await db.execute(sql`
      INSERT INTO device_commands (id, device_id, type)
      VALUES (${f.deviceCommand}::uuid, ${f.deviceL}::uuid, 'ping')`);

    // --- repoint + composite-FK chain (deferrable (id, org_id) FKs) --------
    await db.execute(sql`
      INSERT INTO quotes (id, partner_id, org_id, currency_code) VALUES (${f.quote}::uuid, ${f.partner}::uuid, ${f.loser}::uuid, 'USD')`);
    const deletedDescriptorGroup = randomUUID();
    await db.execute(sql`
      INSERT INTO device_groups (id, org_id, name)
      VALUES (${deletedDescriptorGroup}::uuid, ${f.loser}::uuid, 'Deleted Quote Group')`);
    await db.execute(sql`
      INSERT INTO quote_lines (
        id, quote_id, org_id, source_type, name, quantity, unit_price, line_total,
        recurrence, contract_line_type, device_group_id, device_group_name, site_id, site_name
      ) VALUES
        (${f.quoteLine}::uuid, ${f.quote}::uuid, ${f.loser}::uuid, 'manual', 'Scoped quote line', 2, 100, 200,
         'monthly', 'per_device_group', ${f.groupL}::uuid, 'L Group stamped', NULL, NULL),
        (${f.quoteOrphanLine}::uuid, ${f.quote}::uuid, ${f.loser}::uuid, 'manual', 'Orphaned quote line', 3, 25, 75,
         'monthly', 'per_device_group', ${deletedDescriptorGroup}::uuid, 'Deleted Quote Group stamped', NULL, NULL),
        (${f.quoteSiteLine}::uuid, ${f.quote}::uuid, ${f.loser}::uuid, 'manual', 'Site quote line', 4, 10, 40,
         'monthly', 'per_device', NULL, NULL, ${f.siteL}::uuid, 'L Main stamped')`);
    // ON DELETE SET NULL clears only the live id. The stamped name deliberately
    // survives and the merge must preserve that unresolved descriptor shape.
    await db.execute(sql`DELETE FROM device_groups WHERE id = ${deletedDescriptorGroup}::uuid`);
    await db.execute(sql`
      INSERT INTO quote_recipients (id, quote_id, org_id, email)
      VALUES (${f.quoteRecipient}::uuid, ${f.quote}::uuid, ${f.loser}::uuid, ${`rcpt-${suffix}@x.test`})`);
    await db.execute(sql`
      INSERT INTO quote_orders (id, quote_id, org_id) VALUES (${f.quoteOrder}::uuid, ${f.quote}::uuid, ${f.loser}::uuid)`);
    await db.execute(sql`
      INSERT INTO quote_order_lines (id, order_id, quote_id, org_id, quote_line_id, ordered_qty)
      VALUES (${f.quoteOrderLine}::uuid, ${f.quoteOrder}::uuid, ${f.quote}::uuid, ${f.loser}::uuid, ${f.quoteLine}::uuid, 2)`);
    await db.execute(sql`
      INSERT INTO invoices (id, partner_id, org_id, currency_code) VALUES (${f.invoice}::uuid, ${f.partner}::uuid, ${f.loser}::uuid, 'USD')`);
    await db.execute(sql`
      INSERT INTO invoice_lines (id, invoice_id, org_id, source_type, quantity, unit_price, line_total) VALUES
        (${f.invoiceLineA}::uuid, ${f.invoice}::uuid, ${f.loser}::uuid, 'manual', 1, 50, 50),
        (${f.invoiceLineB}::uuid, ${f.invoice}::uuid, ${f.loser}::uuid, 'manual', 3, 10, 30)`);

    // --- keep-survivor: two collide, one has no survivor row and must move --
    await db.execute(sql`
      INSERT INTO portal_branding (id, org_id) VALUES
        (${f.brandingL}::uuid, ${f.loser}::uuid),
        (${f.brandingS}::uuid, ${f.survivor}::uuid)`);
    await db.execute(sql`
      INSERT INTO org_ticket_settings (id, org_id, rate_currency) VALUES
        (${f.ticketSettingsL}::uuid, ${f.loser}::uuid, 'USD'),
        (${f.ticketSettingsS}::uuid, ${f.survivor}::uuid, 'USD')`);
    await db.execute(sql`
      INSERT INTO ai_budgets (id, org_id) VALUES (${f.aiBudgetL}::uuid, ${f.loser}::uuid)`);

    // --- repoint-dedupe ----------------------------------------------------
    await db.execute(sql`
      INSERT INTO tenant_variables (id, org_id, key, value) VALUES
        (${f.tvCollideL}::uuid, ${f.loser}::uuid,    'shared_key', 'loser value'),
        (${f.tvOnlyL}::uuid,    ${f.loser}::uuid,    'loser_only', 'kept'),
        (${f.tvCollideS}::uuid, ${f.survivor}::uuid, 'shared_key', 'survivor value')`);
    // --- custom: the four re-home-then-delete tables ------------------------
    // Each colliding loser row carries the CHILD that made the old generic
    // `repoint-dedupe` DELETE raise 23503 and abort the whole merge. The child
    // is the regression, not decoration: without it these fixtures pass against
    // the broken classification.
    await db.execute(sql`
      INSERT INTO discovered_assets (id, org_id, site_id, ip_address) VALUES
        (${f.assetCollideL}::uuid, ${f.loser}::uuid,    ${f.siteL}::uuid, '10.0.0.1'),
        (${f.assetOnlyL}::uuid,    ${f.loser}::uuid,    ${f.siteL}::uuid, '10.0.0.2'),
        (${f.assetCollideS}::uuid, ${f.survivor}::uuid, ${f.siteS}::uuid, '10.0.0.1')`);
    // snmp_devices.asset_id -> discovered_assets(id), NO ACTION and NOT
    // deferrable: deleting the duplicate asset out from under it aborts Phase B.
    await db.execute(sql`
      INSERT INTO snmp_devices (id, org_id, asset_id, name, ip_address, snmp_version)
      VALUES (${f.snmpChildL}::uuid, ${f.loser}::uuid, ${f.assetCollideL}::uuid, 'L snmp', '10.0.0.1', '2c')`);

    // plugin_logs.installation_id is NOT NULL + NO ACTION — the same trap, with
    // no possibility of a SET NULL escape.
    await db.execute(sql`
      INSERT INTO plugin_catalog (id, slug, name, version, type)
      VALUES (${f.pluginCatalog}::uuid, ${`plug-${suffix}`}, 'Plug', '1.0.0', 'integration')`);
    await db.execute(sql`
      INSERT INTO plugin_installations (id, org_id, catalog_id, version) VALUES
        (${f.pluginInstallL}::uuid, ${f.loser}::uuid,    ${f.pluginCatalog}::uuid, '1.0.0'),
        (${f.pluginInstallS}::uuid, ${f.survivor}::uuid, ${f.pluginCatalog}::uuid, '1.0.0')`);
    await db.execute(sql`
      INSERT INTO plugin_logs (id, installation_id, level, message)
      VALUES (${f.pluginLogL}::uuid, ${f.pluginInstallL}::uuid, 'info', 'installed')`);

    // playbook_definitions' unique is on lower(name) — the two names differ only
    // by case on purpose, so a key that forgot the lower() would see no
    // collision at all and hit 23505 instead.
    await db.execute(sql`
      INSERT INTO playbook_definitions (id, org_id, name, description, steps) VALUES
        (${f.playbookCollideL}::uuid, ${f.loser}::uuid,    ${`Restart ${suffix}`}, 'l', '[]'::jsonb),
        (${f.playbookCollideS}::uuid, ${f.survivor}::uuid, ${`RESTART ${suffix}`}, 's', '[]'::jsonb)`);
    await db.execute(sql`
      INSERT INTO playbook_executions (id, org_id, device_id, playbook_id, triggered_by)
      VALUES (${f.playbookExecL}::uuid, ${f.loser}::uuid, ${f.deviceL}::uuid, ${f.playbookCollideL}::uuid, 'manual')`);

    // pam_rules.match_signer_group_id is ON DELETE RESTRICT — worse than NO
    // ACTION, since RESTRICT cannot be deferred at all.
    await db.execute(sql`
      INSERT INTO pam_signer_groups (id, org_id, name) VALUES
        (${f.signerGroupCollideL}::uuid, ${f.loser}::uuid,    ${`Vendor ${suffix}`}),
        (${f.signerGroupCollideS}::uuid, ${f.survivor}::uuid, ${`Vendor ${suffix}`})`);
    await db.execute(sql`
      INSERT INTO pam_rules (id, org_id, name, verdict, match_signer_group_id)
      VALUES (${f.pamRuleL}::uuid, ${f.loser}::uuid, 'L rule', 'auto_approve', ${f.signerGroupCollideL}::uuid)`);

    // --- custom: incidents (neutralize, never delete) ------------------------
    // The unique is PARTIAL: (org_id, source_type, source_ref) WHERE source_ref
    // IS NOT NULL. The NULL-source_ref loser row proves the predicate is
    // honoured — a naive `IS NOT DISTINCT FROM` match would treat its NULL as a
    // collision with the survivor's NULL and clobber a live incident. The
    // colliding row carries an incident_actions child (NOT NULL, NO ACTION):
    // deleting the incident aborts the merge, so it must be neutralized instead.
    await db.execute(sql`
      INSERT INTO incidents (id, org_id, title, classification, severity, detected_at, source_type, source_ref) VALUES
        (${f.incidentCollideL}::uuid, ${f.loser}::uuid,    'L dup',    'security', 'p2', now(), 'alert', ${f.incidentSourceRef}),
        (${f.incidentNullRefL}::uuid, ${f.loser}::uuid,    'L manual', 'security', 'p3', now(), 'alert', NULL),
        (${randomUUID()}::uuid,       ${f.survivor}::uuid, 'S dup',    'security', 'p2', now(), 'alert', ${f.incidentSourceRef}),
        (${randomUUID()}::uuid,       ${f.survivor}::uuid, 'S manual', 'security', 'p3', now(), 'alert', NULL)`);
    await db.execute(sql`
      INSERT INTO incident_actions (id, org_id, incident_id, action_type, description, executed_at)
      VALUES (${f.incidentActionL}::uuid, ${f.loser}::uuid, ${f.incidentCollideL}::uuid, 'isolate', 'isolated host', now())`);

    // --- custom: contacts (org primary demoted, site primary untouched) -----
    await db.execute(sql`
      INSERT INTO contacts (id, org_id, site_id, name, email, is_primary) VALUES
        (${f.contactOrgPrimaryL}::uuid,  ${f.loser}::uuid,    NULL,             'L org primary',  ${`lop-${suffix}@x.test`}, true),
        (${f.contactSitePrimaryL}::uuid, ${f.loser}::uuid,    ${f.siteL}::uuid, 'L site primary', ${`lsp-${suffix}@x.test`}, true),
        (${f.contactPlainL}::uuid,       ${f.loser}::uuid,    NULL,             'L plain',        ${`lpl-${suffix}@x.test`}, false),
        (${f.contactOrgPrimaryS}::uuid,  ${f.survivor}::uuid, NULL,             'S org primary',  ${`sop-${suffix}@x.test`}, true)`);

    // --- custom: audit_baselines (deactivate path AND rename path) ----------
    await db.execute(sql`
      INSERT INTO audit_baselines (id, org_id, name, os_type, profile, settings, is_active) VALUES
        (${f.baselineWinL}::uuid,    ${f.loser}::uuid,    'L win',  'windows', 'std', '{}'::jsonb, true),
        (${f.baselineMacL}::uuid,    ${f.loser}::uuid,    'L mac',  'macos',   'std', '{}'::jsonb, true),
        (${f.baselineSharedL}::uuid, ${f.loser}::uuid,    'Shared', 'linux',   'cis', '{}'::jsonb, false),
        (${randomUUID()}::uuid,      ${f.survivor}::uuid, 'S win',  'windows', 'std', '{}'::jsonb, true),
        (${randomUUID()}::uuid,      ${f.survivor}::uuid, 'Shared', 'linux',   'cis', '{}'::jsonb, false)`);

    // --- custom: backup_configs / api_keys / enrollment_keys ---------------
    await db.execute(sql`
      INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config, is_default) VALUES
        (${f.backupDefaultL}::uuid, ${f.loser}::uuid,    'L default', 'file', 'local', '{}'::jsonb, true),
        (${f.backupDefaultS}::uuid, ${f.survivor}::uuid, 'S default', 'file', 'local', '{}'::jsonb, true)`);
    await db.execute(sql`
      INSERT INTO api_keys (id, org_id, name, key_hash, key_prefix, created_by, status) VALUES
        (${f.apiKeyL}::uuid, ${f.loser}::uuid,    'L key', ${`lh-${suffix}`}, 'brz_l', ${f.actor}::uuid, 'active'),
        (${f.apiKeyS}::uuid, ${f.survivor}::uuid, 'S key', ${`sh-${suffix}`}, 'brz_s', ${f.actor}::uuid, 'active')`);
    await db.execute(sql`
      INSERT INTO enrollment_keys (id, org_id, name, key, expires_at) VALUES
        (${f.enrollKeyL}::uuid, ${f.loser}::uuid,    'L enroll', ${`lk-${suffix}`}, NULL),
        (${f.enrollKeyS}::uuid, ${f.survivor}::uuid, 'S enroll', ${`sk-${suffix}`}, NULL)`);

    // --- custom: fleet_findings + the children a DELETE would cascade away --
    await db.execute(sql`
      INSERT INTO fleet_findings (id, org_id, kind, semantic_key, algorithm_version, status, severity, title, first_seen_at, last_seen_at) VALUES
        (${f.findingCollideL}::uuid, ${f.loser}::uuid,    'log_correlation', 'k1', 1, 'open', 'warning', 'L k1', now(), now()),
        (${f.findingOnlyL}::uuid,    ${f.loser}::uuid,    'log_correlation', 'k2', 1, 'open', 'warning', 'L k2', now(), now()),
        (${f.findingS}::uuid,        ${f.survivor}::uuid, 'log_correlation', 'k1', 1, 'open', 'warning', 'S k1', now(), now())`);
    await db.execute(sql`
      INSERT INTO fleet_remediation_runs (id, org_id, finding_id, finding_revision, action_kind)
      VALUES (${f.remediationRunL}::uuid, ${f.loser}::uuid, ${f.findingCollideL}::uuid, 1, 'script')`);
    await db.execute(sql`
      INSERT INTO fleet_finding_devices (finding_id, org_id, device_id, source_kind, first_seen_at, last_seen_at)
      VALUES (${f.findingCollideL}::uuid, ${f.loser}::uuid, ${f.deviceL}::uuid, 'log_correlation', now(), now())`);

    // --- custom: organization_users -----------------------------------------
    // userStaffer  1 loser + 1 survivor membership, SAME role  -> plain fold
    // userMulti    2 loser + 1 survivor membership, role conflict on one of
    //              them -> arrays unioned from BOTH loser rows, survivor role
    //              wins, and one loser row's NULL device_group_ids makes the
    //              union unrestricted
    // userLoserOnly  1 loser membership, no counterpart -> plain move
    await db.execute(sql`
      INSERT INTO organization_users (org_id, user_id, role_id, site_ids, device_group_ids) VALUES
        (${f.loser}::uuid,    ${f.userStaffer}::uuid, ${f.roleViewer}::uuid, ARRAY[${f.siteL}::uuid],  ARRAY[${f.groupL}::uuid]),
        (${f.survivor}::uuid, ${f.userStaffer}::uuid, ${f.roleViewer}::uuid, ARRAY[${f.siteS}::uuid],  ARRAY[${f.groupS}::uuid]),
        (${f.loser}::uuid,    ${f.userMulti}::uuid,   ${f.roleAdmin}::uuid,  ARRAY[${f.siteL}::uuid],  NULL),
        (${f.loser}::uuid,    ${f.userMulti}::uuid,   ${f.roleViewer}::uuid, ARRAY[${f.siteL2}::uuid], ARRAY[${f.groupL}::uuid]),
        (${f.survivor}::uuid, ${f.userMulti}::uuid,   ${f.roleViewer}::uuid, ARRAY[${f.siteS}::uuid],  ARRAY[${f.groupS}::uuid]),
        (${f.loser}::uuid,    ${f.userLoserOnly}::uuid, ${f.roleOrgL}::uuid, NULL,                     NULL)`);

    // --- custom: pax8_orders (the one custom executor that DELETEs) ---------
    await db.execute(sql`
      INSERT INTO pax8_integrations (id, partner_id, name, client_id_encrypted, client_secret_encrypted, token_url)
      VALUES (${f.pax8Integration}::uuid, ${f.partner}::uuid, 'Pax8', 'x', 'y', 'https://t.test')`);
    await db.execute(sql`
      INSERT INTO pax8_orders (id, integration_id, partner_id, org_id, status, source, dedupe_key) VALUES
        (${f.pax8DirectDraftL}::uuid, ${f.pax8Integration}::uuid, ${f.partner}::uuid, ${f.loser}::uuid,    'draft', 'direct', ${`d-l-${suffix}`}),
        (${f.pax8QuoteDraftL}::uuid,  ${f.pax8Integration}::uuid, ${f.partner}::uuid, ${f.loser}::uuid,    'draft', 'quote',  ${`d-lq-${suffix}`}),
        (${randomUUID()}::uuid,       ${f.pax8Integration}::uuid, ${f.partner}::uuid, ${f.survivor}::uuid, 'draft', 'direct', ${`d-s-${suffix}`})`);

    // --- third-party connections whose loser row is DISCARDED ---------------
    await db.execute(sql`
      INSERT INTO google_workspace_connections (id, org_id, customer_domain, admin_email, service_account_email, service_account_key) VALUES
        (${f.gwsL}::uuid,       ${f.loser}::uuid,    'loser.test',    'a@loser.test',    'sa@loser.test',    'k1'),
        (${randomUUID()}::uuid, ${f.survivor}::uuid, 'survivor.test', 'a@survivor.test', 'sa@survivor.test', 'k2')`);
    // m365_connections' dedupe key is `profile`, and the table's CHECK
    // constraints pin every other column to that profile — so the colliding
    // pair and the unique loser row have to be genuinely different connection
    // shapes rather than two copies of one row with the key column changed.
    await db.execute(sql`
      INSERT INTO m365_connections
        (id, org_id, client_id, profile, auth_mode, credential_domain, client_secret, tenant_id, permission_manifest_version) VALUES
        (${f.m365CollideL}::uuid, ${f.loser}::uuid,    'cid-l', 'legacy-direct', 'client-secret-legacy', 'legacy-direct', 'secret-l', ${randomUUID()}, 0),
        (${randomUUID()}::uuid,   ${f.survivor}::uuid, 'cid-s', 'legacy-direct', 'client-secret-legacy', 'legacy-direct', 'secret-s', ${randomUUID()}, 0)`);
    await db.execute(sql`
      INSERT INTO m365_connections
        (id, org_id, client_id, profile, auth_mode, credential_domain, vault_ref, credential_version, permission_manifest_version)
      VALUES (${f.m365OnlyL}::uuid, ${f.loser}::uuid, 'cid-l2', 'customer-graph-actions', 'application-certificate', 'customer-graph-actions', ${`vault-${suffix}`}, '1', 1)`);

    // --- duplicate-warning fodder: portal logins + external links -----------
    await db.execute(sql`
      INSERT INTO portal_users (id, org_id, email) VALUES
        (${f.portalDupL}::uuid,  ${f.loser}::uuid,    ${f.dupPortalEmail}),
        (${f.portalOnlyL}::uuid, ${f.loser}::uuid,    ${`solo-${suffix}@x.test`}),
        (${randomUUID()}::uuid,  ${f.survivor}::uuid, ${f.dupPortalEmail})`);
    await db.execute(sql`
      INSERT INTO organization_external_links (id, org_id, partner_id, system, external_id) VALUES
        (${f.extLinkL}::uuid,   ${f.loser}::uuid,    ${f.partner}::uuid, 'psa', ${`ext-l-${suffix}`}),
        (${randomUUID()}::uuid, ${f.survivor}::uuid, ${f.partner}::uuid, 'psa', ${`ext-s-${suffix}`})`);

    // --- post-pass fixups (array column + polymorphic target_id, no org_id) --
    await db.execute(sql`
      INSERT INTO partner_users (id, partner_id, user_id, role_id, org_access, org_ids) VALUES
        (${f.partnerUserBoth}::uuid,      ${f.partner}::uuid, ${f.userStaffer}::uuid, ${f.roleViewer}::uuid, 'selected', ARRAY[${f.loser}::uuid, ${f.survivor}::uuid]),
        (${f.partnerUserLoserOnly}::uuid, ${f.partner}::uuid, ${f.userMulti}::uuid,   ${f.roleViewer}::uuid, 'selected', ARRAY[${f.loser}::uuid])`);
    // Partner-owned policies (org_id NULL) so the POLICIES stay put and only
    // the organization-level ASSIGNMENTS have to move.
    await db.execute(sql`
      INSERT INTO configuration_policies (id, partner_id, name) VALUES
        (${f.policyCollide}::uuid, ${f.partner}::uuid, ${`Collide ${suffix}`}),
        (${f.policyMoves}::uuid,   ${f.partner}::uuid, ${`Moves ${suffix}`})`);
    await db.execute(sql`
      INSERT INTO config_policy_assignments (id, config_policy_id, level, target_id) VALUES
        (${f.assignmentCollideL}::uuid, ${f.policyCollide}::uuid, 'organization', ${f.loser}::uuid),
        (${randomUUID()}::uuid,         ${f.policyCollide}::uuid, 'organization', ${f.survivor}::uuid),
        (${f.assignmentMovesL}::uuid,   ${f.policyMoves}::uuid,   'organization', ${f.loser}::uuid)`);

    // --- append-only: must STILL be under the loser afterwards --------------
    await db.execute(sql`
      INSERT INTO ml_feedback_events (id, org_id, source_type, source_id, event_type, outcome, metadata, occurred_at)
      VALUES (${f.mlEventL}::uuid, ${f.loser}::uuid, 'alert', ${`src-${suffix}`}, 'ack', 'positive', '{}'::jsonb, now())`);
  });

  // `derived` policy (the engine never touches these): their org_id must ride
  // the (device_id|site_id, org_id) -> parent(id, org_id) ON UPDATE CASCADE FK.
  // Seeded through the SUPERUSER client, after the block above committed:
  // `breeze_app` — the role the engine and this file's `db` both connect as —
  // has DML revoked on both tables by design, since in production only the
  // export materializer (running as the owner) writes them. The
  // `breeze_partner_export_guard_direct_write` BEFORE trigger fires only at
  // pg_trigger_depth() = 0, so it fills org_id from the parent row here and
  // stays out of the way of the cascade during the merge.
  await getTestDb().execute(sql`
    INSERT INTO partner_export_device_material_state (device_id, org_id)
    VALUES (${f.deviceL}::uuid, ${f.loser}::uuid)`);
  await getTestDb().execute(sql`
    INSERT INTO partner_export_site_material_state (site_id, org_id)
    VALUES (${f.siteL}::uuid, ${f.loser}::uuid)`);

  // Written through the REAL audit service (which opens its own system-scope
  // transaction and drives the per-org hash-chain trigger), not a hand-rolled
  // INSERT — an audit row seeded any other way would not exercise the chain.
  await createAuditLog({
    orgId: f.loser,
    actorType: 'user',
    actorId: f.actor,
    actorEmail: f.actorEmail,
    action: 'test.pre_merge_event',
    resourceType: 'organization',
    resourceId: f.loser,
    result: 'success',
  });

  return f;
}

// ---------------------------------------------------------------------------
// blocks-merge (PAM) helpers
// ---------------------------------------------------------------------------

/**
 * `getTestDb().execute()` already returns the row array directly, not a
 * `.rows`-wrapped result — this is the same identity-cast idiom
 * `normalizedConfigPolicyRls.integration.test.ts` and several services use to
 * give the array an explicit element type at the call site.
 */
function rows<T = Record<string, unknown>>(result: unknown): T[] {
  return result as T[];
}

/**
 * Seeds one elevation_request -> pam_actuation -> pam_actuation_result chain
 * under `orgId` against `deviceId`. The elevation_request column list is
 * copied from pamDeviceMoveGuard.integration.test.ts's `createMoveFixture`
 * seed (~line 140-160) — the authoritative minimal-valid-row example for that
 * table. Runs through the raw superuser test client, the same way that suite
 * seeds its own PAM fixtures (no ambient db-access context required).
 */
async function seedPamEvidence(orgId: string, siteId: string, deviceId: string): Promise<void> {
  const [request] = await getTestDb().execute<{ id: string }>(sql`
    INSERT INTO elevation_requests (
      org_id, site_id, device_id, flow_type,
      subject_username, reason, target_executable_path,
      target_executable_hash, status, approved_at
    ) VALUES (
      ${orgId}::uuid, ${siteId}::uuid, ${deviceId}::uuid, 'uac_intercept',
      'fixture-user', 'PAM merge gauntlet fixture',
      'C:\\Program Files\\Fixture\\fixture.exe', ${'a'.repeat(64)},
      'approved', now()
    )
    RETURNING id`);
  if (!request) throw new Error('seedPamEvidence: elevation_request insert failed');

  const actuationId = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO pam_actuations (
      id, org_id, device_id, elevation_request_id, request_revision, generation,
      desired_state, observed_state, target_executable_path,
      target_executable_hash, subject_username
    ) VALUES (
      ${actuationId}::uuid, ${orgId}::uuid, ${deviceId}::uuid, ${request.id}::uuid, 1, 1,
      'active', 'verified_active', 'C:\\Program Files\\Fixture\\fixture.exe',
      ${'a'.repeat(64)}, 'fixture-user'
    )`);
  await getTestDb().execute(sql`
    INSERT INTO pam_actuation_results (
      observation_id, org_id, device_id, actuation_id, generation,
      result_kind, evidence, observed_at
    ) VALUES (
      gen_random_uuid(), ${orgId}::uuid, ${deviceId}::uuid, ${actuationId}::uuid, 1,
      'received', '{}'::jsonb, now()
    )`);
}

/**
 * Durable-snapshot pattern from the PAM suites: a comparable read of
 * everything the pre-fence blocks-merge refusal must leave untouched — the
 * loser's own row (status/settings, so a stray fence or unfence shows up)
 * plus its PAM evidence counts (so a partial walk that started moving rows
 * before refusing would show up too).
 */
async function snapshotOrgState(orgId: string): Promise<unknown> {
  const org = rows<{ status: string; settings: unknown }>(
    await getTestDb().execute(sql`
      SELECT status::text AS status, settings FROM organizations WHERE id = ${orgId}::uuid`),
  )[0];
  const pam = rows<{ pam_actuations: number; pam_actuation_results: number }>(
    await getTestDb().execute(sql`
      SELECT
        (SELECT count(*)::int FROM pam_actuations WHERE org_id = ${orgId}::uuid) AS pam_actuations,
        (SELECT count(*)::int FROM pam_actuation_results WHERE org_id = ${orgId}::uuid) AS pam_actuation_results`),
  )[0];
  return { org, pam };
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe('executeOrgMerge end-to-end against real Postgres', () => {
  let f: Fixture;
  let priorDrain: string | undefined;

  beforeEach(async () => {
    priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    f = await seedFixture();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
    else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
  });

  it('re-tenants every policy class, resolves every collision, and leaves a terminal shell', async () => {
    const result = await orgMergeModule.executeOrgMerge({
      loserOrgId: f.loser,
      survivorOrgId: f.survivor,
      partnerId: f.partner,
      performedBy: f.actor,
      performedByEmail: f.actorEmail,
    });

    // -----------------------------------------------------------------------
    // 1. Per-table summary. Asserted as a WHOLE object, not per-key: an
    //    unexpected extra table in the summary means the merge moved rows the
    //    fixture never accounted for, which is exactly as interesting as a
    //    missing one.
    // -----------------------------------------------------------------------
    expect(result.tables).toEqual({
      // composite-FK chain — parents and children move in separate statements,
      // which only works because Phase B runs SET CONSTRAINTS ALL DEFERRED
      quotes: { moved: 1, dropped: 0 },
      quote_lines: { moved: 3, dropped: 0 },
      quote_recipients: { moved: 1, dropped: 0 },
      quote_orders: { moved: 1, dropped: 0 },
      quote_order_lines: { moved: 1, dropped: 0 },
      invoices: { moved: 1, dropped: 0 },
      invoice_lines: { moved: 2, dropped: 0 },
      // keep-survivor: two collide, ai_budgets has no survivor row so it moves
      portal_branding: { moved: 0, dropped: 1 },
      org_ticket_settings: { moved: 0, dropped: 1 },
      ai_budgets: { moved: 1, dropped: 0 },
      // repoint-dedupe: one colliding + one unique loser row each
      tenant_variables: { moved: 1, dropped: 1 },
      m365_connections: { moved: 1, dropped: 1 },
      // custom, re-home-then-delete: the colliding loser row is dropped only
      // AFTER its NO ACTION / RESTRICT children are pointed at the survivor's
      // equivalent row. Under the old `repoint-dedupe` classification each of
      // these four raised 23503 and aborted the whole merge.
      plugin_installations: { moved: 0, dropped: 1 },
      playbook_definitions: { moved: 0, dropped: 1 },
      pam_signer_groups: { moved: 0, dropped: 1 },
      // custom, neutralize-never-delete: BOTH loser incidents move. The
      // colliding one keeps its actions and evidence and simply leaves the
      // partial index (source_ref -> NULL); `dropped: 0` is the assertion that
      // a case file is never destroyed to resolve a merge collision.
      incidents: { moved: 2, dropped: 0 },
      // The re-homed / repointed children of the four above.
      // `playbook_executions` is deliberately ABSENT: it is device-keyed
      // (device_id NOT NULL), so `breeze_cascade_device_org_id` had already
      // re-tenanted it by the time its own repoint ran — the same reason
      // `devices` and `device_group_memberships` are absent. Section 4b asserts
      // it really did land under the survivor, still pointing at the SURVIVOR's
      // playbook.
      snmp_devices: { moved: 1, dropped: 0 },
      pam_rules: { moved: 1, dropped: 0 },
      incident_actions: { moved: 1, dropped: 0 },
      // `moved: 0` is CORRECT and load-bearing, not a miss. discovered_assets
      // hangs off `sites` by an (site_id, org_id) -> sites(id, org_id) ON
      // UPDATE CASCADE FK, so the survivor-bound row was already re-tenanted
      // by the time its own repoint ran. `dropped: 1` is what matters: the
      // collision was resolved in the `resolve` pass, BEFORE the sites cascade
      // could drag the duplicate IP into the survivor and raise 23505 on
      // discovered_assets_org_ip_unique. Section 4 asserts the row landed.
      // Since the final review this is a `custom` table with a resolve HALF
      // (CUSTOM_RESOLVE_EXECUTORS) rather than a `repoint-dedupe` — the phase
      // split is unchanged, but the resolve half now re-homes snmp_devices /
      // network_monitors / unifi_* onto the survivor asset first.
      discovered_assets: { moved: 0, dropped: 1 },
      // custom
      contacts: { moved: 3, dropped: 0 },
      audit_baselines: { moved: 3, dropped: 0 },
      backup_configs: { moved: 1, dropped: 0 },
      api_keys: { moved: 1, dropped: 0 },
      enrollment_keys: { moved: 1, dropped: 0 },
      fleet_findings: { moved: 2, dropped: 0 },
      organization_users: { moved: 1, dropped: 3 },
      pax8_orders: { moved: 1, dropped: 1 },
      google_workspace_connections: { moved: 0, dropped: 1 },
      // plain repoints
      fleet_remediation_runs: { moved: 1, dropped: 0 },
      organization_external_links: { moved: 1, dropped: 0 },
      portal_users: { moved: 2, dropped: 0 },
      users: { moved: 1, dropped: 0 },
      roles: { moved: 1, dropped: 0 },
      sites: { moved: 2, dropped: 0 },
      device_groups: { moved: 1, dropped: 0 },
      // `devices` is deliberately ABSENT: it is itself a cascade child of
      // `sites` (devices_site_org_fk ON UPDATE CASCADE), so repointing the
      // sites moved it, and its own UPDATE matched nothing. Section 6 asserts
      // the device really did land under the survivor.
      // post-pass: partner_users.org_ids x2 + one repointed assignment;
      // the assignment that collided with the survivor's is dropped
      [POST_PASS_FIXUPS_SUMMARY_KEY]: { moved: 3, dropped: 1 },
    });
    // `summary` is documented as an alias of `tables`, not a second object.
    expect(result.summary).toBe(result.tables);

    // -----------------------------------------------------------------------
    // 2. Composite-FK chain: ids preserved, org_id moved, chain still joins.
    // -----------------------------------------------------------------------
    for (const [table, id] of [
      ['quotes', f.quote],
      ['quote_lines', f.quoteLine],
      ['quote_recipients', f.quoteRecipient],
      ['quote_orders', f.quoteOrder],
      ['quote_order_lines', f.quoteOrderLine],
      ['invoices', f.invoice],
      ['invoice_lines', f.invoiceLineA],
      ['invoice_lines', f.invoiceLineB],
    ] as const) {
      expect(await orgIdOf(table, 'id', id), `${table}:${id}`).toBe(f.survivor);
    }
    const chain = await query<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM quote_order_lines qol
        JOIN quote_orders qo ON qo.id = qol.order_id AND qo.quote_id = qol.quote_id AND qo.org_id = qol.org_id
        JOIN quotes q        ON q.id = qo.quote_id  AND q.org_id = qo.org_id
        JOIN quote_lines ql  ON ql.id = qol.quote_line_id AND ql.quote_id = qol.quote_id
       WHERE q.id = ${f.quote}::uuid AND q.org_id = ${f.survivor}::uuid`);
    expect(Number(chain[0]?.n)).toBe(1);

    // -----------------------------------------------------------------------
    // 3. keep-survivor: the SURVIVOR's row is the one that stayed, identified
    //    by id — a count of 1 would pass even if the loser's row had won.
    // -----------------------------------------------------------------------
    const branding = await query<{ id: string }>(
      sql`SELECT id FROM portal_branding WHERE org_id = ${f.survivor}::uuid`);
    expect(branding.map((r) => r.id)).toEqual([f.brandingS]);
    const ticketSettings = await query<{ id: string }>(
      sql`SELECT id FROM org_ticket_settings WHERE org_id = ${f.survivor}::uuid`);
    expect(ticketSettings.map((r) => r.id)).toEqual([f.ticketSettingsS]);
    // No survivor row existed, so the loser's singleton config MOVED intact.
    const budgets = await query<{ id: string }>(
      sql`SELECT id FROM ai_budgets WHERE org_id = ${f.survivor}::uuid`);
    expect(budgets.map((r) => r.id)).toEqual([f.aiBudgetL]);

    // -----------------------------------------------------------------------
    // 4. repoint-dedupe: colliding loser row gone, survivor's VALUE retained,
    //    unique loser row carried over.
    // -----------------------------------------------------------------------
    const vars = await query<{ key: string; value: string; id: string }>(sql`
      SELECT key, value, id FROM tenant_variables WHERE org_id = ${f.survivor}::uuid ORDER BY key`);
    expect(vars).toEqual([
      { key: 'loser_only', value: 'kept', id: f.tvOnlyL },
      { key: 'shared_key', value: 'survivor value', id: f.tvCollideS },
    ]);
    const assets = await query<{ id: string; ip: string }>(sql`
      SELECT id, host(ip_address) AS ip FROM discovered_assets WHERE org_id = ${f.survivor}::uuid ORDER BY ip`);
    expect(assets.map((r) => r.ip)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(assets.find((r) => r.ip === '10.0.0.2')?.id).toBe(f.assetOnlyL);
    // The SURVIVOR's asset is the one that stayed — asserted by id, because a
    // count of one would pass even if the loser's duplicate had won the race.
    expect(assets.find((r) => r.ip === '10.0.0.1')?.id).toBe(f.assetCollideS);
    expect(await countIn('discovered_assets', f.loser)).toBe(0);

    // Quote device-set descriptors are historical pricing prose. The merge
    // repoints the live org-owned ids when their rows survive, keeps both
    // stamps verbatim, and preserves an already-orphaned group as null-id plus
    // stamp rather than manufacturing a dangling cross-org reference.
    const quoteDescriptors = await query<{
      id: string; org_id: string; device_group_id: string | null;
      device_group_name: string | null; site_id: string | null; site_name: string | null;
    }>(sql`
      SELECT id, org_id, device_group_id, device_group_name, site_id, site_name
        FROM quote_lines WHERE quote_id = ${f.quote}::uuid ORDER BY name`);
    expect(quoteDescriptors).toEqual([
      {
        id: f.quoteOrphanLine, org_id: f.survivor,
        device_group_id: null, device_group_name: 'Deleted Quote Group stamped',
        site_id: null, site_name: null,
      },
      {
        id: f.quoteLine, org_id: f.survivor,
        device_group_id: f.groupL, device_group_name: 'L Group stamped',
        site_id: null, site_name: null,
      },
      {
        id: f.quoteSiteLine, org_id: f.survivor,
        device_group_id: null, device_group_name: null,
        site_id: f.siteL, site_name: 'L Main stamped',
      },
    ]);

    // -----------------------------------------------------------------------
    // 4b. The re-home-then-delete executors. Every child below hung off a
    //     colliding loser row through a NO ACTION / RESTRICT FK, so the merge
    //     completing AT ALL is half the assertion; the other half is that each
    //     child now points at the SURVIVOR's row BY ID rather than having been
    //     orphaned, deleted, or left dangling.
    // -----------------------------------------------------------------------
    const snmpChild = await query<{ org_id: string; asset_id: string }>(sql`
      SELECT org_id, asset_id FROM snmp_devices WHERE id = ${f.snmpChildL}::uuid`);
    expect(snmpChild).toEqual([{ org_id: f.survivor, asset_id: f.assetCollideS }]);

    const pluginLog = await query<{ installation_id: string }>(sql`
      SELECT installation_id FROM plugin_logs WHERE id = ${f.pluginLogL}::uuid`);
    expect(pluginLog).toEqual([{ installation_id: f.pluginInstallS }]);
    const installs = await query<{ id: string }>(sql`
      SELECT id FROM plugin_installations WHERE org_id = ${f.survivor}::uuid`);
    expect(installs.map((r) => r.id)).toEqual([f.pluginInstallS]);

    const playbookExec = await query<{ org_id: string; playbook_id: string }>(sql`
      SELECT org_id, playbook_id FROM playbook_executions WHERE id = ${f.playbookExecL}::uuid`);
    expect(playbookExec).toEqual([{ org_id: f.survivor, playbook_id: f.playbookCollideS }]);
    const playbooks = await query<{ id: string }>(sql`
      SELECT id FROM playbook_definitions WHERE org_id = ${f.survivor}::uuid`);
    expect(playbooks.map((r) => r.id)).toEqual([f.playbookCollideS]);

    const pamRule = await query<{ org_id: string; g: string }>(sql`
      SELECT org_id, match_signer_group_id AS g FROM pam_rules WHERE id = ${f.pamRuleL}::uuid`);
    expect(pamRule).toEqual([{ org_id: f.survivor, g: f.signerGroupCollideS }]);
    const signerGroups = await query<{ id: string }>(sql`
      SELECT id FROM pam_signer_groups WHERE org_id = ${f.survivor}::uuid`);
    expect(signerGroups.map((r) => r.id)).toEqual([f.signerGroupCollideS]);

    // -----------------------------------------------------------------------
    // 4c. incidents: neutralized, never deleted.
    // -----------------------------------------------------------------------
    // The partial-index carve-out: the NULL-source_ref loser incident survives
    // even though the survivor also has a NULL-source_ref 'alert' incident. And
    // the COLLIDING one survives too, which is the change — it used to be
    // deleted, taking its actions and evidence with it (or, once those existed,
    // aborting the merge on 23503).
    const incidents = await query<{ id: string; title: string; source_ref: string | null; summary: string | null }>(sql`
      SELECT id, title, source_ref, summary FROM incidents WHERE org_id = ${f.survivor}::uuid ORDER BY title`);
    expect(incidents.map((r) => r.title)).toEqual(['L dup', 'L manual', 'S dup', 'S manual']);
    expect(incidents.find((r) => r.title === 'L manual')?.id).toBe(f.incidentNullRefL);
    const neutralized = incidents.find((r) => r.id === f.incidentCollideL)!;
    // Out of the partial index...
    expect(neutralized.source_ref).toBeNull();
    // ...but the reference it lost is recorded where an operator can find it.
    expect(neutralized.summary).toContain(`alert:${f.incidentSourceRef}`);
    // The survivor's own source_ref is untouched — clearing THAT instead would
    // break its EDR de-dup hook and leave the loser's row in the index.
    expect(incidents.find((r) => r.title === 'S dup')?.source_ref).toBe(f.incidentSourceRef);
    // The NOT NULL NO ACTION child a delete would have tripped over is still
    // attached to the same incident, re-tenanted.
    const incidentAction = await query<{ org_id: string; incident_id: string }>(sql`
      SELECT org_id, incident_id FROM incident_actions WHERE id = ${f.incidentActionL}::uuid`);
    expect(incidentAction).toEqual([{ org_id: f.survivor, incident_id: f.incidentCollideL }]);

    // -----------------------------------------------------------------------
    // 5. custom executors.
    // -----------------------------------------------------------------------
    // contacts: the ORG-level primary is demoted, the SITE-level primary is
    // not (its partial unique is keyed on site_id, which never collides).
    const contacts = await query<{ id: string; is_primary: boolean; site_id: string | null }>(sql`
      SELECT id, is_primary, site_id FROM contacts WHERE org_id = ${f.survivor}::uuid ORDER BY name`);
    expect(contacts).toHaveLength(4);
    const byId = new Map(contacts.map((c) => [c.id, c]));
    expect(byId.get(f.contactOrgPrimaryL)?.is_primary).toBe(false);
    expect(byId.get(f.contactOrgPrimaryS)?.is_primary).toBe(true);
    expect(byId.get(f.contactSitePrimaryL)?.is_primary).toBe(true);
    expect(byId.get(f.contactSitePrimaryL)?.site_id).toBe(f.siteL);
    expect(byId.get(f.contactPlainL)?.is_primary).toBe(false);

    // audit_baselines: never deleted — deactivated on an (org, os_type)
    // collision and renamed on a (name, os_type, profile) collision.
    const baselines = await query<{ id: string; name: string; os_type: string; is_active: boolean }>(sql`
      SELECT id, name, os_type, is_active FROM audit_baselines WHERE org_id = ${f.survivor}::uuid ORDER BY os_type, name`);
    expect(baselines).toHaveLength(5);
    expect(baselines.filter((b) => b.os_type === 'windows' && b.is_active)).toHaveLength(1);
    expect(baselines.find((b) => b.id === f.baselineWinL)?.is_active).toBe(false);
    expect(baselines.find((b) => b.id === f.baselineMacL)?.is_active).toBe(true);
    // Rename path: the fixture DB has no `audit_baselines_org_name_os_profile_uniq`
    // (it only exists on pre-squash droplets), so the collision cannot raise
    // 23505 here — the assertion is on the renamed value itself, which is what
    // would keep that index satisfied in production.
    expect(baselines.find((b) => b.id === f.baselineSharedL)?.name)
      .toBe(`Shared (merged ${f.suffix})`);

    // backup_configs: default flag cleared, credentials row never deleted.
    const backups = await query<{ id: string; is_default: boolean }>(sql`
      SELECT id, is_default FROM backup_configs WHERE org_id = ${f.survivor}::uuid ORDER BY name`);
    expect(backups).toEqual([
      { id: f.backupDefaultL, is_default: false },
      { id: f.backupDefaultS, is_default: true },
    ]);

    // api_keys / enrollment_keys: the loser's credential is revoked BEFORE the
    // repoint, so the survivor's own live credential is untouched.
    const keys = await query<{ id: string; status: string }>(sql`
      SELECT id, status::text AS status FROM api_keys WHERE org_id = ${f.survivor}::uuid ORDER BY name`);
    expect(keys).toEqual([
      { id: f.apiKeyL, status: 'revoked' },
      { id: f.apiKeyS, status: 'active' },
    ]);
    const enroll = await query<{ id: string; expired: boolean }>(sql`
      SELECT id, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
        FROM enrollment_keys WHERE org_id = ${f.survivor}::uuid ORDER BY name`);
    expect(enroll).toEqual([
      { id: f.enrollKeyL, expired: true },
      { id: f.enrollKeyS, expired: false },
    ]);

    // fleet_findings: the colliding loser finding is RESOLVED (leaves the
    // `WHERE resolved_at IS NULL` partial index) rather than deleted, and both
    // of the children a DELETE would have cascaded away are still there,
    // re-tenanted.
    const findings = await query<{ id: string; status: string; resolved: boolean; reason: string | null }>(sql`
      SELECT id, status, (resolved_at IS NOT NULL) AS resolved, resolution_reason AS reason
        FROM fleet_findings WHERE org_id = ${f.survivor}::uuid ORDER BY title`);
    expect(findings).toEqual([
      { id: f.findingCollideL, status: 'resolved', resolved: true, reason: 'org_merge' },
      { id: f.findingOnlyL, status: 'open', resolved: false, reason: null },
      { id: f.findingS, status: 'open', resolved: false, reason: null },
    ]);
    expect(await orgIdOf('fleet_remediation_runs', 'id', f.remediationRunL)).toBe(f.survivor);
    const findingDevices = await query<{ org_id: string; device_id: string }>(sql`
      SELECT org_id, device_id FROM fleet_finding_devices WHERE finding_id = ${f.findingCollideL}::uuid`);
    expect(findingDevices).toEqual([{ org_id: f.survivor, device_id: f.deviceL }]);

    // organization_users: exactly ONE membership row per user under the
    // survivor (permissions.ts resolveOrgAxis has no ORDER BY, so two rows
    // would make the resolved role nondeterministic).
    const memberships = await query<{
      user_id: string; role_id: string; site_ids: string[] | null; device_group_ids: string[] | null;
    }>(sql`
      SELECT user_id, role_id, site_ids, device_group_ids
        FROM organization_users WHERE org_id = ${f.survivor}::uuid ORDER BY user_id`);
    expect(memberships).toHaveLength(3);
    const membershipFor = (userId: string) => memberships.find((m) => m.user_id === userId);

    const staffer = membershipFor(f.userStaffer)!;
    expect(staffer.role_id).toBe(f.roleViewer);
    expect([...(staffer.site_ids ?? [])].sort()).toEqual([f.siteL, f.siteS].sort());
    expect([...(staffer.device_group_ids ?? [])].sort()).toEqual([f.groupL, f.groupS].sort());

    // The multi-row case: BOTH loser memberships fold into the single survivor
    // one. site_ids is the union of all three lists; device_group_ids goes
    // UNRESTRICTED (NULL) because one loser row was unrestricted — narrowing it
    // to the survivor's list would silently revoke access the user had.
    const multi = membershipFor(f.userMulti)!;
    expect(multi.role_id).toBe(f.roleViewer); // survivor's role wins over the loser's Org Admin
    expect([...(multi.site_ids ?? [])].sort()).toEqual([f.siteL, f.siteL2, f.siteS].sort());
    expect(multi.device_group_ids).toBeNull();

    // The loser-only membership simply moved, arrays and role untouched.
    const onlyL = membershipFor(f.userLoserOnly)!;
    expect(onlyL.role_id).toBe(f.roleOrgL);
    expect(onlyL.site_ids).toBeNull();

    // pax8_orders: only the colliding mutable DIRECT draft is discarded.
    const pax8 = await query<{ id: string }>(sql`
      SELECT id FROM pax8_orders WHERE org_id = ${f.survivor}::uuid ORDER BY dedupe_key`);
    expect(pax8.map((r) => r.id)).toContain(f.pax8QuoteDraftL);
    expect(pax8.map((r) => r.id)).not.toContain(f.pax8DirectDraftL);
    expect(pax8).toHaveLength(2);

    // -----------------------------------------------------------------------
    // 6. Devices: the device moves, and the rows that ride triggers/FKs rather
    //    than the registry walk move WITH it.
    // -----------------------------------------------------------------------
    expect(await orgIdOf('devices', 'id', f.deviceL)).toBe(f.survivor);
    expect(result.tables.devices).toBeUndefined(); // moved by the sites cascade
    expect(await orgIdOf('sites', 'id', f.siteL)).toBe(f.survivor);
    expect(await orgIdOf('sites', 'id', f.siteL2)).toBe(f.survivor);
    expect(await orgIdOf('device_groups', 'id', f.groupL)).toBe(f.survivor);
    // device_group_memberships / partner_export_*_material_state are absent
    // from the summary ON PURPOSE: `breeze_cascade_device_org_id` and the
    // (device_id, org_id) -> devices(id, org_id) ON UPDATE CASCADE FK have
    // already re-tenanted them by the time the walk reaches them, so their own
    // UPDATE matches zero rows. Asserting BOTH facts is the point — a summary
    // entry appearing here would mean the trigger stopped firing.
    expect(result.tables.device_group_memberships).toBeUndefined();
    expect(result.tables.partner_export_device_material_state).toBeUndefined();
    const membership = await query<{ org_id: string }>(sql`
      SELECT org_id FROM device_group_memberships WHERE device_id = ${f.deviceL}::uuid`);
    expect(membership).toEqual([{ org_id: f.survivor }]);
    const materialState = await query<{ org_id: string }>(sql`
      SELECT org_id FROM partner_export_device_material_state WHERE device_id = ${f.deviceL}::uuid`);
    expect(materialState).toEqual([{ org_id: f.survivor }]);
    // follows-parent: no org_id of its own, still bound to the moved device.
    const command = await query<{ device_id: string }>(sql`
      SELECT device_id FROM device_commands WHERE id = ${f.deviceCommand}::uuid`);
    expect(command).toEqual([{ device_id: f.deviceL }]);

    // -----------------------------------------------------------------------
    // 7. Post-pass fixups: an org id inside an array column and a polymorphic
    //    target_id with no FK — neither reachable by any `org_id` UPDATE.
    // -----------------------------------------------------------------------
    const partnerUsers = await query<{ id: string; org_ids: string[] }>(sql`
      SELECT id, org_ids FROM partner_users WHERE partner_id = ${f.partner}::uuid ORDER BY id`);
    const orgIdsFor = (id: string) => partnerUsers.find((p) => p.id === id)?.org_ids ?? [];
    // The staffer already had BOTH orgs — array_replace would have produced a
    // duplicate; the unnest/array_agg pass collapses it.
    expect(orgIdsFor(f.partnerUserBoth)).toEqual([f.survivor]);
    expect(orgIdsFor(f.partnerUserLoserOnly)).toEqual([f.survivor]);
    const assignments = await query<{ id: string; target_id: string }>(sql`
      SELECT id, target_id FROM config_policy_assignments ORDER BY id`);
    expect(assignments.map((a) => a.id)).not.toContain(f.assignmentCollideL);
    expect(assignments.find((a) => a.id === f.assignmentMovesL)?.target_id).toBe(f.survivor);

    // -----------------------------------------------------------------------
    // 8. Warnings — every class the engine can emit, provoked by the fixture.
    // -----------------------------------------------------------------------
    const warnings = result.warnings.join('\n');
    expect(warnings).toContain(`duplicate portal_users email under the survivor: '${f.dupPortalEmail}' now has 2 portal logins`);
    expect(warnings).toContain("duplicate organization_external_links system under the survivor: 'psa' now has 2 links");
    expect(warnings).toContain('discarded 1 third-party integration connection from google_workspace_connections');
    expect(warnings).toContain('discarded 1 third-party integration connection from m365_connections');
    expect(warnings).toContain('contacts: demoted 1 primary contact');
    expect(warnings).toContain('backup_configs: cleared the default flag on 1 backup destination');
    expect(warnings).toContain('audit_baselines: deactivated 1 baseline');
    expect(warnings).toContain('audit_baselines: renamed 1 baseline');
    expect(warnings).toContain('api_keys: revoked 1 API key');
    expect(warnings).toContain('enrollment_keys: expired 1 enrollment key');
    expect(warnings).toContain('fleet_findings: auto-resolved 1 live finding');
    expect(warnings).toContain('organization_users: folded 3 duplicate membership into 2 existing survivor membership');
    expect(warnings).toContain(`organization_users role conflict for ${f.multiEmail}`);
    expect(warnings).toContain("role 'Org Admin' from the merged-away org was discarded, survivor role 'Org Viewer' kept");
    expect(warnings).toContain('pax8_orders: discarded 1 unsubmitted direct draft order');
    // The re-home-then-delete executors: each names BOTH the drop and the
    // children it carried across, because "1 row dropped" alone tells an
    // operator nothing about where their monitoring/history went.
    expect(warnings).toContain('discovered_assets: dropped 1 duplicate discovered asset');
    expect(warnings).toContain('snmp_devices: 1');
    expect(warnings).toContain('plugin_installations: dropped 1 duplicate plugin installation');
    expect(warnings).toContain('plugin_logs: 1');
    expect(warnings).toContain('playbook_definitions: dropped 1 duplicate playbook');
    expect(warnings).toContain('playbook_executions: 1');
    expect(warnings).toContain('pam_signer_groups: dropped 1 duplicate signer group');
    expect(warnings).toContain('pam_rules: 1');
    expect(warnings).toContain('incidents: cleared the source reference on 1 incident');
    // The two keep-survivor/dedupe drops that are NOT integration connections
    // must not be reported as discarded connections.
    expect(warnings).not.toContain('from portal_branding');
    expect(warnings).not.toContain('from tenant_variables');
    // Each note appears exactly ONCE. The registry is now walked twice
    // (resolve, then move); a custom executor accidentally run in both passes
    // would double every demotion/revocation — silently, since the second run's
    // predicates all match zero rows and the counts would still look right.
    for (const once of ['api_keys: revoked', 'contacts: demoted', 'fleet_findings: auto-resolved']) {
      expect(result.warnings.filter((w) => w.includes(once)), once).toHaveLength(1);
    }

    // -----------------------------------------------------------------------
    // 9. The merge record.
    // -----------------------------------------------------------------------
    const events = await query<{
      id: string; partner_id: string; loser_org_id: string; loser_org_name: string;
      survivor_org_id: string; actor_user_id: string; summary: { tables: unknown; warnings: unknown };
    }>(sql`SELECT * FROM org_merge_events`);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(result.mergeEventId);
    expect(events[0]!.partner_id).toBe(f.partner);
    expect(events[0]!.loser_org_id).toBe(f.loser);
    expect(events[0]!.loser_org_name).toBe('Loser Co');
    expect(events[0]!.survivor_org_id).toBe(f.survivor);
    expect(events[0]!.actor_user_id).toBe(f.actor);
    // The persisted summary is exactly the {tables, warnings} shape the job,
    // the status route and the UI consume — no extra keys, nothing dropped.
    expect(Object.keys(events[0]!.summary).sort()).toEqual(['tables', 'warnings']);
    expect(events[0]!.summary.tables).toEqual(result.tables);
    expect(events[0]!.summary.warnings).toEqual(result.warnings);

    // -----------------------------------------------------------------------
    // 10. The loser is a terminal shell, and it is EMPTY except for the
    //     append-only rows that cannot be re-tenanted.
    // -----------------------------------------------------------------------
    const shell = await query<{ status: string; deleted: boolean; prior: string | null }>(sql`
      SELECT status::text AS status, (deleted_at IS NOT NULL) AS deleted,
             settings->>'mergePriorStatus' AS prior
        FROM organizations WHERE id = ${f.loser}::uuid`);
    expect(shell[0]).toEqual({ status: 'merging', deleted: true, prior: 'active' });
    const survivorRow = await query<{ status: string; deleted: boolean }>(sql`
      SELECT status::text AS status, (deleted_at IS NOT NULL) AS deleted
        FROM organizations WHERE id = ${f.survivor}::uuid`);
    expect(survivorRow[0]).toEqual({ status: 'active', deleted: false });

    for (const table of MUST_BE_EMPTY_UNDER_LOSER) {
      expect(await countIn(table, f.loser), `${table} still has loser rows`).toBe(0);
    }
    for (const table of APPEND_ONLY_STAYS_UNDER_LOSER) {
      expect(await countIn(table, f.loser), `${table} lost its append-only loser rows`).toBeGreaterThan(0);
    }
    // Specifically: the audit row written through the real audit service is
    // still tenanted to the merged-away org (it dies with the shell in Phase C,
    // which previewOrgMerge discloses up front).
    const auditRows = await query<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_logs
       WHERE org_id = ${f.loser}::uuid AND action = 'test.pre_merge_event'`);
    expect(Number(auditRows[0]?.n)).toBe(1);
    expect(await countIn('ml_feedback_events', f.loser)).toBe(1);

    // -----------------------------------------------------------------------
    // 11. The pair is no longer mergeable.
    // -----------------------------------------------------------------------
    await expect(
      orgMergeModule.executeOrgMerge({
        loserOrgId: f.loser,
        survivorOrgId: f.survivor,
        partnerId: f.partner,
        performedBy: f.actor,
      }),
    ).rejects.toThrow(MergeValidationError);
    // And the failed re-run must not have re-fenced or re-stamped anything.
    expect(await countIn('quotes', f.loser)).toBe(0);
    const eventsAfter = await query<{ n: number }>(sql`SELECT count(*)::int AS n FROM org_merge_events`);
    expect(Number(eventsAfter[0]?.n)).toBe(1);
  }, 180_000);

  it('rolls the entire merge back and unfences the loser when a policy throws mid-walk', async () => {
    // Fail on the THIRD table of the MOVE pass that actually re-tenants rows —
    // not a fixed table name, and deliberately not the resolve pass. By then
    // the whole collision-resolution pass has DELETEd rows and at least two
    // tables have been repointed, so the rollback assertions below are about
    // undoing real work in both passes rather than aborting a transaction that
    // had not done anything yet. Driven through the module namespace because
    // the engine calls `self.runPolicy` for exactly this reason.
    const realRunPolicy = orgMergeModule.runPolicy;
    let resolved = 0;
    let moved = 0;
    let failedTable = '';
    const boom = 'simulated policy failure (merge gauntlet)';
    vi.spyOn(orgMergeModule, 'runPolicy').mockImplementation(async (table, policy, loser, survivor, phase) => {
      const outcome = await realRunPolicy(table, policy, loser, survivor, phase);
      if (outcome.dropped > 0) resolved++;
      if (phase === 'move' && (outcome.moved > 0 || outcome.dropped > 0)) {
        moved++;
        if (moved >= 3) {
          failedTable = table;
          throw new Error(boom);
        }
      }
      return outcome;
    });

    const epochsBefore = await query<{ id: string; auth_epoch: number }>(sql`
      SELECT id, auth_epoch FROM users WHERE partner_id = ${f.partner}::uuid ORDER BY id`);

    await expect(
      orgMergeModule.executeOrgMerge({
        loserOrgId: f.loser,
        survivorOrgId: f.survivor,
        partnerId: f.partner,
        performedBy: f.actor,
        performedByEmail: f.actorEmail,
      }),
    ).rejects.toThrow(boom);
    expect(moved).toBe(3);
    expect(failedTable).not.toBe('');
    // The resolve pass really did delete things before the throw — otherwise
    // "everything is still under the loser" would be a tautology.
    expect(resolved).toBeGreaterThanOrEqual(4);

    // The loser is back at its pre-merge status with the fence bookkeeping
    // removed — not stranded in `merging` for the Task-4 sweeper to find.
    const shell = await query<{ status: string; deleted: boolean; hasPrior: boolean }>(sql`
      SELECT status::text AS status, (deleted_at IS NOT NULL) AS deleted,
             (settings ? 'mergePriorStatus') AS "hasPrior"
        FROM organizations WHERE id = ${f.loser}::uuid`);
    expect(shell[0]).toEqual({ status: 'active', deleted: false, hasPrior: false });

    // Every fixture row is still under the loser — including the ones the walk
    // had already moved before the throw.
    for (const table of MUST_BE_EMPTY_UNDER_LOSER) {
      expect(await countIn(table, f.loser), `${table} was not rolled back`).toBeGreaterThan(0);
    }
    // The rows the RESOLVE pass deleted are back, by id — a count alone would
    // pass even if a different row had been restored.
    for (const [table, id] of [
      ['portal_branding', f.brandingL],
      ['org_ticket_settings', f.ticketSettingsL],
      ['tenant_variables', f.tvCollideL],
      ['discovered_assets', f.assetCollideL],
      ['m365_connections', f.m365CollideL],
      ['google_workspace_connections', f.gwsL],
    ] as const) {
      expect(await orgIdOf(table, 'id', id), `${table}:${id} delete was not rolled back`).toBe(f.loser);
    }
    // The re-home-then-delete executors run in the MOVE pass, so whether they
    // reached the failing table is timing-dependent — but if they DID run, both
    // halves must be undone together. A rolled-back delete with a committed
    // child re-home would leave the child pointing into the survivor's org.
    const rehomeChildState = await query<{ asset: string; install: string; playbook: string; signer: string }>(sql`
      SELECT (SELECT asset_id FROM snmp_devices WHERE id = ${f.snmpChildL}::uuid) AS asset,
             (SELECT installation_id FROM plugin_logs WHERE id = ${f.pluginLogL}::uuid) AS install,
             (SELECT playbook_id FROM playbook_executions WHERE id = ${f.playbookExecL}::uuid) AS playbook,
             (SELECT match_signer_group_id FROM pam_rules WHERE id = ${f.pamRuleL}::uuid) AS signer`);
    expect(rehomeChildState).toEqual([{
      asset: f.assetCollideL,
      install: f.pluginInstallL,
      playbook: f.playbookCollideL,
      signer: f.signerGroupCollideL,
    }]);
    // Spot-check the two collision classes that MUTATE rather than move: a
    // committed demotion/resolution would be just as broken as a committed
    // repoint, and neither shows up in a row count.
    const contactState = await query<{ is_primary: boolean }>(sql`
      SELECT is_primary FROM contacts WHERE id = ${f.contactOrgPrimaryL}::uuid`);
    expect(contactState).toEqual([{ is_primary: true }]);
    const keyState = await query<{ status: string }>(sql`
      SELECT status::text AS status FROM api_keys WHERE id = ${f.apiKeyL}::uuid`);
    expect(keyState).toEqual([{ status: 'active' }]);
    const findingState = await query<{ resolved: boolean }>(sql`
      SELECT (resolved_at IS NOT NULL) AS resolved FROM fleet_findings WHERE id = ${f.findingCollideL}::uuid`);
    expect(findingState).toEqual([{ resolved: false }]);
    // incidents resolves its collision the same way (neutralize, never delete),
    // so its rollback is invisible in a row count too: the cleared source_ref
    // must come back, or a failed merge has silently broken the survivor org's
    // EDR de-duplication for that finding.
    const incidentState = await query<{ source_ref: string | null }>(sql`
      SELECT source_ref FROM incidents WHERE id = ${f.incidentCollideL}::uuid`);
    expect(incidentState).toEqual([{ source_ref: f.incidentSourceRef }]);
    // Post-pass fixups roll back too.
    const partnerUsers = await query<{ org_ids: string[] }>(sql`
      SELECT org_ids FROM partner_users WHERE id = ${f.partnerUserLoserOnly}::uuid`);
    expect(partnerUsers).toEqual([{ org_ids: [f.loser] }]);

    // No merge was recorded.
    const events = await query<{ n: number }>(sql`SELECT count(*)::int AS n FROM org_merge_events`);
    expect(Number(events[0]?.n)).toBe(0);

    // The failure audit is written ORG-LESS: an audit scoped to the loser would
    // be destroyed with it if the retried merge ever succeeds.
    const failureAudits = await query<{ org_id: string | null; result: string; details: { error?: string } }>(sql`
      SELECT org_id, result::text AS result, details FROM audit_logs WHERE action = 'org.merge.failed'`);
    expect(failureAudits).toHaveLength(1);
    expect(failureAudits[0]!.org_id).toBeNull();
    expect(failureAudits[0]!.result).toBe('failure');
    expect(failureAudits[0]!.details.error).toContain(boom);

    // Documented NON-rollback: Phase A runs in its own transactions, so the
    // auth-epoch bump that logged the loser org's users out survives a failed
    // merge. That is deliberate (fail closed), and pinning it here stops a
    // future refactor from quietly folding the fence into Phase B.
    const epochsAfter = await query<{ id: string; auth_epoch: number }>(sql`
      SELECT id, auth_epoch FROM users WHERE partner_id = ${f.partner}::uuid ORDER BY id`);
    const before = new Map(epochsBefore.map((u) => [u.id, Number(u.auth_epoch)]));
    for (const user of [f.userLoserOnly, f.userStaffer, f.userMulti]) {
      expect(Number(epochsAfter.find((u) => u.id === user)?.auth_epoch), user)
        .toBe(before.get(user)! + 1);
    }
    // The actor is attached to neither org, so their session is untouched.
    expect(Number(epochsAfter.find((u) => u.id === f.actor)?.auth_epoch))
      .toBe(before.get(f.actor)!);
  }, 180_000);

  /**
   * The window `stampTerminalShell` opens, closed end-to-end.
   *
   * A process death between Phase B's commit and the follow-up stamp leaves an
   * ALREADY-EMPTIED loser at `status='merging'` with `deleted_at IS NULL` and
   * `settings.mergePriorStatus` still stashed — byte-for-byte the state the
   * offboarding sweeper's case 2 recognises as "fence set, job died" and
   * UNFENCES. Doing that here would restore a ghost org to `active` whose every
   * row now lives under the survivor, permanently: `loadAndValidate` would let
   * an admin try to re-merge it, the merge would move nothing, and the partner
   * would have a duplicate customer they cannot get rid of.
   *
   * The `org_merge_events` row Phase B wrote is the only thing separating the
   * two states, so this drives the real sweeper against the real torn state and
   * asserts it takes the stamp-and-erase path, not the unfence path. The
   * fixture is backdated past BOTH windows (case 2's 2h and case 3's 1h) on
   * purpose: without the guard the org qualifies for both, case 2 runs first,
   * and this test goes red on `status`.
   */
  it('sweeper finishes a merge whose terminal-shell stamp never landed, instead of resurrecting it', async () => {
    const stampSpy = vi
      .spyOn(orgMergeModule, 'stampTerminalShell')
      .mockResolvedValue(undefined);

    await orgMergeModule.executeOrgMerge({
      loserOrgId: f.loser,
      survivorOrgId: f.survivor,
      partnerId: f.partner,
      performedBy: f.actor,
      performedByEmail: f.actorEmail,
    });
    expect(stampSpy).toHaveBeenCalledTimes(1);
    stampSpy.mockRestore();

    // The torn state, exactly: merged (event written, loser emptied) but not
    // stamped, and still carrying the fence's prior-status stash.
    const torn = await query<{ status: string; deleted: boolean; hasPrior: boolean }>(sql`
      SELECT status::text AS status, (deleted_at IS NOT NULL) AS deleted,
             (settings ? 'mergePriorStatus') AS "hasPrior"
        FROM organizations WHERE id = ${f.loser}::uuid`);
    expect(torn[0]).toEqual({ status: 'merging', deleted: false, hasPrior: true });
    expect(await countIn('quotes', f.loser)).toBe(0);
    const events = await query<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM org_merge_events WHERE loser_org_id = ${f.loser}::uuid`);
    expect(Number(events[0]?.n)).toBe(1);

    // Past case 2's 2h window AND case 3's 1h one. Superuser client: `breeze_app`
    // could do this too, but going around the app pool keeps the backdate from
    // interacting with the export triggers at all.
    await getTestDb().execute(sql`
      UPDATE organizations SET updated_at = now() - interval '3 hours' WHERE id = ${f.loser}::uuid`);

    const result = await sweepOffboardingTenants();
    expect(result.mergeShellsStamped).toBe(1);
    expect(result.mergeUnfenced).toBe(0);
    expect(result.failures).toBe(0);

    // Stamped, NOT resurrected. `status` is the assertion that fails if the
    // case-2 guard is ever dropped.
    const healed = await query<{ status: string; deleted: boolean }>(sql`
      SELECT status::text AS status, (deleted_at IS NOT NULL) AS deleted
        FROM organizations WHERE id = ${f.loser}::uuid`);
    expect(healed[0]).toEqual({ status: 'merging', deleted: true });
    // Still empty — the sweeper must not have moved anything back.
    expect(await countIn('quotes', f.loser)).toBe(0);
    expect(await orgIdOf('quotes', 'id', f.quote)).toBe(f.survivor);

    // Handed to the erasure queue under the idempotent jobId.
    const job = await getTenantErasureQueue().getJob(`tenant-erasure-${f.loser}`);
    expect(job, 'the merged-away shell was never handed to tenant erasure').toBeTruthy();
    expect((job!.data as { orgId: string }).orgId).toBe(f.loser);

    // Org-less audit, like every other merge record: an audit scoped to the
    // loser would be destroyed by the erasure this very sweep just queued.
    await eventually(async () => {
      const audits = await query<{ org_id: string | null; resource_id: string }>(sql`
        SELECT org_id, resource_id FROM audit_logs WHERE action = 'org.merge.stamped_by_sweeper'`);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.org_id).toBeNull();
      expect(audits[0]!.resource_id).toBe(f.loser);
    });
    // And emphatically not the unfence audit.
    const unfenced = await query<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_logs WHERE action = 'org.merge.unfenced_by_sweeper'`);
    expect(Number(unfenced[0]?.n)).toBe(0);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// blocks-merge: durable PAM evidence
// ---------------------------------------------------------------------------

describe('blocks-merge: durable PAM evidence refuses the merge', () => {
  let f: Fixture;

  beforeEach(async () => {
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    f = await seedFixture();
  });

  afterEach(() => vi.restoreAllMocks());

  it('preview verdict is blocked with per-table counts and the refusal text', async () => {
    await seedPamEvidence(f.loser, f.siteL, f.deviceL);
    const preview = await orgMergeModule.previewOrgMerge(f.loser, f.survivor, f.partner);
    expect(preview.verdict).toBe('blocked');
    expect(preview.tables).toEqual(
      expect.arrayContaining([
        { table: 'pam_actuations', policy: 'blocks-merge', loserRows: 1, wouldDrop: 0 },
        { table: 'pam_actuation_results', policy: 'blocks-merge', loserRows: 1, wouldDrop: 0 },
      ]),
    );
    expect(preview.blockers).toHaveLength(1);
    expect(preview.blockers[0]).toContain('durable PAM lifecycle evidence');
    expect(preview.blockers[0]).toContain('Audit-admin retention is not a merge mechanism');
  });

  it('executeOrgMerge refuses pre-fence: typed error, loser undisturbed, nothing merged, org.merge.failed audited', async () => {
    await seedPamEvidence(f.loser, f.siteL, f.deviceL);
    const before = await snapshotOrgState(f.loser);
    // Spy WITHOUT stubbing (must still call through) — a snapshot-equality
    // check alone cannot distinguish "never fenced" from "fenced then
    // perfectly unfenced", since fenceLoser/unfenceLoser round-trip status
    // and settings back to their prior values. This is the discriminating
    // assertion: it proves fenceLoser was never invoked at all.
    const fence = vi.spyOn(orgMergeModule, 'fenceLoser');
    await expect(
      orgMergeModule.executeOrgMerge({
        loserOrgId: f.loser, survivorOrgId: f.survivor, partnerId: f.partner,
        performedBy: f.actor, performedByEmail: f.actorEmail,
      }),
    ).rejects.toMatchObject({ code: 'ORG_MERGE_BLOCKED', name: 'OrgMergeBlockedError' });
    // Snapshot equality alone is not proof of "never fenced" (see the spy
    // assertion below for that); this only proves the loser's observable
    // state is unchanged.
    expect(await snapshotOrgState(f.loser)).toEqual(before);
    expect(fence).not.toHaveBeenCalled();
    const events = await getTestDb().execute(sql`SELECT 1 FROM org_merge_events WHERE loser_org_id = ${f.loser}::uuid`);
    expect(rows(events)).toHaveLength(0);

    // Pre-fence refusal still writes the same org-less failure audit a
    // Phase-B rollback would (see the big describe's in-tx-failure test
    // above) — the offboarding sweeper and any operator tooling reading
    // `org.merge.failed` must see this refusal too, not just a rolled-back
    // one.
    const failureAudits = await query<{
      org_id: string | null;
      result: string;
      details: { error?: string; blockers?: Array<{ table: string; loserRows: number }> };
    }>(sql`
      SELECT org_id, result::text AS result, details FROM audit_logs WHERE action = 'org.merge.failed'`);
    expect(failureAudits).toHaveLength(1);
    expect(failureAudits[0]!.org_id).toBeNull();
    expect(failureAudits[0]!.result).toBe('failure');
    expect(failureAudits[0]!.details.error).toContain('durable PAM lifecycle evidence');
    // seedPamEvidence seeds exactly one row per table under the loser;
    // collectMergeBlockers sorts alphabetically by table name.
    expect(failureAudits[0]!.details.blockers).toEqual([
      { table: 'pam_actuation_results', loserRows: 1 },
      { table: 'pam_actuations', loserRows: 1 },
    ]);
  });

  it("the refusal is the typed OrgMergeBlockedError, never the trigger's raw 23514", async () => {
    await seedPamEvidence(f.loser, f.siteL, f.deviceL);
    const caught: unknown = await orgMergeModule
      .executeOrgMerge({
        loserOrgId: f.loser, survivorOrgId: f.survivor, partnerId: f.partner,
        performedBy: f.actor, performedByEmail: f.actorEmail,
      })
      .catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(orgMergeModule.OrgMergeBlockedError);
    const asError = caught as { code?: string; cause?: { code?: string } };
    expect(asError.code).toBe('ORG_MERGE_BLOCKED');
    // devices_pam_history_move_guard's raw trigger error must never surface —
    // that would mean the typed pre-fence refusal ran AFTER the registry walk
    // reached the guard instead of before it (an ordering regression).
    expect(asError.code).not.toBe('23514');
    expect(asError.cause?.code).not.toBe('23514');
  });

  it('in-transaction recheck refuses, rolls back, and unfences (TOCTOU path)', async () => {
    await seedPamEvidence(f.loser, f.siteL, f.deviceL);
    // Let the pre-fence check pass so Phase B runs and the tx-internal copy refuses:
    vi.spyOn(orgMergeModule, 'collectMergeBlockers').mockResolvedValueOnce([]);
    await expect(
      orgMergeModule.executeOrgMerge({
        loserOrgId: f.loser, survivorOrgId: f.survivor, partnerId: f.partner,
        performedBy: f.actor, performedByEmail: f.actorEmail,
      }),
    ).rejects.toMatchObject({ code: 'ORG_MERGE_BLOCKED' });
    // rollback + unfence: status restored, no merge event, survivor untouched
    const org = rows<{ status: string }>(
      await getTestDb().execute(sql`SELECT status FROM organizations WHERE id = ${f.loser}::uuid`),
    )[0];
    expect(org?.status).toBe('active');
    expect(
      rows(await getTestDb().execute(sql`SELECT 1 FROM org_merge_events WHERE loser_org_id = ${f.loser}::uuid`)),
    ).toHaveLength(0);
  });

  it('survivor-side PAM evidence never blocks and is never touched', async () => {
    // Fixture has no survivor-side device (only `siteS`) — create one here
    // rather than touch seedFixture or its assertions. A SURVIVOR device
    // means devices_pam_history_move_guard never sees an org change for it.
    const deviceS = randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (${deviceS}::uuid, ${f.survivor}::uuid, ${f.siteS}::uuid, ${`agent-pam-s-${f.suffix}`}, ${`host-pam-s-${f.suffix}`}, 'windows', '11', 'x64', '1.0.0')`);
    await seedPamEvidence(f.survivor, f.siteS, deviceS);

    const pamBefore = rows(await getTestDb().execute(sql`
      SELECT id, org_id, device_id FROM pam_actuations WHERE org_id = ${f.survivor}::uuid ORDER BY id`));
    const result = await orgMergeModule.executeOrgMerge({
      loserOrgId: f.loser, survivorOrgId: f.survivor, partnerId: f.partner,
      performedBy: f.actor, performedByEmail: f.actorEmail,
    });
    expect(result.mergeEventId).toBeTruthy();
    const pamAfter = rows(await getTestDb().execute(sql`
      SELECT id, org_id, device_id FROM pam_actuations WHERE org_id = ${f.survivor}::uuid ORDER BY id`));
    expect(pamAfter).toEqual(pamBefore);
  });

  // Controller ruling (Task 1's review): a direct `runPolicy` blocks-merge
  // test — the only test in the suite exercising the defense-in-depth
  // resolve-phase branch itself. executeOrgMerge's pre-fence and in-tx
  // recheck are meant to make this branch unreachable in practice; these two
  // tests prove it still refuses (and still no-ops) correctly on its own.
  it('runPolicy resolve phase rejects with OrgMergeBlockedError when loser rows exist (defense in depth)', async () => {
    await seedPamEvidence(f.loser, f.siteL, f.deviceL);
    await expect(
      withSystemDbAccessContext(() =>
        orgMergeModule.runPolicy(
          'pam_actuations',
          { kind: 'blocks-merge', note: 'test: durable PAM evidence' },
          f.loser,
          f.survivor,
          'resolve',
        ),
      ),
    ).rejects.toMatchObject({
      name: 'OrgMergeBlockedError',
      code: 'ORG_MERGE_BLOCKED',
      blockers: [{ table: 'pam_actuations', loserRows: 1 }],
    });
  });

  it('runPolicy resolve phase no-ops when there are zero loser rows', async () => {
    await expect(
      withSystemDbAccessContext(() =>
        orgMergeModule.runPolicy(
          'pam_actuations',
          { kind: 'blocks-merge', note: 'test: durable PAM evidence' },
          f.loser,
          f.survivor,
          'resolve',
        ),
      ),
    ).resolves.toEqual({ moved: 0, dropped: 0, notes: [] });
  });
});
