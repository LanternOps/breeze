#!/usr/bin/env tsx
/**
 * Wisp W07 Task 10 (+ w00 A33) — Todd's private gap-finder (system scope, CLI only).
 *
 * "Set this partner up to manage its customers; report what Breeze itself is
 * missing." Reads one partner's configuration in system scope (read-only),
 * asks the model ONCE with no tools, and writes a markdown report under
 * `<repoRoot>/internal/wisp-gap-reports/` (gitignored by `/internal/*`).
 *
 * Never imported from src/, never a tool, never a route
 * (wisp-gap-finder.registration.test.ts).
 *
 * Usage:
 *   pnpm --filter @breeze/api wisp:gap-finder --partner <uuid> [--dry-run]
 *
 *   --dry-run   build the snapshot and print the prompt; no model call, no file.
 *
 * Exit codes:
 *   0  report written (or dry-run prompt printed)
 *   1  fatal error (DB, model unavailable, unparseable model output, ...)
 *   2  usage error (missing / non-uuid --partner, unknown flag)
 *   3  partner not found (or deleted)
 *
 * Readiness (first context block): W05's `readinessInventory(ceiling)` takes a
 * GrantCeiling. A gap-finder run has no grant, so we build a synthetic,
 * never-persisted ceiling for the partner — status 'active', partnerWide, every
 * live org of the partner in `orgIds`, no site restriction, and EMPTY
 * permission/tool sets. readinessInventory only reads `status`, `orgIds` and
 * `partnerId` from it (deterministic reads, no model call, no writes), and the
 * empty permission sets mean the ceiling authorises nothing if it ever leaked.
 * readinessInventory honours the dark-launch gate (`wispEnabled()`); when the
 * gate is off this script does NOT bypass it — the readiness block is recorded
 * as unavailable and a warning names the flags to set for the run.
 *
 * Model: resolved exactly like an agent run's — `resolveModel` on the
 * `ai_agents` surface with the role `agentRunModelRole({ profile: 'analysis' })`
 * (agentModelRole.ts) for the partner (orgId null: the gap-finder is a
 * partner-level analysis, not an org's run). Dispatch uses the Agent SDK
 * `query()` that runLoop.ts uses, with `sdkModelOptions` + the Claude child env.
 * Only platform / direct-Anthropic connections are dispatched: catalog and
 * gateway connections need an audited egress grant, which records rows — this
 * CLI writes nothing to the DB, so it refuses those.
 */
import { closeSync, constants as fsConstants, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { closeDb, db, withSystemDbAccessContext } from '../src/db';
import { organizations, partners, sites } from '../src/db/schema/orgs';
import { devices } from '../src/db/schema/devices';
import { monitorDefinitions } from '../src/db/schema/monitorDefinitions';
import { networkMonitors } from '../src/db/schema/monitors';
import { alertRules } from '../src/db/schema/alerts';
import { ticketRoutingRules } from '../src/db/schema/ticketRoutingRules';
import { configurationPolicies } from '../src/db/schema/configurationPolicies';
import { contacts } from '../src/db/schema/contacts';
import { portalBranding, portalUsers } from '../src/db/schema/portal';
import { psaConnections } from '../src/db/schema/integrations';
import { m365Connections } from '../src/db/schema/m365';
import { googleWorkspaceConnections } from '../src/db/schema/google';
import { c2cConnections } from '../src/db/schema/c2c';
import { dnsFilterIntegrations } from '../src/db/schema/dnsSecurity';
import { backupProviderConnections, backupProviderCustomers } from '../src/db/schema/backupProviders';
import { edrConnections, edrTenants } from '../src/db/schema/edrProviders';
import { huntressIntegrations, huntressOrgMappings } from '../src/db/schema/huntress';
import { s1Integrations, s1OrgMappings } from '../src/db/schema/sentinelOne';
import { unifiIntegrations, unifiSiteMappings } from '../src/db/schema/unifi';
import { pax8CompanyMappings, pax8Integrations } from '../src/db/schema/pax8';
import { accountingConnections } from '../src/db/schema/accounting';
import { readinessInventory } from '../src/services/wisp/readiness';
import type { GrantCeiling } from '../src/services/wisp/grantAuthority';
import { wispEnabled } from '../src/config/env';
import { resolveModel, type ResolvedModel } from '../src/services/aiModels/resolveModel';
import { isGatewayResolvedConnection, sdkModelOptions } from '../src/services/aiModels/connectionFactory';
import { buildClaudeSdkChildEnv, catalogEndpointOf } from '../src/services/aiModels/sdkChildEnv';
import { agentRunModelRole } from '../src/services/aiAgents/agentModelRole';
import {
  buildGapFinderPrompt,
  isUuid,
  parseGapFindings,
  renderGapReport,
  resolveReportPath,
  type ConfigCounts,
  type OrgSnapshot,
  type PartnerSnapshot,
  type ReadinessBlock,
} from './wisp-gap-finder.lib';

const TAG = '[wisp-gap-finder]';
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const MODEL_TIMEOUT_MS = 10 * 60 * 1000;

class ExitError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

// ------------------------------------------------------------------ args

function parseArgs(argv: string[]): { partnerId: string; dryRun: boolean } {
  let partnerId: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue;
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--partner') { partnerId = argv[++i] ?? null; continue; }
    if (a.startsWith('--partner=')) { partnerId = a.slice('--partner='.length); continue; }
    throw new ExitError(2, `unknown argument: ${a}`);
  }
  if (!partnerId) throw new ExitError(2, 'missing --partner <uuid>');
  if (!isUuid(partnerId)) throw new ExitError(2, '--partner must be a UUID');
  return { partnerId: partnerId.toLowerCase(), dryRun };
}

