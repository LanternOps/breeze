/**
 * Partner settings inheritance read model under real RLS (#9170 W3, spec §5.6,
 * §11): resolver parity and bucket agreement.
 *
 * Both routes run through the real `orgRoutes` + `authMiddleware` on the
 * unprivileged `breeze_app` request pool, so the population, the gate and the
 * RLS-scoped reads are the production ones. Fixtures are seeded with the
 * system-scope test connection before any request, outside any request
 * transaction.
 *
 * What only this file can prove (unit tests mock the database):
 *  - `orgCount` equals the org list's total for the same caller, and the
 *    hidden org types (Quick Support, the unassigned-pool holding org),
 *    suspended and soft-deleted orgs are never counted or listed.
 *  - Partner A never counts partner B's orgs; drill-down ids are disjoint.
 *  - A selected-access partner user gets 403 PARTNER_WIDE_REQUIRED.
 *  - Resolver contract: for every visible org and every field with an org
 *    source, the ACTUAL runtime resolver's in-effect source equals the
 *    drill-down row's `inEffect`, and the tab counts equal the per-org tallies.
 *  - bucketSql agrees with classifyOrg: for every field and bucket, the org set
 *    the SQL predicate selects equals the set classifyOrg labels.
 *  - An org with two Pushover channels is counted once.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_BY_ID,
  CATALOG_TAB_KEYS,
  PARTNER_SETTINGS_CATALOG,
  resolveAiApprovalTimeout,
  type InheritanceOrgPageDto,
  type InheritanceOrgRowDto,
  type InheritanceTabDto,
} from '@breeze/shared';

import { withSystemDbAccessContext } from '../../db';
import {
  aiBudgets,
  notificationChannelConfigs,
  notificationChannels,
  partnerUsers,
  partners,
  users,
} from '../../db/schema';
import { orgRoutes } from '../../routes/orgs';
import { getOrgAgentUpdateConfig } from '../../routes/agents/helpers';
import { createAccessToken } from '../../services/jwt';
import { getEffectiveAiBudget, getEffectiveOrgSettings } from '../../services/effectiveSettings';
import { getEnrollmentDefaultsForOrg } from '../../services/enrollmentDefaults';
import { getOrgForwardingConfig } from '../../services/logForwarding';
import { decryptNotificationChannelConfig } from '../../services/notificationChannelSecrets';
import { applyPartnerPushoverDefaults, readPartnerPushoverDefaults } from '../../services/partnerPushoverDefaults';
import type { PushoverConfig } from '../../services/notificationSenders';
import { BINDINGS, BUCKETS, presentAt, type Bucket, type PushoverConfigKey } from '../../services/partnerSettingsInheritance/bindings';
import { classifyOrg, type ChannelRaw } from '../../services/partnerSettingsInheritance/classify';
import { assignUserToOrganization, assignUserToPartner, createOrganization, createRole, createUser, grantRolePermissions, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  app.route('/orgs', orgRoutes);
  return app;
}

// Partner A's settings: most classified fields set, a few deliberately blank
// so both the "set" and "blank" branches of every kind are exercised.
const PARTNER_A_SETTINGS = {
  security: { requireMfa: true },
  notifications: {
    pushoverAppToken: 'partner-token-plain',
    pushoverDefaultSound: 'siren',
    pushoverDefaultPriority: 1,
  },
  // Enabled without a URL: a partial destination, not in force.
  eventLogs: { enabled: true },
  defaults: {
    agentUpdatePolicy: 'manual',
    agentVersionPins: { agent: '0.90.0' },
    defaultEnrollmentTtlMinutes: 60,
    defaultEnrollmentDeviceCount: 5,
    maxEnrollmentLinkTtlMinutes: 120,
  },
  aiBudgets: { maxTurnsPerSession: 9, monthlyBudgetCents: null },
  aiApprovals: { interactiveTimeoutMinutes: 15 },
};

interface Fixture {
  partnerA: string;
  partnerB: string;
  /** Orgs a full-access user of A sees: active, trial, blank. */
  visibleA: string[];
  hiddenA: string[];
  visibleB: string[];
  a1: string;
  tokenA: string;
  tokenSelectedA: string;
  tokenB: string;
}

