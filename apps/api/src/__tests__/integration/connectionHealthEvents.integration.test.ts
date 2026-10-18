/**
 * Connection health events against real Postgres (spec 2026-10-15 §2.4, W5
 * plan D7–D12). The store's transitions feed the `event_state` outbox and the
 * publisher converges event consumers on each org incident's state: one
 * opened, one resolved, a fresh opened after a published resolve, nothing for
 * seeds, pending rows or partner-wide incidents, and a failed publish leaves
 * the row due.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { connectionHealthIncidents } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';
import { applyActions } from '../../services/connectionHealth/store';
import { publishPendingEvents } from '../../services/connectionHealth/events';
import { healthEventId } from '../../services/connectionHealth/eventPayload';
import type { HealthObservation } from '../../services/connectionHealth/types';

const T0 = new Date('2026-10-15T11:00:00.000Z');
const T1 = new Date('2026-10-15T11:30:00.000Z');
const T2 = new Date('2026-10-15T11:45:00.000Z');

const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

let P: string;
let ORG: string;
const publish = vi.fn();

function obs(over: Partial<HealthObservation> = {}): HealthObservation {
  return {
    sourceKind: 'm365_connection',
    sourceId: 'conn-1',
    partnerId: P,
    orgId: ORG,
    ownerUserId: null,
    state: 'broken',
    severity: 'permanent',
    condition: 'grant_missing',
    detail: 'provider said: token=abc123',
    displayName: 'Contoso tenant',
    fixHref: '/integrations#m365',
    ownerFixHref: null,
    viewPermission: { resource: 'organizations', action: 'read' },
    repairPermission: { resource: 'organizations', action: 'write' },
    observedAt: T0,
    ...over,
  };
}

const row = async (sourceId = 'conn-1') =>
  (await asSystem(() => db.select().from(connectionHealthIncidents).where(eq(connectionHealthIncidents.sourceId, sourceId))))[0]!;
const drain = (now = T2) => publishPendingEvents(now, { publish });
const published = () => publish.mock.calls.map((c) => ({ type: c[0], orgId: c[1], payload: c[2], source: c[3], options: c[4] }));

describe('connection health events', () => {
  beforeEach(async () => {
    publish.mockReset();
    publish.mockResolvedValue('ok');
    P = (await createPartner()).id;
    ORG = (await createOrganization({ partnerId: P })).id;
    await asSystem(() => db.delete(connectionHealthIncidents));
  });

  it('an opened org incident publishes one opened event with the sanitized payload, then nothing', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: true }], T0));
    expect(await drain()).toEqual({ published: 1, failed: 0 });
    const r = await row();
    expect(published()).toEqual([{
      type: 'integration.health_opened',
      orgId: ORG,
      payload: {
        incidentId: r.id,
        orgId: ORG,
        sourceKind: 'm365_connection',
        sourceId: 'conn-1',
        condition: 'grant_missing',
        severity: 'permanent',
        fixHref: '/integrations#m365',
        openedAt: T0.toISOString(),
        resolvedAt: null,
        resolution: null,
      },
      source: 'connection-health',
      options: expect.objectContaining({ eventId: healthEventId(r, 'opened') }),
    }]);
    expect(JSON.stringify(published())).not.toContain('token=abc123');
    expect(JSON.stringify(published())).not.toContain('Contoso tenant');
    expect(r.eventState).toBe('opened');

    publish.mockClear();
    expect(await drain()).toEqual({ published: 0, failed: 0 });
    expect(publish).not.toHaveBeenCalled();
  });

  it('a resolve after a published open publishes resolved; a reopen after that publishes a fresh opened', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: true }], T0));
    await drain();
    const id = (await row()).id;
    await asSystem(() => applyActions([{ type: 'resolve', incidentId: id, resolution: 'recovered' }], T1));
    publish.mockClear();
    expect(await drain()).toEqual({ published: 1, failed: 0 });
    expect(published()[0]).toMatchObject({
      type: 'integration.health_resolved',
      payload: { incidentId: id, resolvedAt: T1.toISOString(), resolution: 'recovered' },
    });
    expect((await row()).eventState).toBe('resolved');

    await asSystem(() => applyActions([{ type: 'reopen', incidentId: id, obs: obs({ observedAt: T2 }), escalated: false }], T2));
    publish.mockClear();
    expect(await drain()).toEqual({ published: 1, failed: 0 });
    const reopened = await row();
    expect(published()[0]).toMatchObject({ type: 'integration.health_opened', options: { eventId: healthEventId(reopened, 'opened') } });
    expect(healthEventId(reopened, 'opened')).not.toBe(healthEventId({ ...reopened, flapCount: 0 }, 'opened'));
    expect(reopened.eventState).toBe('opened');
  });

  it('a seeded incident is a silent baseline: no opened event, but its resolve is published', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: false }], T0));
    expect((await row()).eventState).toBe('opened');
    expect(await drain()).toEqual({ published: 0, failed: 0 });
    const seededId = (await row()).id;
    await asSystem(() => applyActions([{ type: 'resolve', incidentId: seededId, resolution: 'retired' }], T1));
    expect(await drain()).toEqual({ published: 1, failed: 0 });
    expect(published()[0]).toMatchObject({ type: 'integration.health_resolved', payload: { resolution: 'retired' } });
  });

  it('a pending promotion without notify (seed) is also a silent baseline', async () => {
    await asSystem(() => applyActions([{ type: 'insertPending', obs: obs({ severity: 'transient' }) }], T0));
    expect(await drain()).toEqual({ published: 0, failed: 0 }); // pending: never emits
    const id = (await row()).id;
    await asSystem(() => applyActions([{ type: 'promotePending', incidentId: id, obs: obs({ severity: 'transient' }), notify: false }], T1));
    expect((await row()).eventState).toBe('opened');
    expect(await drain()).toEqual({ published: 0, failed: 0 });
  });

  it('partner-wide incidents never emit', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs({ orgId: null, sourceKind: 'huntress', sourceId: 'hx' }), notify: true }], T0));
    expect(await drain()).toEqual({ published: 0, failed: 0 });
    expect((await row('hx')).eventState).toBeNull();
  });

  it('opened and resolved between two drains is coalesced: consumers hear nothing', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: true }], T0));
    const id = (await row()).id;
    await asSystem(() => applyActions([{ type: 'resolve', incidentId: id, resolution: 'recovered' }], T1));
    expect(await drain()).toEqual({ published: 0, failed: 0 });
  });

  it('a failed publish leaves the row due and the next drain publishes it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: true }], T0));
    publish.mockRejectedValueOnce(new Error('redis down'));
    expect(await drain()).toEqual({ published: 0, failed: 1 });
    expect((await row()).eventState).toBeNull();
    expect(await drain()).toEqual({ published: 1, failed: 0 });
    expect((await row()).eventState).toBe('opened');
    err.mockRestore();
  });

  it('nulls the source id of an OAuth grant incident (it embeds the owner user id)', async () => {
    await asSystem(() => applyActions([{
      type: 'insertOpen',
      obs: obs({ sourceKind: 'oauth_grant', sourceId: 'owner-user:client-1', condition: 'grant_revoked_reuse' }),
      notify: true,
    }], T0));
    await drain();
    expect(published()[0]!.payload).toMatchObject({ sourceKind: 'oauth_grant', sourceId: null });
    expect(JSON.stringify(published())).not.toContain('owner-user');
  });

  it('resolve then reopen inside the window before a drain is a no-op for consumers (already told opened)', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: true }], T0));
    await drain();
    const id = (await row()).id;
    await asSystem(() => applyActions([{ type: 'resolve', incidentId: id, resolution: 'recovered' }], T1));
    await asSystem(() => applyActions([{ type: 'reopen', incidentId: id, obs: obs({ observedAt: T2 }), escalated: false }], T2));
    publish.mockClear();
    expect(await drain()).toEqual({ published: 0, failed: 0 });
    expect((await row()).eventState).toBe('opened');
  });

  it('a reopen\'s opened event is stamped now, not with the stale opened_at', async () => {
    await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs(), notify: true }], T0));
    await drain();
    expect(published()[0]!.options).toMatchObject({ occurredAt: T0.toISOString() });
    const id = (await row()).id;
    await asSystem(() => applyActions([{ type: 'resolve', incidentId: id, resolution: 'recovered' }], T1));
    await drain();
    await asSystem(() => applyActions([{ type: 'reopen', incidentId: id, obs: obs({ observedAt: T2 }), escalated: false }], T2));
    publish.mockClear();
    await drain();
    expect(published()[0]!.options.occurredAt).toBeUndefined();
  });
});

describe('event outbox migration baseline (2026-12-30-120000)', () => {
  const migrationSql = readFileSync(
    new URL('../../../migrations/2026-12-30-130000-connection-health-event-outbox.sql', import.meta.url),
    'utf8',
  );
  const replay = () => getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
    await tx.execute(sql.raw(migrationSql));
  });
  const dropColumn = () => getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
    await tx.execute(sql.raw('ALTER TABLE public.connection_health_incidents DROP COLUMN IF EXISTS event_state CASCADE'));
  });

  beforeEach(async () => {
    publish.mockReset();
    publish.mockResolvedValue('ok');
    P = (await createPartner()).id;
    ORG = (await createOrganization({ partnerId: P })).id;
    await asSystem(() => db.delete(connectionHealthIncidents));
  });

  it('baselines existing rows once when the column is added, and a re-run never acknowledges a newly due row', async () => {
    await asSystem(() => applyActions([
      { type: 'insertOpen', obs: obs({ sourceId: 'open' }), notify: true },
      { type: 'insertOpen', obs: obs({ sourceId: 'resolved' }), notify: true },
      { type: 'insertOpen', obs: obs({ sourceId: 'partner-wide', orgId: null, sourceKind: 'huntress' }), notify: true },
      { type: 'insertPending', obs: obs({ sourceId: 'pending', severity: 'transient' }) },
    ], T0));
    const resolvedId = (await row('resolved')).id;
    await asSystem(() => applyActions([{ type: 'resolve', incidentId: resolvedId, resolution: 'recovered' }], T1));

    try {
      await dropColumn();
      await replay();
      expect((await row('open')).eventState).toBe('opened');
      expect((await row('resolved')).eventState).toBe('resolved');
      expect((await row('partner-wide')).eventState).toBeNull();
      expect((await row('pending')).eventState).toBeNull();
      expect(await drain()).toEqual({ published: 0, failed: 0 }); // no deploy burst

      await asSystem(() => applyActions([{ type: 'insertOpen', obs: obs({ sourceId: 'after-deploy' }), notify: true }], T2));
      await replay();
      expect((await row('after-deploy')).eventState).toBeNull();
      expect(await drain()).toEqual({ published: 1, failed: 0 });
    } finally {
      // Leave the schema as setup.ts migrated it, even on failure.
      await replay();
    }
  });
});