// ------------------------------------------------------------- snapshot

type CountRow = { orgId: string | null; n: number };
type KindRow = { orgId: string | null; kind: string };

const count = sql<number>`count(*)::int`;

function countMap(rows: CountRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) if (r.orgId) m.set(r.orgId, (m.get(r.orgId) ?? 0) + r.n);
  return m;
}

function kindMap(rows: KindRow[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.orgId) continue;
    const s = m.get(r.orgId) ?? new Set<string>();
    s.add(r.kind);
    m.set(r.orgId, s);
  }
  return m;
}

const sorted = (s: Iterable<string> | undefined): string[] => [...(s ?? [])].sort();

/** Org-owned configuration counts, grouped by org. */
async function orgConfigCounts(orgIds: string[]): Promise<Record<keyof ConfigCounts, Map<string, number>>> {
  const monitorDefs = await db.select({ orgId: monitorDefinitions.orgId, n: count }).from(monitorDefinitions)
    .where(and(inArray(monitorDefinitions.orgId, orgIds), eq(monitorDefinitions.enabled, true)))
    .groupBy(monitorDefinitions.orgId);
  const netMonitors = await db.select({ orgId: networkMonitors.orgId, n: count }).from(networkMonitors)
    .where(and(inArray(networkMonitors.orgId, orgIds), eq(networkMonitors.isActive, true)))
    .groupBy(networkMonitors.orgId);
  const rules = await db.select({ orgId: alertRules.orgId, n: count }).from(alertRules)
    .where(and(inArray(alertRules.orgId, orgIds), eq(alertRules.isActive, true), isNull(alertRules.retiredAt)))
    .groupBy(alertRules.orgId);
  const ticketRules = await db.select({ orgId: ticketRoutingRules.orgId, n: count }).from(ticketRoutingRules)
    .where(and(inArray(ticketRoutingRules.orgId, orgIds), eq(ticketRoutingRules.enabled, true)))
    .groupBy(ticketRoutingRules.orgId);
  const policies = await db.select({ orgId: configurationPolicies.orgId, n: count }).from(configurationPolicies)
    .where(and(inArray(configurationPolicies.orgId, orgIds), eq(configurationPolicies.status, 'active')))
    .groupBy(configurationPolicies.orgId);
  return {
    monitorCount: countMap([...monitorDefs, ...netMonitors]),
    alertRuleCount: countMap(rules),
    ticketRuleCount: countMap(ticketRules),
    policyCount: countMap(policies),
  };
}

