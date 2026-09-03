import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  authMiddlewareMock,
  requireScopeMock,
  requirePermissionMock,
  requireMfaMock,
  siteDenied,
  guardMock,
  pamGuardMock,
  captureExceptionMock,
  schedulePeripheralPolicyDeviceMock,
} = vi.hoisted(() => ({
  guardMock: vi.fn(),
  pamGuardMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  schedulePeripheralPolicyDeviceMock: vi.fn().mockResolvedValue('job-id'),
  authMiddlewareMock: vi.fn(),
  requireScopeMock: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermissionMock: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfaMock: vi.fn(() => async (_c: any, next: any) => next()),
  siteDenied: Symbol('SITE_ACCESS_DENIED'),
}));

vi.mock('../../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice: schedulePeripheralPolicyDeviceMock,
}));

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: authMiddlewareMock,
  requireScope: requireScopeMock,
  requirePermission: requirePermissionMock,
  requireMfa: requireMfaMock,
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: siteDenied,
  stripSensitiveDeviceFields: (d: any) => d,
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../agentWs', () => ({
  disconnectAgent: vi.fn(() => true),
}));

vi.mock('../../services/deviceLinkGroups', () => ({
  dissolveLinkGroupIfBelowMinimum: vi.fn(async () => false),
}));

vi.mock('../../services/sentry', () => ({
  captureException: captureExceptionMock,
}));

// Task 13 (#3776): the locked currency guard is unit-tested on its own
// (services/ticketMoveCurrencyGuard.test.ts); here it is a mock so the route's
// sequencing, 409 mapping, and permission gate can be asserted in isolation.
vi.mock('../../services/ticketMoveCurrencyGuard', async () => {
  const actual = await vi.importActual<typeof import('../../services/ticketMoveCurrencyGuard')>(
    '../../services/ticketMoveCurrencyGuard',
  );
  return { ...actual, assertTicketMoveCurrencyCompatible: guardMock };
});

vi.mock('../../services/pamDeviceMoveGuard', async () => {
  const actual = await vi.importActual<typeof import('../../services/pamDeviceMoveGuard')>(
    '../../services/pamDeviceMoveGuard',
  );
  return { ...actual, assertPamDeviceOrgMoveAllowed: pamGuardMock };
});

vi.mock('../../extensions/tenancyRegistry', () => ({
  withExtensionDeviceCascade: (core: readonly string[]) => [...core],
  withExtensionDeviceOrgDenormalized: (core: readonly string[]) => [...core],
  withExtensionDeviceOrgMoveDelete: (core: readonly string[]) => ['demo_things', ...core],
}));

