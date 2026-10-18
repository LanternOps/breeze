import './setup';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { evaluateOrgPresence } from '../../services/topology/presenceEvaluator';
import { prunePresenceDays, runTopologyPresenceTick } from '../../jobs/topologyPresenceWorker';
import { closeDb, twoSiteOrg, type PresenceDeviceSpec } from './topology-presence-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());
afterEach(() => { vi.useRealTimers(); });

const DAY_MS = 86_400_000;
/**
 * #8761: day rows are keyed by the UTC day of the evaluation's `now`, so a test whose evaluations span
 * `spanMs` must not straddle midnight or it legitimately gets two day rows. Pins `Date` (fixtures' capturedAt
 * included, so evidence freshness stays consistent) to the real clock, or, when the span would cross midnight,
 * to 1 s after it: then at most `spanMs` + 61 s ahead of Postgres's unfaked now() (the 60 s margin covers the
 * fixture setup between the pin and the test's `now`). Only `Date` is faked; real timers keep running.
 */
function pinClockInsideOneUtcDay(spanMs: number): void {
  const real = Date.now();
  const nextMidnight = (Math.floor(real / DAY_MS) + 1) * DAY_MS;
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(real + spanMs + 60_000 < nextMidnight ? real : nextMidnight + 1_000);
}

/**
 * Site location W3 Task 3 (#7887): the evaluator writes prospective daily presence rows (S§10.1) and computes
 * wrong-site suggestions (S§10.2) onto the presence row; the worker prunes old day rows. Over the real collection
 * seam and real Postgres. Fictional names only. A suggestion never moves a device.
 */
const admin = <T>(query: ReturnType<typeof sql>) => getTestDb().execute(query) as unknown as Promise<T[]>;
const LAN_A = { address: '10.1.2.', gateway: '10.1.2.100' };
const LAN_B = { address: '10.1.5.', gateway: '10.1.5.1' };
const GW_A = '00:00:5e:00:01:0a';
const GW_B = '00:00:5e:00:01:0b';
const DEVICES: PresenceDeviceSpec[] = [
  { key: 'W1', site: 'A', hostname: 'WIN-HD4M8T2C9', address: `${LAN_A.address}10`, gateway: LAN_A.gateway, gatewayMac: GW_A },
  { key: 'W2', site: 'A', hostname: 'WIN-HD4M8T2D1', address: `${LAN_A.address}11`, gateway: LAN_A.gateway, gatewayMac: GW_A },
  { key: 'L1', site: 'B', hostname: 'LAKESIDE-PC-01', address: `${LAN_B.address}20`, gateway: LAN_B.gateway, gatewayMac: GW_B },
  { key: 'L2', site: 'B', hostname: 'LAKESIDE-PC-02', address: `${LAN_B.address}21`, gateway: LAN_B.gateway, gatewayMac: GW_B },
  { key: 'MIS1', site: 'A', hostname: 'DESKTOP-HD7K2QF', address: `${LAN_B.address}30`, gateway: LAN_B.gateway, gatewayMac: GW_B },
  { key: 'MIS2', site: 'A', hostname: 'WIN-HD4M8T2C8', address: `${LAN_B.address}31`, gateway: LAN_B.gateway, gatewayMac: GW_B },
  { key: 'LAP', site: 'B', hostname: 'LAPTOP-LOV-01', address: `${LAN_A.address}40`, gateway: LAN_A.gateway, gatewayMac: GW_A },
];

async function scenario() {
  const f = await twoSiteOrg({ declare: { A: ['10.1.2.0/24'], B: ['10.1.5.0/24'] }, devices: DEVICES });
  await f.reportAll();
  await f.publishAll();
  return f;
}
type Scenario = Awaited<ReturnType<typeof scenario>>;