/** Partner-wide (org_id NULL) configuration counts. */
async function partnerWideCounts(partnerId: string): Promise<ConfigCounts> {
  const one = async (rows: Promise<Array<{ n: number }>>) => (await rows)[0]?.n ?? 0;
  const monitorDefs = await one(db.select({ n: count }).from(monitorDefinitions)
    .where(and(eq(monitorDefinitions.partnerId, partnerId), isNull(monitorDefinitions.orgId), eq(monitorDefinitions.enabled, true))));
  const netMonitors = await one(db.select({ n: count }).from(networkMonitors)
    .where(and(eq(networkMonitors.partnerId, partnerId), isNull(networkMonitors.orgId), eq(networkMonitors.isActive, true))));
  return {
    monitorCount: monitorDefs + netMonitors,
    alertRuleCount: await one(db.select({ n: count }).from(alertRules)
      .where(and(eq(alertRules.partnerId, partnerId), isNull(alertRules.orgId), eq(alertRules.isActive, true), isNull(alertRules.retiredAt)))),
    ticketRuleCount: await one(db.select({ n: count }).from(ticketRoutingRules)
      .where(and(eq(ticketRoutingRules.partnerId, partnerId), isNull(ticketRoutingRules.orgId), eq(ticketRoutingRules.enabled, true)))),
    policyCount: await one(db.select({ n: count }).from(configurationPolicies)
      .where(and(eq(configurationPolicies.partnerId, partnerId), isNull(configurationPolicies.orgId), eq(configurationPolicies.status, 'active')))),
  };
}

/** Integration kinds mapped to each org (presence only; never names, ids, hosts or credentials). */
async function orgIntegrationKinds(orgIds: string[]): Promise<Map<string, Set<string>>> {
  const rows: KindRow[] = [];
  const push = (kind: string, found: Array<{ orgId: string | null }>) => {
    for (const r of found) rows.push({ orgId: r.orgId, kind });
  };
  for (const r of await db.selectDistinct({ orgId: psaConnections.orgId, provider: psaConnections.provider }).from(psaConnections)
    .where(and(inArray(psaConnections.orgId, orgIds), eq(psaConnections.enabled, true)))) rows.push({ orgId: r.orgId, kind: `psa:${r.provider}` });
  push('m365', await db.selectDistinct({ orgId: m365Connections.orgId }).from(m365Connections)
    .where(and(inArray(m365Connections.orgId, orgIds), ne(m365Connections.status, 'revoked'))));
  push('google_workspace', await db.selectDistinct({ orgId: googleWorkspaceConnections.orgId }).from(googleWorkspaceConnections)
    .where(inArray(googleWorkspaceConnections.orgId, orgIds)));
  for (const r of await db.selectDistinct({ orgId: c2cConnections.orgId, provider: c2cConnections.provider }).from(c2cConnections)
    .where(inArray(c2cConnections.orgId, orgIds))) rows.push({ orgId: r.orgId, kind: `c2c:${r.provider}` });
  for (const r of await db.selectDistinct({ orgId: dnsFilterIntegrations.orgId, provider: dnsFilterIntegrations.provider }).from(dnsFilterIntegrations)
    .where(and(inArray(dnsFilterIntegrations.orgId, orgIds), eq(dnsFilterIntegrations.isActive, true)))) rows.push({ orgId: r.orgId, kind: `dns_filter:${r.provider}` });
  for (const r of await db.selectDistinct({ orgId: backupProviderCustomers.orgId, provider: backupProviderConnections.provider })
    .from(backupProviderCustomers)
    .innerJoin(backupProviderConnections, and(eq(backupProviderConnections.id, backupProviderCustomers.connectionId), eq(backupProviderConnections.isActive, true)))
    .where(inArray(backupProviderCustomers.orgId, orgIds))) rows.push({ orgId: r.orgId, kind: `backup:${r.provider}` });
  for (const r of await db.selectDistinct({ orgId: edrTenants.orgId, provider: edrConnections.provider })
    .from(edrTenants)
    .innerJoin(edrConnections, and(eq(edrConnections.id, edrTenants.connectionId), eq(edrConnections.isActive, true)))
    .where(inArray(edrTenants.orgId, orgIds))) rows.push({ orgId: r.orgId, kind: `edr:${r.provider}` });
  push('huntress', await db.selectDistinct({ orgId: huntressOrgMappings.orgId }).from(huntressOrgMappings)
    .where(inArray(huntressOrgMappings.orgId, orgIds)));
  push('sentinelone', await db.selectDistinct({ orgId: s1OrgMappings.orgId }).from(s1OrgMappings)
    .where(inArray(s1OrgMappings.orgId, orgIds)));
  push('unifi', await db.selectDistinct({ orgId: unifiSiteMappings.orgId }).from(unifiSiteMappings)
    .where(inArray(unifiSiteMappings.orgId, orgIds)));
  push('pax8', await db.selectDistinct({ orgId: pax8CompanyMappings.orgId }).from(pax8CompanyMappings)
    .where(inArray(pax8CompanyMappings.orgId, orgIds)));
  return kindMap(rows);
}