import { db } from '../../db';
import { getDeviceWithOrgAndSiteCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { disconnectAgent } from '../agentWs';
import { dissolveLinkGroupIfBelowMinimum } from '../../services/deviceLinkGroups';
import { moveOrgRoutes } from './moveOrg';
import { TicketMoveCurrencyBlockedError } from '../../services/ticketMoveCurrencyGuard';
import { PamDeviceMoveBlockedError } from '../../services/pamDeviceMoveGuard';
import {
  CUSTOM_ORG_REWRITE_TABLES,
  getDeviceOrgDenormalizedTables,
  DEVICE_ORG_FK_CASCADE_TABLES,
  getDeviceOrgMoveDeleteTables,
  DEVICE_SITE_DENORMALIZED_TABLES,
} from './core';

// Snapshot the gate registration BEFORE any `vi.clearAllMocks()` runs.
// requireScope/requirePermission/requireMfa run at module-import time as the
// route file builds its handler chain, so by the time the first test runs
// the calls are already on the mock. We capture them here so the assertions
// survive beforeEach's clearAllMocks.
const registeredScopeCalls: string[][] = (requireScopeMock.mock.calls as unknown as unknown[][]).map(
  (c) => c.flat().map((v) => String(v)),
);
const registeredPermResources: string[] = (requirePermissionMock.mock.calls as unknown as unknown[][]).map(
  (c) => c.map((v) => String(v)).join(':'),
);
const registeredMfaCallCount = requireMfaMock.mock.calls.length;

const SOURCE_ORG = '11111111-1111-4111-8111-111111111111';
const TARGET_ORG = '22222222-2222-4222-8222-222222222222';
const SOURCE_SITE = '33333333-3333-4333-8333-333333333333';
const TARGET_SITE = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_PARTNER_TARGET_ORG = '66666666-6666-4666-8666-666666666666';

const SAMPLE_DEVICE = {
  id: DEVICE_ID,
  agentId: 'agent-abc-123',
  orgId: SOURCE_ORG,
  siteId: SOURCE_SITE,
  hostname: 'host-1',
  displayName: 'Host One',
  status: 'online' as const,
  customFields: null,
};

function setAuth(overrides: Partial<{
  scope: 'organization' | 'partner' | 'system';
  canAccessOrg: (id: string) => boolean;
  /** Resolved permission set requirePermission stores on the context (auth.ts). */
  permissions: { resource: string; action: string }[];
}> = {}) {
  authMiddlewareMock.mockImplementation((c: any, next: any) => {
    c.set('permissions', { permissions: overrides.permissions ?? [{ resource: '*', action: '*' }] });
    c.set('auth', {
      user: { id: 'user-1', email: 't@example.com' },
      scope: overrides.scope ?? 'partner',
      orgId: SOURCE_ORG,
      partnerId: 'partner-1',
      accessibleOrgIds: [SOURCE_ORG, TARGET_ORG],
      canAccessOrg: overrides.canAccessOrg ?? ((id: string) => id === SOURCE_ORG || id === TARGET_ORG),
      orgCondition: () => undefined,
      token: {},
    });
    return next();
  });
}

// db.select() is used twice in the happy path:
//   1) to load source/target organizations (returns array of org rows)
//   2) to look up the target site (returns array with one site row)
// Each call to .from(...).where(...) returns a thenable resolving to an array.
// Org rows of the CURRENT test, shared with the in-transaction org SHARE
// barrier (#3778): readOrgStampingDefaultsMany locks both orgs ascending by id
// before anything else in the move transaction, and the currency guard now
// compares those locked values rather than the pre-transaction read.
let currentOrgRows: Array<{ id: string; partnerId: string; name?: string; currencyCode?: string }> = [];
/** Org ids that exist in the PRE-transaction read but are gone by the time the
 *  in-transaction SHARE barrier locks them (#3778 finding 7): an org deleted
 *  between the two reads. readOrgStampingDefaultsMany omits such ids from its
 *  map by design, so the route must guard instead of `!`-asserting. */
let barrierMissingOrgIds = new Set<string>();

function rigOrgAndSiteSelects(opts: {
  orgRows: Array<{ id: string; partnerId: string; name?: string; currencyCode?: string }>;
  siteRow: { id: string } | null;
}) {
  currentOrgRows = opts.orgRows;
  let call = 0;
  vi.mocked(db.select).mockImplementation(() => {
    const idx = call++;
    if (idx === 0) {
      // organizations lookup uses `.from(organizations).where(...)` (no limit).
      // Orgs default to USD/USD so the currency guard short-circuits unless a
      // test sets them apart.
      const where = vi.fn().mockResolvedValue(
        opts.orgRows.map((r) => ({ name: `Org ${r.id.slice(0, 4)}`, currencyCode: 'USD', ...r })),
      );
      return { from: vi.fn().mockReturnValue({ where }) } as never;
    }
    // sites lookup uses `.from(sites).where(...).limit(1)`
    const limit = vi.fn().mockResolvedValue(opts.siteRow ? [opts.siteRow] : []);
    const where = vi.fn().mockReturnValue({ limit });
    return { from: vi.fn().mockReturnValue({ where }) } as never;
  });
}

/**
 * Flatten a Drizzle sql`` object into readable text. StringChunks carry a
 * string[] `value`, sql.identifier Names carry a string `value`, nested SQL
 * (subqueries) carries its own queryChunks, and raw bound params are pushed
 * as-is (same chunk shapes as documented in cascadeDelete.test.ts).
 */
function sqlToText(q: any): string {
  const chunks = q?.queryChunks ?? [];
  return chunks
    .map((ch: any) => {
      if (ch !== null && typeof ch === 'object') {
        if (Array.isArray(ch.queryChunks)) return sqlToText(ch);
        if (Array.isArray(ch.value)) return ch.value.join('');
        if ('value' in ch) return String(ch.value);
      }
      return String(ch);
    })
    .join('');
}

const BOUND_TICKET_ID = '77777777-7777-4777-8777-777777777777';

function rigTransactionSuccess(
  updatedRow: any = { ...SAMPLE_DEVICE, orgId: TARGET_ORG, siteId: TARGET_SITE },
  deviceUpdateError?: unknown,
) {
  // Each tx.execute() call captures the identifier name being UPDATEd (the
  // second chunk in our `UPDATE ${sql.identifier(table)} SET org_id = ...`
  // template — Drizzle exposes it as queryChunks[1].value) plus the full
  // flattened statement text for shape assertions.
  const updatedTables: string[] = [];
  const statements: string[] = [];
  const deviceUpdateSets: any[] = [];
  let barrierReads = 0;

  vi.mocked(db.transaction).mockImplementation(async (cb: any) => {
    const tx = {
      update: vi.fn().mockImplementation(() => {
        statements.push('UPDATE devices');
        return {
        set: vi.fn().mockImplementation((vals: any) => {
          deviceUpdateSets.push(vals);
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockImplementation(() => deviceUpdateError
                ? Promise.reject(deviceUpdateError)
                : Promise.resolve([updatedRow])),
            }),
          };
        }),
        };
      }),
      execute: vi.fn().mockImplementation(async (sqlVal: any) => {
        const tableChunk = sqlVal?.queryChunks?.[1];
        if (tableChunk && typeof tableChunk.value === 'string') {
          updatedTables.push(tableChunk.value);
        }
        statements.push(sqlToText(sqlVal));
        return [];
      }),
      // #3776 — the ticket-id lookup feeding the currency guard
      // (`tx.select({id}).from(tickets).where(deviceId = …)`). Records the
      // position so lock-order assertions can place it against the UPDATEs.
      select: vi.fn().mockImplementation(() => ({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => ({
            // Awaited directly => the ticket-id lookup feeding the currency guard.
            then: (res: any, rej: any) => {
              statements.push(`SELECT tickets.id (after ${updatedTables.length} updates)`);
              return Promise.resolve([{ id: BOUND_TICKET_ID }]).then(res, rej);
            },
            // `.limit(1).for('share')` => the org SHARE barrier (#3778), served
            // in ascending-id order from this test's org rows.
            limit: vi.fn(() => ({
              for: vi.fn((mode: string) => {
                statements.push(`SELECT organizations FOR ${mode} (after ${updatedTables.length} updates)`);
                const ordered = [...currentOrgRows].sort((a, b) => a.id.localeCompare(b.id));
                const row = ordered[barrierReads++];
                if (!row || barrierMissingOrgIds.has(row.id)) return Promise.resolve([]);
                return Promise.resolve([{ currencyCode: row.currencyCode ?? 'USD' }]);
              }),
            })),
          })),
        }),
      })),
    };
    await cb(tx);
    return updatedRow;
  });
  return { updatedTables, statements, deviceUpdateSets };
}