async function partnerToken(userId: string, email: string, roleId: string, partnerId: string): Promise<string> {
  return createAccessToken({
    sub: userId,
    email,
    roleId,
    orgId: null,
    partnerId,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
}

async function addPushoverChannel(orgId: string | null, partnerId: string | null, name: string, config: Record<string, unknown>): Promise<string> {
  const database = getTestDb();
  const [channel] = await database
    .insert(notificationChannels)
    .values({ orgId, partnerId, name, type: 'pushover' })
    .returning({ id: notificationChannels.id });
  await database.insert(notificationChannelConfigs).values({ channelId: channel!.id, config });
  return channel!.id;
}

async function seed(): Promise<Fixture> {
  const database = getTestDb();

  // Partner A, its full-access user and the first (active) org.
  const envA = await setupTestEnvironment({ scope: 'partner' });
  await database.update(partners).set({ settings: PARTNER_A_SETTINGS }).where(eq(partners.id, envA.partner.id));
  await database.update(users).set({ mfaEnabled: true, mfaMethod: 'totp' }).where(eq(users.id, envA.user.id));
  const a1 = envA.organization.id;
  await database.execute(
    // Raw JSON so every stored shape is exactly what the fixture says.
    sql`UPDATE organizations SET name = 'Alpha active', settings = ${JSON.stringify({
      security: { requireMfa: false, sessionTimeout: 60 },
      defaults: {
        agentUpdatePolicy: 'auto',
        maintenanceWindow: 'Sun 02:00-04:00',
        agentVersionPins: { agent: '0.91.0', watchdog: '0.91.0' },
        // Above the partner cap (120): clamped.
        defaultEnrollmentTtlMinutes: 600,
        defaultEnrollmentDeviceCount: 7,
      },
      aiApprovals: { interactiveTimeoutMinutes: 20 },
      logForwarding: { enabled: true, elasticsearchUrl: 'https://org-a1.example', elasticsearchApiKey: 'CANARY-PLAIN-eventLogs-key' },
    })}::jsonb WHERE id = ${a1}`,
  );
  // An ai_budgets row overriding one locked field (and carrying column defaults).
  await database.insert(aiBudgets).values({ orgId: a1, maxTurnsPerSession: 12 });
  // Two Pushover channels; only the first sets its own value.
  await addPushoverChannel(a1, null, 'A1 primary', { sound: 'bike', token: '   ' });
  await addPushoverChannel(a1, null, 'A1 secondary', {});

  // Trial org with blank / equal / invalid values.
  const a2 = (await createOrganization({
    partnerId: envA.partner.id,
    name: 'Bravo trial',
    status: 'trial',
    settings: {
      security: {},
      defaults: { agentVersionPins: { agent: '0.90.0' } },
      aiApprovals: { interactiveTimeoutMinutes: 3 },
      logForwarding: { enabled: false, elasticsearchUrl: 'https://org-a2.example' },
    },
  })).id;
  await addPushoverChannel(a2, null, 'A2 only', { token: 'org-token-CANARY-PLAIN', priority: 0 });

  // Active org with nothing of its own.
  const a7 = (await createOrganization({ partnerId: envA.partner.id, name: 'Charlie blank' })).id;

  // Orgs that must never be counted or listed, each carrying own values.
  const busy = { security: { requireMfa: false }, defaults: { agentUpdatePolicy: 'auto' } };
  const hiddenA = [
    (await createOrganization({ partnerId: envA.partner.id, name: 'Suspended', status: 'suspended', settings: busy })).id,
    (await createOrganization({ partnerId: envA.partner.id, name: 'Deleted', deletedAt: new Date(), settings: busy })).id,
    (await createOrganization({ partnerId: envA.partner.id, name: 'Quick support', type: 'quick_support', settings: busy })).id,
    (await createOrganization({ partnerId: envA.partner.id, name: 'Unassigned pool', type: 'unassigned_pool', settings: busy })).id,
  ];
  for (const orgId of hiddenA) await addPushoverChannel(orgId, null, 'hidden', { sound: 'bike' });
  // A partner-wide channel is not any org's own value.
  await addPushoverChannel(null, envA.partner.id, 'Partner-wide', { sound: 'bike', token: 'partner-wide-token' });

  // Selected-access user of A.
  const selectedRole = await createRole({ scope: 'partner', partnerId: envA.partner.id });
  await grantRolePermissions(selectedRole.id, [{ resource: '*', action: '*' }]);
  const selectedUser = await createUser({ partnerId: envA.partner.id, orgId: null, email: `selected-${randomUUID()}@example.com` });
  await database.update(users).set({ mfaEnabled: true, mfaMethod: 'totp' }).where(eq(users.id, selectedUser.id));
  await assignUserToPartner(selectedUser.id, envA.partner.id, selectedRole.id, 'selected');
  await database
    .update(partnerUsers)
    .set({ orgIds: [a1, a2, a7] })
    .where(and(eq(partnerUsers.userId, selectedUser.id), eq(partnerUsers.partnerId, envA.partner.id)));

  // Partner B with two orgs of its own values.
  const envB = await setupTestEnvironment({ scope: 'partner' });
  await database.update(partners).set({ settings: PARTNER_A_SETTINGS }).where(eq(partners.id, envB.partner.id));
  await database.update(users).set({ mfaEnabled: true, mfaMethod: 'totp' }).where(eq(users.id, envB.user.id));
  const b2 = (await createOrganization({ partnerId: envB.partner.id, name: 'B second', settings: busy })).id;
  await database.execute(
    sql`UPDATE organizations SET settings = ${JSON.stringify(busy)}::jsonb WHERE id = ${envB.organization.id}`,
  );
  await addPushoverChannel(b2, null, 'B channel', { sound: 'bike' });

  return {
    partnerA: envA.partner.id,
    partnerB: envB.partner.id,
    visibleA: [a1, a2, a7],
    hiddenA,
    visibleB: [envB.organization.id, b2],
    a1,
    tokenA: await partnerToken(envA.user.id, envA.user.email, envA.role.id, envA.partner.id),
    tokenSelectedA: await partnerToken(selectedUser.id, selectedUser.email, selectedRole.id, envA.partner.id),
    tokenB: await partnerToken(envB.user.id, envB.user.email, envB.role.id, envB.partner.id),
  };
}

async function get(token: string, path: string): Promise<Response> {
  return buildApp().request(path, { headers: { Authorization: `Bearer ${token}` } });
}

async function getTab(token: string, tab: string): Promise<InheritanceTabDto> {
  const res = await get(token, `/orgs/partners/me/settings-inheritance?tab=${tab}`);
  expect(res.status, `tab ${tab}`).toBe(200);
  return ((await res.json()) as { data: InheritanceTabDto }).data;
}

/** Every row of a drill-down, walking the cursor. */
async function getAllRows(token: string, field: string, bucket: Bucket, limit = 50): Promise<InheritanceOrgRowDto[]> {
  const rows: InheritanceOrgRowDto[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ field, bucket, limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const res = await get(token, `/orgs/partners/me/settings-inheritance/orgs?${query.toString()}`);
    expect(res.status, `${field}/${bucket}`).toBe(200);
    const body = ((await res.json()) as { data: InheritanceOrgPageDto }).data;
    rows.push(...body.rows);
    cursor = body.nextCursor;
    if (!cursor) return rows;
  }
  throw new Error('drill-down did not terminate');
}

const FIELDS_WITH_SOURCE = PARTNER_SETTINGS_CATALOG.filter((e) => BINDINGS[e.id]!.orgSource !== null);

/** The buckets that apply to a field (the drill-down answers 400 for the rest). */
function bucketsFor(id: string): Bucket[] {
  return BUCKETS.filter((bucket) => BINDINGS[id]!.bucketSql(bucket, PARTNER_A_SETTINGS) !== null);
}

// ---------------------------------------------------------------------------
// Raw org values, read with the system test connection (for classifyOrg and
// the resolver contract).
// ---------------------------------------------------------------------------

interface OrgRaw {
  settings: unknown;
  budget: Record<string, unknown> | null;
  channels: { config: Record<string, unknown> }[];
}

async function readRaw(orgIds: string[]): Promise<Map<string, OrgRaw>> {
  const database = getTestDb();
  const out = new Map<string, OrgRaw>();
  for (const orgId of orgIds) {
    const [org] = (await database.execute(sql`SELECT settings FROM organizations WHERE id = ${orgId}`)) as unknown as { settings: unknown }[];
    const [budget] = await database.select().from(aiBudgets).where(eq(aiBudgets.orgId, orgId));
    const channels = (await database
      .select({ config: notificationChannelConfigs.config })
      .from(notificationChannels)
      .innerJoin(notificationChannelConfigs, eq(notificationChannelConfigs.channelId, notificationChannels.id))
      .where(and(eq(notificationChannels.orgId, orgId), eq(notificationChannels.type, 'pushover')))) as { config: Record<string, unknown> }[];
    out.set(orgId, { settings: org?.settings, budget: (budget as Record<string, unknown> | undefined) ?? null, channels });
  }
  return out;
}

function rawFor(id: string, raw: OrgRaw): unknown {
  const source = BINDINGS[id]!.orgSource!;
  switch (source.kind) {
    case 'orgSettings':
      return presentAt(raw.settings, source.path).value;
    case 'aiBudgets':
      return raw.budget ? raw.budget[source.column] : undefined;
    case 'pushoverChannels':
      return raw.channels.map((c): ChannelRaw => ({ value: source.key in c.config ? c.config[source.key] : undefined }));
    default:
      throw new Error(`unhandled source ${source.kind}`);
  }
}

// ---------------------------------------------------------------------------
// The ACTUAL runtime resolvers: is the org's own value what the org gets?
// 'ambiguous' when the org and partner values are equal, so the output cannot
// say which slot won.
// ---------------------------------------------------------------------------

type Source = 'org' | 'other' | 'ambiguous';

async function runtimeSource(id: string, orgId: string, raw: OrgRaw, partnerSettings: unknown): Promise<Source> {
  const source = BINDINGS[id]!.orgSource!;
  const orgValue = rawFor(id, raw);
  const partnerPath = CATALOG_BY_ID[id]!.paths[0]!.split('.');
  const partner = presentAt(partnerSettings, partnerPath);
  const decide = (resolved: unknown, own: unknown, ownPresent: boolean): Source => {
    if (!ownPresent) return 'other';
    if (partner.present && isDeepStrictEqual(own, partner.value)) return 'ambiguous';
    return isDeepStrictEqual(resolved, own) ? 'org' : 'other';
  };
  return withSystemDbAccessContext(async () => {
    if (id === 'security.requireMfa' || id === 'security.sessionTimeout') {
      const field = id.split('.')[1]!;
      const { effective } = await getEffectiveOrgSettings(orgId);
      return decide(effective.security?.[field], orgValue, orgValue !== undefined);
    }
    if (id === 'defaults.agentUpdatePolicy') {
      return decide((await getOrgAgentUpdateConfig(orgId)).settings.policy, orgValue, orgValue !== undefined);
    }
    if (id === 'defaults.maintenanceWindow') {
      return decide((await getOrgAgentUpdateConfig(orgId)).settings.maintenanceWindow, orgValue, orgValue !== undefined);
    }
    if (id.startsWith('defaults.agentVersionPins.')) {
      const component = id.split('.')[2] as 'agent' | 'watchdog';
      return decide((await getOrgAgentUpdateConfig(orgId)).pins[component], orgValue, orgValue !== undefined);
    }
    if (id === 'defaults.defaultEnrollmentTtlMinutes') {
      const resolved = await getEnrollmentDefaultsForOrg(orgId);
      // The org slot wins and is then clamped to the ceiling.
      const expectedIfOrg = typeof orgValue === 'number' ? Math.min(orgValue, resolved.maxTtlMinutes) : orgValue;
      return decide(resolved.ttlMinutes, expectedIfOrg, orgValue !== undefined);
    }
    if (id === 'defaults.defaultEnrollmentDeviceCount') {
      return decide((await getEnrollmentDefaultsForOrg(orgId)).deviceCount, orgValue, orgValue !== undefined);
    }
    if (id === 'aiApprovals.interactiveTimeoutMinutes') {
      return resolveAiApprovalTimeout(partnerSettings, raw.settings).source === 'org' ? 'org' : 'other';
    }
    if (source.kind === 'aiBudgets') {
      const budget = await getEffectiveAiBudget(orgId);
      return decide(budget[source.column as keyof typeof budget], orgValue, orgValue !== null && orgValue !== undefined);
    }
    if (id === 'eventLogs') {
      const config = await getOrgForwardingConfig(orgId);
      return config && !config.sharedAcrossOrgs ? 'org' : 'other';
    }
    if (source.kind === 'pushoverChannels') {
      const key = source.key as PushoverConfigKey;
      const defaults = readPartnerPushoverDefaults(partnerSettings);
      let anyOrg = false;
      for (const channel of raw.channels) {
        const config = decryptNotificationChannelConfig('pushover', channel.config) as PushoverConfig;
        const merged = applyPartnerPushoverDefaults(config, defaults);
        const own = key in channel.config;
        if (own && merged[key] === config[key] && !isDeepStrictEqual(config[key], partner.value)) anyOrg = true;
      }
      return anyOrg ? 'org' : 'other';
    }
    throw new Error(`no runtime resolver mapped for ${id}`);
  });
}

describe('partner settings inheritance under real RLS', () => {
  runDb('orgCount equals GET /orgs/organizations total for a full-access user of A, hidden orgs excluded', async () => {
    const f = await seed();
    const list = await get(f.tokenA, '/orgs/organizations?limit=100');
    expect(list.status).toBe(200);
    const total = ((await list.json()) as { pagination: { total: number } }).pagination.total;
    expect(total).toBe(f.visibleA.length);

    for (const tab of CATALOG_TAB_KEYS) {
      expect((await getTab(f.tokenA, tab)).orgCount, tab).toBe(total);
    }
    // No drill-down ever lists a hidden, suspended or deleted org.
    for (const entry of FIELDS_WITH_SOURCE) {
      const rows = await getAllRows(f.tokenA, entry.id, 'ownValue');
      for (const row of rows) expect(f.hiddenA, entry.id).not.toContain(row.orgId);
      for (const row of rows) expect(f.visibleA, entry.id).toContain(row.orgId);
    }
  });

  runDb('partner A never counts partner B orgs; drill-down ids are disjoint under each token', async () => {
    const f = await seed();
    expect((await getTab(f.tokenB, 'security')).orgCount).toBe(f.visibleB.length);
    for (const entry of FIELDS_WITH_SOURCE) {
      const idsA = new Set((await getAllRows(f.tokenA, entry.id, 'ownValue')).map((r) => r.orgId));
      const idsB = new Set((await getAllRows(f.tokenB, entry.id, 'ownValue')).map((r) => r.orgId));
      for (const id of idsA) expect(idsB.has(id), entry.id).toBe(false);
      for (const id of idsB) expect(f.visibleB, entry.id).toContain(id);
    }
  });

  runDb('a selected-access user gets 403 PARTNER_WIDE_REQUIRED on both routes', async () => {
    const f = await seed();
    const tab = await get(f.tokenSelectedA, '/orgs/partners/me/settings-inheritance?tab=security');
    expect(tab.status).toBe(403);
    expect(((await tab.json()) as { code?: string }).code).toBe('PARTNER_WIDE_REQUIRED');
    const rows = await get(f.tokenSelectedA, '/orgs/partners/me/settings-inheritance/orgs?field=security.requireMfa');
    expect(rows.status).toBe(403);
    // The org list itself is not gated.
    expect((await get(f.tokenSelectedA, '/orgs/organizations')).status).toBe(200);
  });

  runDb('resolver contract: runtime in-effect source equals the row, counts equal the per-org tallies', async () => {
    const f = await seed();
    const raws = await readRaw(f.visibleA);
    let decided = 0;
    for (const tab of CATALOG_TAB_KEYS) {
      const dto = await getTab(f.tokenA, tab);
      for (const field of dto.fields) {
        if (BINDINGS[field.id]!.orgSource === null) {
          expect(field.counts, field.id).toBeNull();
          continue;
        }
        const counts = field.counts!;
        const ownRows = await getAllRows(f.tokenA, field.id, 'ownValue');
        const byOrg = new Map(ownRows.map((r) => [r.orgId, r]));
        for (const orgId of f.visibleA) {
          const source = await runtimeSource(field.id, orgId, raws.get(orgId)!, PARTNER_A_SETTINGS);
          if (source === 'ambiguous') continue;
          decided++;
          const row = byOrg.get(orgId);
          if (source === 'org') {
            expect(row, `${field.id} ${orgId}: resolver says org value in effect, but no own-value row`).toBeDefined();
            expect(row!.inEffect, `${field.id} ${orgId}`).toBe(true);
          } else if (row) {
            expect(row.inEffect, `${field.id} ${orgId}`).toBe(false);
          }
        }
        // Tallies: own rows, own-but-not-in-effect = shadowed, overrides rows, clamped rows.
        expect(counts.ownValue, field.id).toBe(ownRows.length);
        expect(counts.shadowed, field.id).toBe(ownRows.filter((r) => !r.inEffect).length);
        if (bucketsFor(field.id).includes('overrides')) {
          const overrideRows = await getAllRows(f.tokenA, field.id, 'overrides');
          expect(counts.overrides, field.id).toBe(overrideRows.length);
          for (const row of overrideRows) expect(row.inEffect, `${field.id} override ${row.orgId}`).toBe(true);
        }
        if (counts.clamped !== undefined) {
          expect(counts.clamped, field.id).toBe((await getAllRows(f.tokenA, field.id, 'clamped')).length);
        }
      }
    }
    // The contract must have teeth: most org×field pairs are decidable.
    expect(decided).toBeGreaterThan(FIELDS_WITH_SOURCE.length * 2);
  });

  runDb('bucketSql agrees with classifyOrg for every field and bucket', async () => {
    const f = await seed();
    const raws = await readRaw(f.visibleA);
    for (const entry of FIELDS_WITH_SOURCE) {
      for (const bucket of bucketsFor(entry.id)) {
        const sqlSet = new Set((await getAllRows(f.tokenA, entry.id, bucket)).map((r) => r.orgId));
        const classifierSet = new Set(
          f.visibleA.filter((orgId) => {
            const result = classifyOrg(entry, PARTNER_A_SETTINGS, rawFor(entry.id, raws.get(orgId)!));
            return result[bucket] === true;
          }),
        );
        expect([...sqlSet].sort(), `${entry.id}/${bucket}`).toEqual([...classifierSet].sort());
      }
    }
  });

  runDb('two-channel org counted once; the drill-down lists both channels', async () => {
    const f = await seed();
    const dto = await getTab(f.tokenA, 'notifications');
    const sound = dto.fields.find((field) => field.id === 'notifications.pushoverDefaultSound')!;
    expect(sound.counts!.ownValue).toBe(1);
    expect(sound.counts!.overrides).toBe(1);
    const rows = await getAllRows(f.tokenA, 'notifications.pushoverDefaultSound', 'ownValue');
    expect(rows.map((r) => r.orgId)).toEqual([f.a1]);
    expect(rows[0]!.channels).toHaveLength(2);
    expect(rows[0]!.channels!.filter((c) => c.ownValue.set)).toHaveLength(1);
  });

  runDb('drill-down pages with a stable cursor: every page size walks the same rows in the same order', async () => {
    const f = await seed();
    // Names that tie under lower(): the id breaks the tie.
    for (const name of ['Delta', 'delta', 'DELTA']) {
      await createOrganization({ partnerId: f.partnerA, name, settings: { security: { requireMfa: false } } });
    }
    const whole = await getAllRows(f.tokenA, 'security.requireMfa', 'ownValue', 50);
    expect(whole.length).toBeGreaterThanOrEqual(4);
    const ids = whole.map((r) => r.orgId);
    for (const limit of [1, 2]) {
      expect((await getAllRows(f.tokenA, 'security.requireMfa', 'ownValue', limit)).map((r) => r.orgId), `limit ${limit}`).toEqual(ids);
    }
    // The order is (lower(name), id).
    const sorted = [...whole].sort((a, b) => a.orgName.toLowerCase().localeCompare(b.orgName.toLowerCase(), 'en') || (a.orgId < b.orgId ? -1 : 1));
    expect(sorted.filter((r) => r.orgName.toLowerCase() === 'delta').map((r) => r.orgId))
      .toEqual(whole.filter((r) => r.orgName.toLowerCase() === 'delta').map((r) => r.orgId));
  });

  runDb('real middleware: an org-scope token and a partner role without orgs:read get 403', async () => {
    const f = await seed();
    const database = getTestDb();
    // Org-scope user of partner A's first org.
    const orgRole = await createRole({ scope: 'organization', orgId: f.a1 });
    await grantRolePermissions(orgRole.id, [{ resource: '*', action: '*' }]);
    const orgUser = await createUser({ partnerId: f.partnerA, orgId: f.a1, email: `org-${randomUUID()}@example.com` });
    await database.update(users).set({ mfaEnabled: true, mfaMethod: 'totp' }).where(eq(users.id, orgUser.id));
    await assignUserToOrganization(orgUser.id, f.a1, orgRole.id);
    const orgToken = await createAccessToken({
      sub: orgUser.id, email: orgUser.email, roleId: orgRole.id, orgId: f.a1, partnerId: f.partnerA,
      scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    // Full-access partner user whose role lacks orgs:read.
    const noReadRole = await createRole({ scope: 'partner', partnerId: f.partnerA });
    await grantRolePermissions(noReadRole.id, [{ resource: 'devices', action: 'read' }]);
    const noReadUser = await createUser({ partnerId: f.partnerA, orgId: null, email: `noread-${randomUUID()}@example.com` });
    await database.update(users).set({ mfaEnabled: true, mfaMethod: 'totp' }).where(eq(users.id, noReadUser.id));
    await assignUserToPartner(noReadUser.id, f.partnerA, noReadRole.id, 'all');
    const noReadToken = await partnerToken(noReadUser.id, noReadUser.email, noReadRole.id, f.partnerA);

    for (const token of [orgToken, noReadToken]) {
      expect((await get(token, '/orgs/partners/me/settings-inheritance?tab=security')).status).toBe(403);
      expect((await get(token, '/orgs/partners/me/settings-inheritance/orgs?field=security.requireMfa')).status).toBe(403);
    }
  });

  runDb('no secret value in any response', async () => {
    const f = await seed();
    const bodies: string[] = [];
    for (const tab of CATALOG_TAB_KEYS) bodies.push(JSON.stringify(await getTab(f.tokenA, tab)));
    for (const entry of FIELDS_WITH_SOURCE) {
      for (const bucket of bucketsFor(entry.id)) bodies.push(JSON.stringify(await getAllRows(f.tokenA, entry.id, bucket)));
    }
    const all = bodies.join('\n');
    for (const secret of ['partner-token-plain', 'org-token-CANARY-PLAIN', 'CANARY-PLAIN-eventLogs-key', 'partner-wide-token', 'https://org-a1.example']) {
      expect(all).not.toContain(secret);
    }
  });
});