/** Partner-level integration connections (presence + provider only). */
async function partnerIntegrationKinds(partnerId: string): Promise<string[]> {
  const kinds = new Set<string>();
  for (const r of await db.selectDistinct({ provider: psaConnections.provider }).from(psaConnections)
    .where(and(eq(psaConnections.partnerId, partnerId), isNull(psaConnections.orgId), eq(psaConnections.enabled, true)))) kinds.add(`psa:${r.provider}`);
  for (const r of await db.selectDistinct({ provider: backupProviderConnections.provider }).from(backupProviderConnections)
    .where(and(eq(backupProviderConnections.partnerId, partnerId), eq(backupProviderConnections.isActive, true)))) kinds.add(`backup:${r.provider}`);
  for (const r of await db.selectDistinct({ provider: edrConnections.provider }).from(edrConnections)
    .where(and(eq(edrConnections.partnerId, partnerId), eq(edrConnections.isActive, true)))) kinds.add(`edr:${r.provider}`);
  for (const r of await db.selectDistinct({ provider: accountingConnections.provider }).from(accountingConnections)
    .where(eq(accountingConnections.partnerId, partnerId))) kinds.add(`accounting:${r.provider}`);
  const flag = async (kind: string, rows: Promise<unknown[]>) => { if ((await rows).length > 0) kinds.add(kind); };
  await flag('huntress', db.select({ id: huntressIntegrations.id }).from(huntressIntegrations)
    .where(and(eq(huntressIntegrations.partnerId, partnerId), eq(huntressIntegrations.isActive, true))).limit(1));
  await flag('sentinelone', db.select({ id: s1Integrations.id }).from(s1Integrations)
    .where(and(eq(s1Integrations.partnerId, partnerId), eq(s1Integrations.isActive, true))).limit(1));
  await flag('unifi', db.select({ id: unifiIntegrations.id }).from(unifiIntegrations)
    .where(and(eq(unifiIntegrations.partnerId, partnerId), eq(unifiIntegrations.isActive, true))).limit(1));
  await flag('pax8', db.select({ id: pax8Integrations.id }).from(pax8Integrations)
    .where(and(eq(pax8Integrations.partnerId, partnerId), eq(pax8Integrations.isActive, true))).limit(1));
  return sorted(kinds);
}

type SnapshotCore = Omit<PartnerSnapshot, 'readiness'>;