type DayRow = { day: string; state: string; matched_site_id: string | null; match_key: string; observation_count: number; org_id: string; last_observed_at: Date | string };
const daysOf = (deviceId: string) => admin<DayRow>(sql`SELECT day::text AS day, state, matched_site_id::text AS matched_site_id, match_key,
    observation_count, org_id::text AS org_id, last_observed_at FROM topology_device_presence_days WHERE device_id = ${deviceId}::uuid ORDER BY day, match_key`);
const suggestionOf = async (deviceId: string) => {
  const [row] = await admin<{ suggested_site_id: string | null; suggestion_days: number | null; suggestion_first_at: Date | null; suggestion_last_at: Date | null }>(sql`
    SELECT suggested_site_id::text AS suggested_site_id, suggestion_days, suggestion_first_at, suggestion_last_at
    FROM topology_device_presence WHERE device_id = ${deviceId}::uuid`);
  return row;
};

const HOUR = 3_600_000;
/**
 * Synthetic history ending yesterday: `count` daily 10-hour Lakeside visits, each followed by a stale night
 * that reaches the next visit (the evaluator's own day row for today closes the last gap).
 */
async function seedVisits(f: Scenario, key: string, count: number, now = new Date(), opts: { homeOnDay?: number } = {}) {
  for (let k = count; k >= 1; k--) {
    const start = new Date(now.getTime() - k * 24 * HOUR - 10 * HOUR);
    const end = new Date(now.getTime() - k * 24 * HOUR);
    const nightEnd = new Date(now.getTime() - (k - 1) * 24 * HOUR - 10 * HOUR);
    const state = opts.homeOnDay === k ? 'home' : 'visiting';
    const matched = state === 'visiting' ? f.siteB : null;
    await admin(sql`INSERT INTO topology_device_presence_days (org_id, device_id, day, assigned_site_id, state, matched_site_id, match_key, first_observed_at, last_observed_at)
      VALUES (${f.orgId}::uuid, ${f.ids[key]!}::uuid, ${start.toISOString().slice(0, 10)}::date, ${f.siteA}::uuid, ${state}, ${matched}::uuid,
        ${`${state}:${matched ?? '-'}`}, ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)`);
    await admin(sql`INSERT INTO topology_device_presence_days (org_id, device_id, day, assigned_site_id, state, matched_site_id, match_key, first_observed_at, last_observed_at)
      VALUES (${f.orgId}::uuid, ${f.ids[key]!}::uuid, ${end.toISOString().slice(0, 10)}::date, ${f.siteA}::uuid, 'stale', NULL,
        'stale:-', ${end.toISOString()}::timestamptz, ${nightEnd.toISOString()}::timestamptz)
      ON CONFLICT (device_id, day, assigned_site_id, match_key) DO UPDATE SET last_observed_at = EXCLUDED.last_observed_at`);
  }
}