describe('POST /devices/:id/move-org', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    barrierMissingOrgIds = new Set<string>();
    guardMock.mockReset();
    guardMock.mockResolvedValue(null);
    pamGuardMock.mockReset();
    pamGuardMock.mockResolvedValue(undefined);
    setAuth();
    app = new Hono();
    app.route('/devices', moveOrgRoutes);
  });

  describe('gate registration', () => {
    it('requires partner+system scope, devices:write, organizations:write, and MFA', () => {
      // requireScope called once with (partner, system) — at minimum, those
      // two values must appear in the flattened argument list.
      expect(
        registeredScopeCalls.some((a) => a.includes('partner') && a.includes('system')),
      ).toBe(true);
      expect(registeredPermResources).toContain('devices:write');
      expect(registeredPermResources).toContain('organizations:write');
      expect(registeredMfaCallCount).toBeGreaterThan(0);
    });
  });

  describe('happy path', () => {
    it('moves the device and writes audit on both orgs', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { updatedTables, statements, deviceUpdateSets } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.device.orgId).toBe(TARGET_ORG);
      expect(body.device.siteId).toBe(TARGET_SITE);
      expect(schedulePeripheralPolicyDeviceMock).toHaveBeenCalledWith(
        DEVICE_ID,
        'device_org_changed',
      );

      // devices.set() must include both orgId and siteId flips, and MUST
      // unlink the device from any multi-boot group (#2138) — the composite
      // FK (link_group_id, org_id) -> device_link_groups(id, org_id) would
      // otherwise reject the org flip.
      expect(deviceUpdateSets[0]).toMatchObject({
        orgId: TARGET_ORG,
        siteId: TARGET_SITE,
        linkGroupId: null,
        // #2308 - role travels with membership: a stale host/guest value
        // left behind would poison the device's next link in the new org.
        linkGroupRole: null,
      });

      // Two audit events, one per org
      expect(writeRouteAudit).toHaveBeenCalledTimes(2);
      const auditOrgIds = vi.mocked(writeRouteAudit).mock.calls.map((c) => (c[1] as any).orgId);
      expect(auditOrgIds).toContain(SOURCE_ORG);
      expect(auditOrgIds).toContain(TARGET_ORG);
      const auditActions = vi.mocked(writeRouteAudit).mock.calls.map((c) => (c[1] as any).action);
      expect(auditActions).toContain('device.move_org.source');
      expect(auditActions).toContain('device.move_org.target');

      // Every denormalized table got an UPDATE issued in the transaction.
      // This is the unit-test proxy for "RLS will read from the new org
      // only post-move": each row in those tables has its org_id rewritten
      // to the new org, so RLS in the OLD org no longer matches it.
      // CUSTOM_ORG_REWRITE_TABLES (time_entries, ticket_parts,
      // ticket_alert_links, ticket_outbox, ticket_attachments,
      // ticket_email_links — no device_id column, each rewritten via a
      // ticket_id or alert_id join) follow the generic org loop, and this
      // spread is what pins the hand-written statements to that array's
      // ORDER, which is the cross-axis lock order (#4657, #4743, #4643). The SITE
      // loop runs last and any table in DEVICE_SITE_DENORMALIZED_TABLES
      // appears in updatedTables a second time for the site_id rewrite.
      expect(updatedTables).toEqual([
        ...getDeviceOrgDenormalizedTables().filter(
          (table) => !DEVICE_ORG_FK_CASCADE_TABLES.includes(table as never),
        ),
        ...getDeviceOrgMoveDeleteTables(),
        ...CUSTOM_ORG_REWRITE_TABLES,
        ...DEVICE_SITE_DENORMALIZED_TABLES,
      ]);
      expect(getDeviceOrgDenormalizedTables()).toContain('agent_health_observations');
      // agent_rollback_events (#4371 fixup) and peripheral_policy_delivery_
      // events (#4806 fixup): restamped by the SECURITY DEFINER breeze_
      // cascade_device_org_id() trigger, not this loop's app-role UPDATE —
      // see the doc comment on DEVICE_ORG_FK_CASCADE_TABLES.
      expect(DEVICE_ORG_FK_CASCADE_TABLES).toEqual([
        'agent_health_observations',
        'software_inventory_observations',
        'agent_rollback_events',
        'peripheral_policy_delivery_events',
      ]);

      expect(statements).toContain(
        `DELETE FROM demo_things WHERE device_id = ${DEVICE_ID}`,
      );

      // After the move, the live WS for this agent MUST be closed so the
      // reconnect handshake resolves the new org_id. Otherwise every
      // subsequent runWithAgentDbAccess call writes telemetry under the OLD
      // org's RLS context until natural reconnect (could be hours).
      expect(disconnectAgent).toHaveBeenCalledWith(
        'agent-abc-123',
        expect.any(Number),
        expect.stringContaining('different organization'),
      );
    });

    it('dissolves the source link group when moving a linked boot profile (#2138)', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
        ...SAMPLE_DEVICE,
        linkGroupId: 'grp-multiboot-1',
      } as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });

      expect(res.status).toBe(200);
      // The group the device left behind may now have a single lone profile —
      // moveOrg must run the dissolve check inside the transaction. Dropping
      // this call silently strands a 1-member group (re-linking the survivor
      // later 409s with no visible reason).
      expect(dissolveLinkGroupIfBelowMinimum).toHaveBeenCalledTimes(1);
      expect(vi.mocked(dissolveLinkGroupIfBelowMinimum).mock.calls[0]![1]).toBe('grp-multiboot-1');
    });

    it('rewrites ticket_alert_links org_id via the alert join inside the transaction', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      // ticket_alert_links denormalizes org_id for RLS but has NO device_id
      // column, so the generic getDeviceOrgDenormalizedTables() loop can't
      // reach it. Without this dedicated rewrite, links for the moved
      // device's alerts stay under the OLD org's RLS and disappear from the
      // new org's ticket views (tenant-isolation bug).
      const linkRewrites = statements.filter((s) => s.startsWith('UPDATE ticket_alert_links '));
      expect(
        linkRewrites,
        `Expected exactly one ticket_alert_links org_id rewrite.\nStatements:\n${statements.join('\n')}`,
      ).toEqual([
        `UPDATE ticket_alert_links SET org_id = ${TARGET_ORG}::uuid ` +
          `WHERE alert_id IN (SELECT id FROM alerts WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);
    });

    it('rewrites ticket_attachments org_id via the tickets join inside the transaction (W08)', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      const rewrites = statements.filter((s) => s.startsWith('UPDATE ticket_attachments '));
      expect(
        rewrites,
        `Expected exactly one ticket_attachments org_id rewrite.\nStatements:\n${statements.join('\n')}`,
      ).toEqual([
        `UPDATE ticket_attachments SET org_id = ${TARGET_ORG}::uuid ` +
          `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);
      // Lock order: attachments must come AFTER ticket_parts in this path so
      // the device-move and ticket-move paths agree (moveOrg.ts:~311).
      const idx = (t: string) => statements.findIndex((s) => s.startsWith(`UPDATE ${t} `));
      expect(idx('ticket_parts')).toBeLessThan(idx('ticket_attachments'));
    });

    it('rewrites ticket_outbox org_id via the tickets join inside the transaction (#4743)', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      // ticket_outbox denormalizes org_id for RLS but has NO device_id
      // column, so the generic getDeviceOrgDenormalizedTables() loop can't
      // reach it. Without this dedicated rewrite, an unpublished outbox row
      // for the moved device's ticket keeps routing to the OLD org's
      // helpdesk agents after the move (same class as #4643).
      const rewrites = statements.filter((s) => s.startsWith('UPDATE ticket_outbox '));
      expect(
        rewrites,
        `Expected exactly one ticket_outbox org_id rewrite.\nStatements:\n${statements.join('\n')}`,
      ).toEqual([
        `UPDATE ticket_outbox SET org_id = ${TARGET_ORG}::uuid ` +
          `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);
      // Lock order: ticket_outbox must come BEFORE ticket_attachments in this
      // path, mirroring its position in TICKET_ORG_DENORMALIZED_TABLES
      // (ticketService.ts) — '...ticket_alert_links', 'ticket_outbox',
      // 'ticket_attachments'] — so the device-move and ticket-move paths
      // agree on relative lock order (moveOrg.ts:~311).
      const idx2 = (t: string) => statements.findIndex((s) => s.startsWith(`UPDATE ${t} `));
      expect(idx2('ticket_outbox')).toBeLessThan(idx2('ticket_attachments'));
    });

    it('rewrites ticket_email_links org_id via the tickets join inside the transaction (#4643)', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      // ticket_email_links denormalizes org_id for RLS but has NO device_id
      // column, so the generic getDeviceOrgDenormalizedTables() loop can't
      // reach it. Without this dedicated rewrite, the moved device's ticket
      // email-link rows stay under the OLD org's RLS after the move.
      const rewrites = statements.filter((s) => s.startsWith('UPDATE ticket_email_links '));
      expect(
        rewrites,
        `Expected exactly one ticket_email_links org_id rewrite.\nStatements:\n${statements.join('\n')}`,
      ).toEqual([
        `UPDATE ticket_email_links SET org_id = ${TARGET_ORG}::uuid ` +
          `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);
      // Lock order: email_links must come AFTER ticket_attachments in this
      // path so the device-move and ticket-move paths agree (moveOrg.ts:~311).
      const idx = (t: string) => statements.findIndex((s) => s.startsWith(`UPDATE ${t} `));
      expect(idx('ticket_attachments')).toBeLessThan(idx('ticket_email_links'));
    });

    it('detaches ai_agent_runs.ticket_id via the tickets join, before tickets are re-stamped (#4215)', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      // Agent-run history stays with the SOURCE org, so every FK pointing at a
      // row that moves WITH the device must be severed. `ticket_id` is
      // unreachable from the device-keyed detach: ticket-triggered runs carry
      // a ticket_id with a NULL device_id, so they need their own statement
      // keyed off the ticket's device_id.
      // Collapse BEFORE filtering: the source formats these statements across
      // two lines, so filtering on the raw text would silently yield [] if the
      // template were ever reflowed to `UPDATE ai_agent_runs\n  SET ...`.
      const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
      const runDetaches = statements
        .map(collapse)
        .filter((s) => s.startsWith('UPDATE ai_agent_runs '));
      expect(
        runDetaches,
        `Expected the device-keyed run detach plus the ticket-keyed one.\nStatements:\n${statements.join('\n')}`,
      ).toEqual([
        'UPDATE ai_agent_runs SET device_id = NULL, alert_id = NULL, session_id = NULL, ' +
          `anomaly_incident_id = NULL WHERE device_id = ${DEVICE_ID}::uuid`,
        'UPDATE ai_agent_runs SET ticket_id = NULL ' +
          `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);

      // Position is pinned to mirror breeze_cascade_device_org_id()'s internal
      // order, where it IS load-bearing. It is not load-bearing here: that
      // trigger fires on the devices UPDATE and has already restamped
      // tickets.org_id (and run this detach) before any of these statements is
      // sent. Kept so the route stays correct on its own without the trigger.
      const detachIdx = statements.findIndex((s) => s.startsWith('UPDATE ai_agent_runs SET ticket_id'));
      const ticketsIdx = statements.findIndex((s) => s.startsWith('UPDATE tickets '));
      expect(detachIdx).toBeGreaterThanOrEqual(0);
      expect(ticketsIdx).toBeGreaterThanOrEqual(0);
      expect(detachIdx).toBeLessThan(ticketsIdx);
    });

    it('nulls the reverse pointer ticket_comments.agent_run_id via the tickets join (#4644)', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      // ticket_comments has no org_id (child-via-parent tenancy through
      // tickets), so a comment on a ticket bound to the moving device travels
      // to the target org via the generic denormalized-table loop while the
      // run it names stays with the SOURCE org — same reverse-pointer class as
      // metric_anomaly_incidents above, keyed off the same tickets join the
      // ai_agent_runs.ticket_id detach uses.
      const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
      const rewrites = statements.map(collapse).filter((s) => s.startsWith('UPDATE ticket_comments '));
      expect(
        rewrites,
        `Expected exactly one ticket_comments reverse-pointer detach.\nStatements:\n${statements.join('\n')}`,
      ).toEqual([
        'UPDATE ticket_comments SET agent_run_id = NULL WHERE agent_run_id IS NOT NULL ' +
          `AND ticket_id IN (SELECT id FROM tickets WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);

      // Not load-bearing (same reasoning as the ai_agent_runs.ticket_id detach
      // above: the join key is tickets.device_id, untouched by the generic
      // org_id loop), but placed alongside the other reverse pointers for
      // readability — must run before the generic denormalized-table rewrite.
      const detachIdx = statements.findIndex((s) => s.startsWith('UPDATE ticket_comments SET agent_run_id'));
      const ticketsIdx = statements.findIndex((s) => s.startsWith('UPDATE tickets '));
      expect(detachIdx).toBeGreaterThanOrEqual(0);
      expect(ticketsIdx).toBeGreaterThanOrEqual(0);
      expect(detachIdx).toBeLessThan(ticketsIdx);
    });

    it('rewrites time_entries org_id via the ticket join inside the transaction', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      // time_entries denormalizes org_id for filtering but has NO device_id
      // column — rewritten via the ticket join (Phase 3 spec §2 / same
      // stranded-org_id class as ticket_alert_links, #1261).
      const timeEntryRewrites = statements.filter((s) => s.startsWith('UPDATE time_entries '));
      expect(
        timeEntryRewrites,
        `Expected exactly one time_entries org_id rewrite.\nStatements:\n${statements.join('\n')}`,
      ).toEqual([
        `UPDATE time_entries SET org_id = ${TARGET_ORG}::uuid ` +
          `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);
    });

    it('rewrites ticket_parts org_id via the ticket join inside the transaction', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      const { statements } = rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);

      // ticket_parts denormalizes org_id for RLS but has NO device_id column
      // — rewritten via the ticket join (Phase 3 spec §2 / same
      // stranded-org_id class as ticket_alert_links, #1261).
      const partsRewrites = statements.filter((s) => s.startsWith('UPDATE ticket_parts '));
      expect(
        partsRewrites,
        `Expected exactly one ticket_parts org_id rewrite.\nStatements:\n${statements.join('\n')}`,
      ).toEqual([
        `UPDATE ticket_parts SET org_id = ${TARGET_ORG}::uuid ` +
          `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = ${DEVICE_ID}::uuid)`,
      ]);
    });

    it('writes device.move_org.failed audit when the transaction rolls back', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      // Force the transaction to throw — simulates an FK violation or DB hiccup mid-cascade
      vi.mocked(db.transaction).mockImplementationOnce(async () => {
        throw new Error('simulated DB error mid-cascade');
      });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });

      expect(res.status).toBe(500);

      // Exactly one failure-audit row on the source org (target never committed)
      expect(writeRouteAudit).toHaveBeenCalledTimes(1);
      const auditCall = vi.mocked(writeRouteAudit).mock.calls[0]?.[1] as any;
      expect(auditCall?.action).toBe('device.move_org.failed');
      expect(auditCall?.orgId).toBe(SOURCE_ORG);

      // No WS disconnect on failure (device never actually moved)
      expect(disconnectAgent).not.toHaveBeenCalled();
    });
  });

  describe('PAM ownership move guard', () => {
    const postMove = () => app.request(`/devices/${DEVICE_ID}/move-org`, {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
    });

    function rigMove() {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: { id: TARGET_SITE },
      });
    }

    it('runs after both organization SHARE locks and before the device update', async () => {
      rigMove();
      const { statements } = rigTransactionSuccess();
      pamGuardMock.mockImplementation(async () => {
        statements.push('PAM guard');
      });

      const response = await postMove();

      expect(response.status).toBe(200);
      // #4596 — the transaction's unconditional leading statement is
      // `SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk
      // DEFERRED` (see moveOrg.ts, right after `db.transaction(async (tx) => {`).
      // It takes no table locks and runs before anything else in the callback,
      // so it always occupies index 0 regardless of the PAM guard/lock
      // ordering asserted below — assert it explicitly rather than folding it
      // into the positional slice.
      expect(statements[0]).toBe(
        'SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk DEFERRED',
      );
      expect(statements.slice(1, 5)).toEqual([
        'SELECT organizations FOR share (after 0 updates)',
        'SELECT organizations FOR share (after 0 updates)',
        'PAM guard',
        'UPDATE devices',
      ]);
      expect(pamGuardMock).toHaveBeenCalledWith(expect.anything(), {
        deviceId: DEVICE_ID,
        sourceOrgId: SOURCE_ORG,
      });
    });

    it('#4596: defers the two ticket/org composite FKs BY NAME as the first statement', async () => {
      rigMove();
      const { statements } = rigTransactionSuccess();

      const response = await postMove();

      expect(response.status).toBe(200);
      expect(statements[0]).toBe(
        'SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk DEFERRED',
      );
      expect(statements.some((s) => /SET CONSTRAINTS ALL/i.test(s))).toBe(false);
    });

    it('returns a stable 409 for the typed preflight conflict and records only its stable code', async () => {
      rigMove();
      rigTransactionSuccess();
      pamGuardMock.mockRejectedValue(new PamDeviceMoveBlockedError());

      const response = await postMove();

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Device organization move is blocked because durable PAM lifecycle evidence exists',
        code: 'PAM_DEVICE_MOVE_BLOCKED',
      });
      expect(captureExceptionMock).not.toHaveBeenCalled();
      expect(disconnectAgent).not.toHaveBeenCalled();
      expect(schedulePeripheralPolicyDeviceMock).not.toHaveBeenCalled();
      expect(writeRouteAudit).toHaveBeenCalledTimes(1);
      expect(vi.mocked(writeRouteAudit).mock.calls[0]![1]).toMatchObject({
        orgId: SOURCE_ORG,
        action: 'device.move_org.failed',
        details: { code: 'PAM_DEVICE_MOVE_BLOCKED' },
      });
    });

    it('maps only the exact database trigger race to the stable 409', async () => {
      rigMove();
      rigTransactionSuccess(undefined, Object.assign(new Error('guard race'), {
        code: '23514',
        constraint_name: 'devices_pam_history_move_guard',
      }));

      const response = await postMove();

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Device organization move is blocked because durable PAM lifecycle evidence exists',
        code: 'PAM_DEVICE_MOVE_BLOCKED',
      });
      expect(captureExceptionMock).not.toHaveBeenCalled();
      expect(disconnectAgent).not.toHaveBeenCalled();
      expect(schedulePeripheralPolicyDeviceMock).not.toHaveBeenCalled();
    });

    it('keeps unrelated 23514 errors on the generic failure path', async () => {
      rigMove();
      const unrelated = Object.assign(new Error('other check'), {
        code: '23514',
        constraint_name: 'some_other_constraint',
      });
      rigTransactionSuccess(undefined, unrelated);

      const response = await postMove();

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Failed to move device between organizations' });
      expect(captureExceptionMock).toHaveBeenCalledWith(unrelated, expect.anything());
      expect(disconnectAgent).not.toHaveBeenCalled();
      expect(schedulePeripheralPolicyDeviceMock).not.toHaveBeenCalled();
    });
  });

  // ── Multi-currency guard (#3776, Task 13) ────────────────────────────────
  describe('ticket currency guard', () => {
    const postBody = (extra: Record<string, unknown> = {}) => ({
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE, ...extra }),
    });
    const crossCurrencyOrgs = [
      { id: SOURCE_ORG, partnerId: 'partner-1', name: 'Alpha', currencyCode: 'USD' },
      { id: TARGET_ORG, partnerId: 'partner-1', name: 'Beta', currencyCode: 'EUR' },
    ];

    it('runs the guard over the device\'s tickets after the tickets UPDATE and before the time_entries rewrite', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({ orgRows: crossCurrencyOrgs, siteRow: { id: TARGET_SITE } });
      const { statements, updatedTables } = rigTransactionSuccess();
      guardMock.mockResolvedValue({ sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 0, unbilledParts: 0, accepted: false });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, postBody());
      expect(res.status).toBe(200);

      expect(guardMock).toHaveBeenCalledTimes(1);
      expect(guardMock.mock.calls[0]![1]).toEqual({
        ticketIds: [BOUND_TICKET_ID],
        sourceCurrency: 'USD',
        targetCurrency: 'EUR',
        targetOrgName: 'Beta',
        acceptCurrencyMismatch: false,
      });

      // Lock order: `tickets` is rewritten by the denormalized loop BEFORE the
      // guard's ticket lookup, and the time_entries/ticket_parts rewrites come
      // AFTER it (tickets → time_entries → ticket_parts).
      const selectIdx = statements.findIndex((s) => s.startsWith('SELECT tickets.id'));
      const ticketsUpdateIdx = statements.findIndex((s) => s.startsWith('UPDATE tickets '));
      const timeEntriesIdx = statements.findIndex((s) => s.startsWith('UPDATE time_entries '));
      const partsIdx = statements.findIndex((s) => s.startsWith('UPDATE ticket_parts '));
      expect(ticketsUpdateIdx).toBeGreaterThanOrEqual(0);
      expect(ticketsUpdateIdx).toBeLessThan(selectIdx);
      expect(selectIdx).toBeLessThan(timeEntriesIdx);
      expect(timeEntriesIdx).toBeLessThan(partsIdx);
      expect(updatedTables).toContain('tickets');

      // Not accepted → no audit flag.
      const sourceAudit = vi.mocked(writeRouteAudit).mock.calls.find((c) => (c[1] as any).action === 'device.move_org.source')![1] as any;
      expect(sourceAudit.details).not.toHaveProperty('currencyMismatchAccepted');
    });

    it('rewrites ticket_alert_links AFTER ticket_parts, matching moveTicketOrg (#4657)', async () => {
      // #4657: this path used to take ticket_alert_links BEFORE
      // time_entries/ticket_parts while moveTicketOrg took it after, and the
      // two select overlapping rows — a ticket_alert_links row joining ticket
      // X to an alert on device D is reached by a device-move of D and by a
      // concurrent moveTicketOrg(X). Opposite order = 40P01 on an admin
      // action. Asserted on the real statement stream, not just the list, so
      // moving the UPDATE without touching CUSTOM_ORG_REWRITE_TABLES is
      // caught here rather than in production.
      //
      // The currency guard is mocked for this whole file, so its own
      // `FOR UPDATE` selects never reach the statement stream — only four of
      // the six hand-written UPDATEs are being ordered here (ticket_outbox's
      // position relative to ticket_attachments, and ticket_email_links'
      // position relative to ticket_attachments, are asserted separately
      // below).
      // Cross-currency orgs are used so the guard resolves rather than
      // short-circuits, putting the statements in the same positions they
      // occupy on a real move; the real guard's lock order is covered by
      // ticketMoveCurrencyGuard.test.ts.
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({ orgRows: crossCurrencyOrgs, siteRow: { id: TARGET_SITE } });
      const { statements } = rigTransactionSuccess();
      guardMock.mockResolvedValue({ sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 0, unbilledParts: 0, accepted: false });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, postBody());
      expect(res.status).toBe(200);

      const idx = (prefix: string) => statements.findIndex((s) => s.startsWith(prefix));
      const timeEntriesIdx = idx('UPDATE time_entries ');
      const partsIdx = idx('UPDATE ticket_parts ');
      const linksIdx = idx('UPDATE ticket_alert_links ');
      const attachmentsIdx = idx('UPDATE ticket_attachments ');

      // Every index must be found first: findIndex returns -1 for a missing
      // statement, and -1 would satisfy the `toBeLessThan` chain below while
      // actually meaning the rewrite was deleted.
      expect(timeEntriesIdx, 'the time_entries rewrite went missing').toBeGreaterThanOrEqual(0);
      expect(partsIdx, 'the ticket_parts rewrite went missing').toBeGreaterThanOrEqual(0);
      expect(linksIdx, 'the ticket_alert_links rewrite went missing').toBeGreaterThanOrEqual(0);
      expect(attachmentsIdx, 'the ticket_attachments rewrite went missing').toBeGreaterThanOrEqual(0);

      // Pairwise, matching the idiom already used for the tickets/time_entries
      // ordering above: time_entries -> ticket_parts -> ticket_alert_links ->
      // ticket_attachments, the same order moveTicketOrg uses (#4657).
      expect(timeEntriesIdx, 'time_entries must precede ticket_parts').toBeLessThan(partsIdx);
      expect(partsIdx, 'ticket_parts must precede ticket_alert_links (#4657)').toBeLessThan(linksIdx);
      expect(linksIdx, 'ticket_alert_links must precede ticket_attachments').toBeLessThan(attachmentsIdx);
    });

    it('409s with code + details when the guard blocks — no Sentry capture, no failed-move audit, no WS disconnect', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({ orgRows: crossCurrencyOrgs, siteRow: { id: TARGET_SITE } });
      rigTransactionSuccess();
      const details = { sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 0, unbilledParts: 1, accepted: false, blockedByCurrency: [{ currencyCode: 'USD', timeEntries: 0, parts: 1 }] };
      guardMock.mockRejectedValue(new TicketMoveCurrencyBlockedError('Cannot move: stranded money', details));

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, postBody());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'Cannot move: stranded money',
        code: 'TICKET_MOVE_CURRENCY_BLOCKED',
        details,
      });
      expect(captureExceptionMock).not.toHaveBeenCalled();
      expect(writeRouteAudit).not.toHaveBeenCalled();
      expect(disconnectAgent).not.toHaveBeenCalled();
    });

    it('403s acceptCurrencyMismatch:true without invoices:write before touching the DB', async () => {
      setAuth({ permissions: [{ resource: 'devices', action: 'write' }, { resource: 'organizations', action: 'write' }] });
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, postBody({ acceptCurrencyMismatch: true }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/invoices:write/);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(guardMock).not.toHaveBeenCalled();
    });

    it('acceptCurrencyMismatch:false never needs invoices:write', async () => {
      setAuth({ permissions: [{ resource: 'devices', action: 'write' }, { resource: 'organizations', action: 'write' }] });
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({ orgRows: crossCurrencyOrgs, siteRow: { id: TARGET_SITE } });
      rigTransactionSuccess();

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, postBody({ acceptCurrencyMismatch: false }));
      expect(res.status).toBe(200);
      expect(guardMock.mock.calls[0]![1]).toMatchObject({ acceptCurrencyMismatch: false });
    });

    it('with invoices:write, acceptCurrencyMismatch:true reaches the guard and the accepted counts land in both audit rows', async () => {
      setAuth({ permissions: [
        { resource: 'devices', action: 'write' },
        { resource: 'organizations', action: 'write' },
        { resource: 'invoices', action: 'write' },
      ] });
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({ orgRows: crossCurrencyOrgs, siteRow: { id: TARGET_SITE } });
      rigTransactionSuccess();
      const accepted = { sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 2, unbilledParts: 1, accepted: true };
      guardMock.mockResolvedValue(accepted);

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, postBody({ acceptCurrencyMismatch: true }));
      expect(res.status).toBe(200);
      expect(guardMock.mock.calls[0]![1]).toMatchObject({ acceptCurrencyMismatch: true });

      expect(writeRouteAudit).toHaveBeenCalledTimes(2);
      for (const call of vi.mocked(writeRouteAudit).mock.calls) {
        expect((call[1] as any).details).toMatchObject({ currencyMismatchAccepted: accepted });
      }
    });

    it('400s a non-boolean acceptCurrencyMismatch', async () => {
      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, postBody({ acceptCurrencyMismatch: 'yes' }));
      expect(res.status).toBe(400);
    });
  });

  describe('org vanished at the in-transaction SHARE barrier (#3778 finding 7)', () => {
    const postBody = () => ({
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
    });
    const orgRows = [
      { id: SOURCE_ORG, partnerId: 'partner-1', name: 'Alpha' },
      { id: TARGET_ORG, partnerId: 'partner-1', name: 'Beta' },
    ];

    it('404s "Target organization not found" instead of a TypeError 500', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({ orgRows, siteRow: { id: TARGET_SITE } });
      rigTransactionSuccess();
      barrierMissingOrgIds.add(TARGET_ORG);

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, postBody());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Target organization not found' });
      // A row deleted under us is not an exception: no Sentry, and the move
      // rolled back so the guard must never have run.
      expect(captureExceptionMock).not.toHaveBeenCalled();
      expect(guardMock).not.toHaveBeenCalled();
      expect(disconnectAgent).not.toHaveBeenCalled();
    });

    it('500s "Source organization not found" (mirrors the pre-transaction check)', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({ orgRows, siteRow: { id: TARGET_SITE } });
      rigTransactionSuccess();
      barrierMissingOrgIds.add(SOURCE_ORG);

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, postBody());
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Source organization not found' });
      expect(guardMock).not.toHaveBeenCalled();
    });
  });

  describe('rejection paths', () => {
    it('returns 404 when the device is not found', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null);
      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(404);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it('returns 403 when caller cannot access the target org', async () => {
      setAuth({ canAccessOrg: (id: string) => id === SOURCE_ORG });
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 403 on a cross-partner move from a partner-scoped caller', async () => {
      setAuth({
        scope: 'partner',
        canAccessOrg: (id: string) => id === SOURCE_ORG || id === OTHER_PARTNER_TARGET_ORG,
      });
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: OTHER_PARTNER_TARGET_ORG, partnerId: 'partner-OTHER' },
        ],
        siteRow: { id: TARGET_SITE },
      });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: OTHER_PARTNER_TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(403);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('allows a cross-partner move when the caller has system scope', async () => {
      setAuth({ scope: 'system', canAccessOrg: () => true });
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: OTHER_PARTNER_TARGET_ORG, partnerId: 'partner-OTHER' },
        ],
        siteRow: { id: TARGET_SITE },
      });
      rigTransactionSuccess({ ...SAMPLE_DEVICE, orgId: OTHER_PARTNER_TARGET_ORG, siteId: TARGET_SITE });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: OTHER_PARTNER_TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(200);
    });

    it('returns 400 when the target site does not belong to the target org', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);
      rigOrgAndSiteSelects({
        orgRows: [
          { id: SOURCE_ORG, partnerId: 'partner-1' },
          { id: TARGET_ORG, partnerId: 'partner-1' },
        ],
        siteRow: null,
      });

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: TARGET_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 400 when the target org equals the source org', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SAMPLE_DEVICE as never);

      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: SOURCE_ORG, siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(400);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('returns 400 for malformed UUIDs in the body', async () => {
      const res = await app.request(`/devices/${DEVICE_ID}/move-org`, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId: 'not-a-uuid', siteId: TARGET_SITE }),
      });
      expect(res.status).toBe(400);
    });
  });
});