async function readSnapshotCore(partnerId: string, now: Date): Promise<SnapshotCore | null> {
  return withSystemDbAccessContext(async () => {
    // Belt and braces for "no writes": any write in this transaction now errors.
    await db.execute(sql`SET TRANSACTION READ ONLY`);

    const [partner] = await db
      .select({ id: partners.id, name: partners.name, plan: partners.plan })
      .from(partners)
      .where(and(eq(partners.id, partnerId), isNull(partners.deletedAt)))
      .limit(1);
    if (!partner) return null;

    const orgRows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(and(eq(organizations.partnerId, partnerId), isNull(organizations.deletedAt)))
      .orderBy(organizations.name, organizations.id);
    const orgIds = orgRows.map((o) => o.id);

    const partnerWide = { ...(await partnerWideCounts(partnerId)), integrationKinds: await partnerIntegrationKinds(partnerId) };
    let orgs: OrgSnapshot[] = [];
    if (orgIds.length > 0) {
      const deviceCounts = countMap(await db.select({ orgId: devices.orgId, n: count }).from(devices)
        .where(and(inArray(devices.orgId, orgIds), ne(devices.status, 'decommissioned'))).groupBy(devices.orgId));
      const siteCounts = countMap(await db.select({ orgId: sites.orgId, n: count }).from(sites)
        .where(inArray(sites.orgId, orgIds)).groupBy(sites.orgId));
      const contactCounts = countMap(await db.select({ orgId: contacts.orgId, n: count }).from(contacts)
        .where(inArray(contacts.orgId, orgIds)).groupBy(contacts.orgId));
      // "Portal enabled" has no flag column: an org counts when it has a portal
      // branding row or at least one portal login.
      const portalOrgs = new Set<string>([
        ...(await db.selectDistinct({ orgId: portalBranding.orgId }).from(portalBranding).where(inArray(portalBranding.orgId, orgIds))).map((r) => r.orgId),
        ...(await db.selectDistinct({ orgId: portalUsers.orgId }).from(portalUsers).where(inArray(portalUsers.orgId, orgIds))).map((r) => r.orgId),
      ]);
      const config = await orgConfigCounts(orgIds);
      const integrations = await orgIntegrationKinds(orgIds);
      orgs = orgRows.map((o) => ({
        id: o.id,
        name: o.name,
        deviceCount: deviceCounts.get(o.id) ?? 0,
        siteCount: siteCounts.get(o.id) ?? 0,
        monitorCount: config.monitorCount.get(o.id) ?? 0,
        alertRuleCount: config.alertRuleCount.get(o.id) ?? 0,
        ticketRuleCount: config.ticketRuleCount.get(o.id) ?? 0,
        policyCount: config.policyCount.get(o.id) ?? 0,
        integrationKinds: sorted(integrations.get(o.id)),
        portalEnabled: portalOrgs.has(o.id),
        contactCount: contactCounts.get(o.id) ?? 0,
      }));
    }

    return {
      partner: { id: partner.id, name: partner.name, plan: partner.plan, partnerWide },
      orgs,
      collectedAt: now.toISOString(),
    };
  }, 'wisp-gap-finder-snapshot');
}

/** Synthetic, never-persisted ceiling — see the file header. */
function syntheticReadOnlyCeiling(partnerId: string, orgIds: string[]): GrantCeiling {
  return {
    grantId: 'wisp-gap-finder',
    revisionId: 'wisp-gap-finder',
    partnerId,
    grantorUserId: '',
    scopeOrgId: null,
    partnerWide: true,
    orgIds: new Set(orgIds),
    siteIds: null,
    permissionKeys: new Set<string>(),
    toolAllowlist: new Set<string>(),
    deniedTools: new Set<string>(),
    orgTerms: new Map(),
    status: 'active',
  };
}

async function readReadiness(partnerId: string, orgIds: string[]): Promise<ReadinessBlock> {
  if (!wispEnabled()) {
    console.error(`${TAG} warning: Wisp is dark in this environment (wispEnabled() is false); the readiness block is marked unavailable. Set IS_HOSTED, BREEZE_AI_AGENTS_ENABLED and BREEZE_WISP_ENABLED for this run to include it.`);
    return { available: false, reason: 'wisp_disabled', orgs: [] };
  }
  if (orgIds.length === 0) return { available: true, orgs: [] };
  return { available: true, orgs: await readinessInventory(syntheticReadOnlyCeiling(partnerId, orgIds)) };
}

// ----------------------------------------------------------------- model

async function resolveGapFinderModel(partnerId: string): Promise<ResolvedModel> {
  const resolved = await withSystemDbAccessContext(async () => {
    await db.execute(sql`SET TRANSACTION READ ONLY`);
    return resolveModel({
      partnerId,
      orgId: null,
      surface: 'ai_agents',
      role: agentRunModelRole({ profile: 'analysis' }),
    });
  }, 'wisp-gap-finder-model');
  if (!resolved.ok) throw new ExitError(1, `model unavailable (${resolved.reason}): ${resolved.message}`);
  return resolved;
}

