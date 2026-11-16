/**
 * Connection health staleness on three partner-axis sources (#9127, plan
 * 2026-10-18 PR A): edr, accounting and ticket_mailbox, against real Postgres.
 * The org-axis kinds are in connectionHealthStaleOrgSources.integration.test.ts.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { accountingConnections, edrConnections, ticketMailboxConnections, ticketMailboxTenantOwnerships } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { edrSource } from '../../services/connectionHealth/sources/edr';
import { accountingSource } from '../../services/connectionHealth/sources/accounting';
import { ticketMailboxSource } from '../../services/connectionHealth/sources/ticketMailbox';
import type { HealthSource } from '../../services/connectionHealth/types';

const NOW = new Date();
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const observe = (source: HealthSource, tracked: string[] = []) => asSystem(() => source.observe(NOW, tracked));
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursAgo = (h: number) => minAgo(h * 60);
const partner = async () => (await createPartner()).id;

describe('edr stale arm', () => {
  async function edr(over: Partial<typeof edrConnections.$inferInsert> = {}) {
    const id = randomUUID();
    await asSystem(async () => db.insert(edrConnections).values({
      id, partnerId: await partner(), provider: 'gravityzone', name: 'GZ', credentialsEncrypted: 'x',
      lastInventorySyncStatus: 'success', lastInventorySyncAt: minAgo(5),
      lastDetectionSyncStatus: 'success', lastDetectionSyncAt: minAgo(5),
      effectiveInventoryIntervalMinutes: 60, effectiveDetectionIntervalMinutes: 10,
      createdAt: hoursAgo(24 * 30), ...over,
    }));
    return id;
  }

  it('detections stale past three of their own interval (floor 60 min), inventory fresh', async () => {
    const stale = await edr({ lastDetectionSyncAt: minAgo(70) });
    const fresh = await edr({ lastDetectionSyncAt: minAgo(50) });
    const obs = await observe(edrSource);
    expect(obs.find((x) => x.sourceId === stale)).toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale', detail: null, orgId: null });
    expect(obs.find((x) => x.sourceId === fresh)).toBeUndefined();
  });

  it('inventory alone stale past three hourly intervals, detections fresh', async () => {
    const stale = await edr({ lastInventorySyncAt: minAgo(185) });
    const fresh = await edr({ lastInventorySyncAt: minAgo(175) });
    const obs = await observe(edrSource);
    expect(obs.find((x) => x.sourceId === stale)).toMatchObject({ condition: 'sync_stale' });
    expect(obs.find((x) => x.sourceId === fresh)).toBeUndefined();
  });

  it('a daily inventory interval is stale only past three days', async () => {
    const twoDays = await edr({ effectiveInventoryIntervalMinutes: 1440, lastInventorySyncAt: hoursAgo(48) });
    const fourDays = await edr({ effectiveInventoryIntervalMinutes: 1440, lastInventorySyncAt: hoursAgo(96) });
    const obs = await observe(edrSource);
    expect(obs.find((x) => x.sourceId === twoDays)).toBeUndefined();
    expect(obs.find((x) => x.sourceId === fourDays)).toMatchObject({ condition: 'sync_stale' });
  });

  it('never synced: stale from created_at past three of the 60-minute fallback interval; a younger row is absent', async () => {
    const never = { lastInventorySyncStatus: null, lastInventorySyncAt: null, lastDetectionSyncStatus: null, lastDetectionSyncAt: null, effectiveInventoryIntervalMinutes: null, effectiveDetectionIntervalMinutes: null };
    const old = await edr({ ...never, createdAt: minAgo(185) });
    const young = await edr({ ...never, createdAt: minAgo(175) });
    const obs = await observe(edrSource);
    expect(obs.find((x) => x.sourceId === old)).toMatchObject({ condition: 'sync_stale' });
    expect(obs.find((x) => x.sourceId === young)).toBeUndefined();
  });

  it('detections hung in running past the threshold are stale, not unknown', async () => {
    const id = await edr({ lastDetectionSyncStatus: 'running', lastDetectionSyncAt: hoursAgo(5) });
    expect((await observe(edrSource)).find((x) => x.sourceId === id)).toMatchObject({ condition: 'sync_stale' });
  });

  it('reauth stays permanent, a stream error stays sync_failed with its text, inactive is not read', async () => {
    const reauth = await edr({ status: 'reauth_required', lastDetectionSyncAt: hoursAgo(24) });
    const failed = await edr({ lastInventorySyncStatus: 'error', lastInventorySyncError: 'inventory: 503', lastInventorySyncAt: hoursAgo(24) });
    const inactive = await edr({ isActive: false, lastDetectionSyncAt: hoursAgo(24) });
    const obs = await observe(edrSource);
    expect(obs.find((x) => x.sourceId === reauth)).toMatchObject({ severity: 'permanent', condition: 'reauth_required' });
    expect(obs.find((x) => x.sourceId === failed)).toMatchObject({ condition: 'sync_failed', detail: 'inventory: 503' });
    expect(obs.find((x) => x.sourceId === inactive)).toBeUndefined();
  });

  it('tracked: a fresh connection recovers', async () => {
    const id = await edr();
    expect((await observe(edrSource, [id])).find((x) => x.sourceId === id)).toMatchObject({ state: 'healthy' });
  });
});

describe('accounting stale arm', () => {
  async function acct(over: Partial<typeof accountingConnections.$inferInsert> = {}) {
    const id = randomUUID();
    await asSystem(async () => db.insert(accountingConnections).values({
      id, partnerId: await partner(), provider: 'quickbooks', status: 'connected',
      lastReconcileAt: minAgo(5), createdAt: hoursAgo(24 * 30), ...over,
    }));
    return id;
  }

  it('QuickBooks is stale past 60 min since the last reconcile run; 40 min is not read', async () => {
    const stale = await acct({ lastReconcileAt: minAgo(70) });
    const fresh = await acct({ lastReconcileAt: minAgo(40) });
    const obs = await observe(accountingSource);
    expect(obs.find((x) => x.sourceId === stale)).toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale', detail: null, displayName: 'QuickBooks' });
    expect(obs.find((x) => x.sourceId === fresh)).toBeUndefined();
  });

  it('Xero (daily call budget) is not stale at 26 h and is stale at 73 h', async () => {
    const deferred = await acct({ provider: 'xero', lastReconcileAt: hoursAgo(26) });
    const behind = await acct({ provider: 'xero', lastReconcileAt: hoursAgo(73) });
    const obs = await observe(accountingSource);
    expect(obs.find((x) => x.sourceId === deferred)).toBeUndefined();
    expect(obs.find((x) => x.sourceId === behind)).toMatchObject({ condition: 'sync_stale', fixHref: '/integrations#xero' });
  });

  it('both payment switches off: never stale, however old', async () => {
    const id = await acct({ pullPayments: false, pushPayments: false, lastReconcileAt: hoursAgo(24 * 30) });
    expect((await observe(accountingSource)).find((x) => x.sourceId === id)).toBeUndefined();
  });

  it('push only still reconciles, so it can go stale', async () => {
    const id = await acct({ pullPayments: false, pushPayments: true, lastReconcileAt: hoursAgo(5) });
    expect((await observe(accountingSource)).find((x) => x.sourceId === id)).toMatchObject({ condition: 'sync_stale' });
  });

  it('a connect in progress is not read; never reconciled counts from created_at', async () => {
    const pending = await acct({ status: 'pending_tenant', lastReconcileAt: null, createdAt: hoursAgo(24 * 3) });
    const never = await acct({ lastReconcileAt: null, createdAt: hoursAgo(3) });
    const obs = await observe(accountingSource);
    expect(obs.find((x) => x.sourceId === pending)).toBeUndefined();
    expect(obs.find((x) => x.sourceId === never)).toMatchObject({ condition: 'sync_stale' });
  });

  it('a stale connection reports its reconcile-run error; reauth stays permanent', async () => {
    const dirty = await acct({ lastReconcileAt: hoursAgo(3), lastError: 'Payment pull: 2 of 9 items failed' });
    const reauth = await acct({ status: 'reauth_required', lastReconcileAt: hoursAgo(24), lastError: 'QuickBooks refresh token expired' });
    const obs = await observe(accountingSource);
    expect(obs.find((x) => x.sourceId === dirty)).toMatchObject({ condition: 'sync_stale', detail: 'Payment pull: 2 of 9 items failed' });
    expect(obs.find((x) => x.sourceId === reauth)).toMatchObject({ severity: 'permanent', condition: 'reauth_required' });
  });
});

describe('ticket_mailbox stale arm', () => {
  async function gmail(over: Partial<typeof ticketMailboxConnections.$inferInsert> = {}) {
    const id = randomUUID();
    const p = await partner();
    const o = (await createOrganization({ partnerId: p })).id;
    await asSystem(() => db.insert(ticketMailboxConnections).values({
      id, partnerId: p, provider: 'gmail', orgId: o, googleAccountSub: `sub-${id}`,
      mailboxAddress: `g-${id}@example.test`, status: 'connected', lastPolledAt: minAgo(1),
      createdAt: hoursAgo(24 * 30), ...over,
    }));
    return id;
  }
  async function m365(over: Partial<typeof ticketMailboxConnections.$inferInsert> = {}) {
    const id = randomUUID();
    const p = await partner();
    const tenantId = over.tenantId === undefined ? randomUUID() : over.tenantId;
    await asSystem(async () => {
      if (tenantId !== null) {
        await db.insert(ticketMailboxTenantOwnerships).values({ tenantId, partnerId: p, verifiedMicrosoftOid: randomUUID() });
      }
      await db.insert(ticketMailboxConnections).values({
        id, partnerId: p, provider: 'm365',
        mailboxAddress: `m-${id}@example.test`, status: 'connected', lastPolledAt: minAgo(1),
        createdAt: hoursAgo(24 * 30), ...over, tenantId,
      });
    });
    return id;
  }

  it('a connected mailbox not polled for 70 min is stale with no detail; one polled 5 min ago is not read', async () => {
    const stale = await gmail({ lastPolledAt: minAgo(70), lastError: 'raw upstream text' });
    const fresh = await m365({ lastPolledAt: minAgo(5) });
    const obs = await observe(ticketMailboxSource);
    expect(obs.find((x) => x.sourceId === stale)).toMatchObject({ state: 'broken', severity: 'transient', condition: 'sync_stale', detail: null });
    expect(obs.find((x) => x.sourceId === fresh)).toBeUndefined();
  });

  it('connected but never polled (a poll that never persists a cursor) goes stale from created_at', async () => {
    const id = await m365({ lastPolledAt: null, createdAt: hoursAgo(3) });
    expect((await observe(ticketMailboxSource)).find((x) => x.sourceId === id)).toMatchObject({ condition: 'sync_stale' });
  });

  it('pending consent and disabled are not read; a failing poll streak stays poll_failing', async () => {
    const pending = await m365({ status: 'pending_consent', tenantId: null, lastPolledAt: null, createdAt: hoursAgo(24 * 3) });
    const disabled = await m365({ status: 'disabled', lastPolledAt: hoursAgo(24 * 3) });
    const streak = await gmail({ lastPolledAt: hoursAgo(3), consecutiveTransientFailures: 5 });
    const freshStreak = await gmail({ lastPolledAt: minAgo(2), consecutiveTransientFailures: 5 });
    const obs = await observe(ticketMailboxSource);
    expect(obs.find((x) => x.sourceId === pending)).toBeUndefined();
    expect(obs.find((x) => x.sourceId === disabled)).toBeUndefined();
    expect(obs.find((x) => x.sourceId === streak)).toMatchObject({ condition: 'poll_failing' });
    expect(obs.find((x) => x.sourceId === freshStreak)).toMatchObject({ condition: 'poll_failing' });
  });

  it('tracked: a fresh poll recovers', async () => {
    const id = await gmail();
    expect((await observe(ticketMailboxSource, [id])).find((x) => x.sourceId === id)).toMatchObject({ state: 'healthy' });
  });
});