describe('presence days (S§10.1)', () => {
  it('writes one day row per device per (assigned site, match key), throttled to once per 60 min, in the device org only', async () => {
    pinClockInsideOneUtcDay(11 * 60_000);
    const f = await scenario();
    const other = await scenario();
    const now = new Date();
    await evaluateOrgPresence(f.orgId, now);
    await evaluateOrgPresence(f.orgId, new Date(now.getTime() + 10 * 60_000));
    const today = now.toISOString().slice(0, 10);
    expect(await daysOf(f.ids.MIS1!)).toEqual([expect.objectContaining({ day: today, state: 'visiting', matched_site_id: f.siteB,
      match_key: `visiting:${f.siteB}`, observation_count: 1, org_id: f.orgId })]);
    expect(await daysOf(f.ids.W1!)).toEqual([expect.objectContaining({ state: 'home', match_key: 'home:-', observation_count: 1 })]);
    // Another org's devices are untouched by this org's evaluation.
    const [untouched] = await admin<{ n: number }>(sql`SELECT count(*)::int AS n FROM topology_device_presence_days WHERE org_id = ${other.orgId}::uuid`);
    expect(untouched!.n).toBe(0);

    // Once the row is an hour old, the next evaluation extends it.
    await admin(sql`UPDATE topology_device_presence_days SET first_observed_at = first_observed_at - interval '61 minutes',
      last_observed_at = last_observed_at - interval '61 minutes' WHERE device_id = ${f.ids.MIS1!}::uuid`);
    const later = new Date(now.getTime() + 11 * 60_000);
    await evaluateOrgPresence(f.orgId, later);
    const [extended] = await daysOf(f.ids.MIS1!);
    expect(extended).toMatchObject({ observation_count: 2 });
    expect(new Date(extended!.last_observed_at).toISOString()).toBe(later.toISOString());
  });

  it('the worker fans out per org and is idempotent within the throttle', async () => {
    pinClockInsideOneUtcDay(2 * 60_000);
    const f = await scenario();
    const other = await scenario();
    // Sort both orgs first among whatever else this shared test database holds.
    await admin(sql`UPDATE topology_org_presence_state SET dirty_at = '2000-01-01T00:00:00Z' WHERE org_id IN (${f.orgId}::uuid, ${other.orgId}::uuid)`);
    const now = new Date();
    await runTopologyPresenceTick(now);
    await admin(sql`UPDATE topology_org_presence_state SET dirty_at = '2000-01-01T00:00:00Z' WHERE org_id IN (${f.orgId}::uuid, ${other.orgId}::uuid)`);
    await runTopologyPresenceTick(new Date(now.getTime() + 2 * 60_000));
    for (const org of [f, other]) {
      const rows = await daysOf(org.ids.MIS1!);
      expect(rows).toEqual([expect.objectContaining({ observation_count: 1, org_id: org.orgId, state: 'visiting' })]);
    }
  });

  it('caps a device at 8 rows per day', async () => {
    const f = await scenario();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    for (let i = 0; i < 8; i++) {
      await admin(sql`INSERT INTO topology_device_presence_days (org_id, device_id, day, assigned_site_id, state, match_key, first_observed_at, last_observed_at)
        VALUES (${f.orgId}::uuid, ${f.ids.MIS1!}::uuid, ${today}::date, ${f.siteA}::uuid, 'unrecognized', ${`unrecognized:filler-${i}`}, now(), now())`);
    }
    await evaluateOrgPresence(f.orgId, now);
    const rows = await daysOf(f.ids.MIS1!);
    expect(rows).toHaveLength(8);
    expect(rows.some((r) => r.state === 'visiting')).toBe(false);
    // Another device is unaffected by MIS1's cap.
    expect(await daysOf(f.ids.MIS2!)).toHaveLength(1);
  });

  it('prunes rows older than 35 days, at most the batch limit per call', async () => {
    const f = await scenario();
    const now = new Date();
    const old = new Date(now.getTime() - 36 * 24 * HOUR).toISOString().slice(0, 10);
    const recent = new Date(now.getTime() - 34 * 24 * HOUR).toISOString().slice(0, 10);
    for (const day of [old, recent]) {
      await admin(sql`INSERT INTO topology_device_presence_days (org_id, device_id, day, assigned_site_id, state, match_key, first_observed_at, last_observed_at)
        VALUES (${f.orgId}::uuid, ${f.ids.W1!}::uuid, ${day}::date, ${f.siteA}::uuid, 'home', 'home:-', ${`${day}T08:00:00Z`}::timestamptz, ${`${day}T09:00:00Z`}::timestamptz)`);
    }
    expect(await prunePresenceDays(now)).toBeGreaterThanOrEqual(1);
    expect((await daysOf(f.ids.W1!)).map((r) => r.day)).toEqual([recent]);
  });
});