function childEnvFor(resolved: ResolvedModel): Record<string, string> {
  const conn = resolved.connection;
  if (isGatewayResolvedConnection(conn)) {
    throw new ExitError(1, 'the partner resolves to a gateway connection; the gap-finder dispatches only platform or direct-Anthropic connections (no egress grant from a CLI)');
  }
  if (catalogEndpointOf(conn.config)) {
    throw new ExitError(1, 'the partner resolves to a catalog connection; the gap-finder dispatches only platform or direct-Anthropic connections (no egress grant from a CLI)');
  }
  return buildClaudeSdkChildEnv(conn.config, process.env);
}

async function askModel(resolved: ResolvedModel, prompt: { system: string; user: string }): Promise<string> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), MODEL_TIMEOUT_MS);
  try {
    const sdkQuery = query({
      prompt: prompt.user,
      options: {
        ...sdkModelOptions(resolved),
        systemPrompt: prompt.system,
        maxTurns: 1,
        tools: [],
        allowedTools: [],
        abortController,
        env: childEnvFor(resolved),
        persistSession: false,
        settingSources: [],
      },
    });
    let text: string | null = null;
    for await (const message of sdkQuery) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') throw new ExitError(1, `model call ended with ${message.subtype}`);
      text = message.result;
    }
    if (text === null) throw new ExitError(1, 'model call returned no result');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ write

function writeReport(reportPath: string, markdown: string): void {
  const internalDir = path.join(REPO_ROOT, 'internal');
  mkdirSync(path.dirname(reportPath), { recursive: true });
  // resolveReportPath checked the lexical path; re-check the real one so a
  // symlinked internal/ or wisp-gap-reports/ cannot redirect the write.
  const realInternal = realpathSync(internalDir);
  const realDir = realpathSync(path.dirname(reportPath));
  if (realInternal !== path.join(realpathSync(REPO_ROOT), 'internal') || !realDir.startsWith(`${realInternal}${path.sep}`)) {
    throw new ExitError(1, 'report directory resolves outside internal/');
  }
  // ONE open, no check-then-act: O_NOFOLLOW makes the open itself refuse a
  // symlinked report path (ELOOP), so nothing can be swapped in between a
  // check and the write. Truncates an earlier same-day report for this partner.
  let fd: number;
  try {
    fd = openSync(
      reportPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new ExitError(1, 'report path is a symlink; refusing to write');
    }
    throw err;
  }
  try {
    writeFileSync(fd, markdown, 'utf8');
  } finally {
    closeSync(fd);
  }
}

// ------------------------------------------------------------------- main

async function main(): Promise<void> {
  const { partnerId, dryRun } = parseArgs(process.argv.slice(2));
  const now = new Date();
  const reportPath = resolveReportPath(REPO_ROOT, partnerId, now);

  const core = await readSnapshotCore(partnerId, now);
  if (!core) throw new ExitError(3, `partner ${partnerId} not found`);
  const readiness = await readReadiness(partnerId, core.orgs.map((o) => o.id));
  const snapshot: PartnerSnapshot = { readiness, ...core };
  const prompt = buildGapFinderPrompt(snapshot);

  if (dryRun) {
    console.log(`${TAG} dry run — no model call, nothing written. Report would go to ${path.relative(REPO_ROOT, reportPath)}`);
    console.log('----- system -----');
    console.log(prompt.system);
    console.log('----- user -----');
    console.log(prompt.user);
    return;
  }

  const resolved = await resolveGapFinderModel(partnerId);
  console.error(`${TAG} model: ${resolved.logicalModel} (${resolved.funding}), ${core.orgs.length} org(s)`);
  const findings = parseGapFindings(await askModel(resolved, prompt));
  writeReport(reportPath, renderGapReport(snapshot, findings));
  console.log(path.relative(REPO_ROOT, reportPath));
}

main()
  .catch((err) => {
    if (err instanceof ExitError) {
      console.error(`${TAG} ${err.message}`);
      process.exitCode = err.code;
      return;
    }
    console.error(`${TAG} FAILED`);
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