describe('wrong-site suggestions (S§10.2)', () => {
  it('8 seeded days + today visiting Lakeside → suggestion with days 9; a home row in between → none; the laptop with 3 days → none', async () => {
    const f = await scenario();
    const now = new Date();
    await seedVisits(f, 'MIS1', 8, now);
    await seedVisits(f, 'MIS2', 8, now, { homeOnDay: 4 });
    await evaluateOrgPresence(f.orgId, now);
    const mis1 = await suggestionOf(f.ids.MIS1!);
    expect(mis1).toMatchObject({ suggested_site_id: f.siteB, suggestion_days: 9 });
    expect(new Date(mis1!.suggestion_first_at!).getTime()).toBe(now.getTime() - 8 * 24 * HOUR - 10 * HOUR);
    expect(await suggestionOf(f.ids.MIS2!)).toMatchObject({ suggested_site_id: null, suggestion_days: null });
    expect(await suggestionOf(f.ids.LAP!)).toMatchObject({ suggested_site_id: null });
    // A suggestion only: nothing moved.
    const [device] = await admin<{ site_id: string }>(sql`SELECT site_id::text AS site_id FROM devices WHERE id = ${f.ids.MIS1!}::uuid`);
    expect(device!.site_id).toBe(f.siteA);
  });

  it('rule 6: once a second site declares the prefix, the suggestion is not stored', async () => {
    const f = await scenario();
    const now = new Date();
    await seedVisits(f, 'MIS1', 8, now);
    await evaluateOrgPresence(f.orgId, now);
    expect(await suggestionOf(f.ids.MIS1!)).toMatchObject({ suggested_site_id: f.siteB });
    // Main Office also declares Lakeside's prefix: ambiguous, so Lakeside is no longer uniquely anchored.
    await f.scoped(() => getTestDb().execute(sql`INSERT INTO network_baselines (org_id, site_id, subnet) VALUES (${f.orgId}::uuid, ${f.siteA}::uuid, '10.1.5.0/24')`));
    await evaluateOrgPresence(f.orgId, new Date(now.getTime() + 5 * 60_000));
    expect(await suggestionOf(f.ids.MIS1!)).toMatchObject({ suggested_site_id: null });
  });

  it('a suggestion stops being stored once it is no longer eligible', async () => {
    const f = await scenario();
    const now = new Date();
    await seedVisits(f, 'MIS1', 8, now);
    await evaluateOrgPresence(f.orgId, now);
    expect(await suggestionOf(f.ids.MIS1!)).toMatchObject({ suggested_site_id: f.siteB });
    await admin(sql`INSERT INTO topology_device_presence_days (org_id, device_id, day, assigned_site_id, state, match_key, first_observed_at, last_observed_at)
      VALUES (${f.orgId}::uuid, ${f.ids.MIS1!}::uuid, ${new Date(now.getTime() - 3 * 24 * HOUR).toISOString().slice(0, 10)}::date, ${f.siteA}::uuid,
        'home', 'home:-', ${new Date(now.getTime() - 3 * 24 * HOUR).toISOString()}::timestamptz, ${new Date(now.getTime() - 3 * 24 * HOUR).toISOString()}::timestamptz)`);
    await evaluateOrgPresence(f.orgId, new Date(now.getTime() + 5 * 60_000));
    expect(await suggestionOf(f.ids.MIS1!)).toMatchObject({ suggested_site_id: null, suggestion_days: null });
  });

  it('confirmed device gets no suggestion; moving it clears the confirmation and the presence row', async () => {
    const f = await scenario();
    const now = new Date();
    await seedVisits(f, 'MIS1', 8, now);
    await admin(sql`UPDATE devices SET site_assignment_confirmed_at = now() WHERE id = ${f.ids.MIS1!}::uuid`);
    await evaluateOrgPresence(f.orgId, now);
    expect(await suggestionOf(f.ids.MIS1!)).toMatchObject({ suggested_site_id: null });

    await f.scoped(() => getTestDb().execute(sql`UPDATE devices SET site_id = ${f.siteB}::uuid WHERE id = ${f.ids.MIS1!}::uuid`));
    const [device] = await admin<{ c: unknown }>(sql`SELECT site_assignment_confirmed_at AS c FROM devices WHERE id = ${f.ids.MIS1!}::uuid`);
    expect(device!.c).toBeNull();
    expect(await suggestionOf(f.ids.MIS1!)).toBeUndefined();
  });
});
