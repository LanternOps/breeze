/**
 * Connection health W2 sources against real Postgres (spec 2026-10-15 §3, §10):
 * each source reads its broken set and tracked ids correctly, with the right
 * partner/org attribution. Mapping edge cases are unit-tested in
 * services/connectionHealth/sources/sources.test.ts.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  accountingConnections,
  backupProviderConnections,
  dnsFilterIntegrations,
  edrConnections,
  huntressIntegrations,
  m365Connections,
  m365SyncState,
  pax8Integrations,
  s1Integrations,
  ticketMailboxConnections,
  unifiIntegrations,
} from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestRedis } from './setup';
import { huntressSource } from '../../services/connectionHealth/sources/huntress';
import { sentinelOneSource } from '../../services/connectionHealth/sources/sentinelOne';
import { pax8Source } from '../../services/connectionHealth/sources/pax8';
import { unifiSource } from '../../services/connectionHealth/sources/unifi';
import { backupProviderSource } from '../../services/connectionHealth/sources/backupProvider';
import { edrSource } from '../../services/connectionHealth/sources/edr';
import { accountingSource } from '../../services/connectionHealth/sources/accounting';
import { dnsFilterSource } from '../../services/connectionHealth/sources/dnsFilter';
import { m365ConnectionSource } from '../../services/connectionHealth/sources/m365Connection';
import { m365SyncSource } from '../../services/connectionHealth/sources/m365Sync';
import { ticketMailboxSource } from '../../services/connectionHealth/sources/ticketMailbox';
import { runReconcile } from '../../services/connectionHealth/reconcile';
import { CONNECTION_SOURCE_KINDS, type HealthSource } from '../../services/connectionHealth/types';

const NOW = new Date();
const OLD = new Date(NOW.getTime() - 30 * 86_400_000);
const asSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));
const observe = (source: HealthSource, tracked: string[] = []) => asSystem(() => source.observe(NOW, tracked));
const ids = (obs: Array<{ sourceId: string }>) => obs.map((o) => o.sourceId).sort();
const partner = async () => (await createPartner()).id;

describe('partner sync sources (Huntress, SentinelOne, Pax8)', () => {
  it('huntress: broken found, healthy untracked skipped, tracked healthy and tracked deleted handled', async () => {
    const [p1, p2] = [await partner(), await partner()];
    const broken = randomUUID();
    const healthy = randomUUID();
    await asSystem(() => db.insert(huntressIntegrations).values([
      { id: broken, partnerId: p1, name: 'H', apiKeyEncrypted: 'x', lastSyncStatus: 'error', lastSyncError: 'boom', createdAt: OLD },
      { id: healthy, partnerId: p2, name: 'H', apiKeyEncrypted: 'x', lastSyncStatus: 'success', createdAt: OLD },
    ]));
    const untracked = await observe(huntressSource);
    expect(untracked.filter((o) => o.sourceId === broken)).toEqual([
      expect.objectContaining({ state: 'broken', partnerId: p1, orgId: null, detail: 'boom' }),
    ]);
    expect(ids(untracked)).not.toContain(healthy);
    const gone = randomUUID();
    const tracked = await observe(huntressSource, [healthy, gone]);
    expect(tracked.find((o) => o.sourceId === healthy)).toMatchObject({ state: 'healthy' });
    expect(ids(tracked)).not.toContain(gone);
  });

  it('sentinelone and pax8 read their own failure values', async () => {
    const s1 = randomUUID();
    const px = randomUUID();
    const pxWrongVocab = randomUUID();
    await asSystem(async () => {
      await db.insert(s1Integrations).values({ id: s1, partnerId: await partner(), name: 'S', apiTokenEncrypted: 'x', managementUrl: 'https://s1.example.test', lastSyncStatus: 'error', createdAt: OLD });
      await db.insert(pax8Integrations).values([
        { id: px, partnerId: await partner(), name: 'P', clientIdEncrypted: 'x', clientSecretEncrypted: 'x', tokenUrl: 'https://px.example.test', lastSyncStatus: 'failed', createdAt: OLD },
        { id: pxWrongVocab, partnerId: await partner(), name: 'P', clientIdEncrypted: 'x', clientSecretEncrypted: 'x', tokenUrl: 'https://px.example.test', lastSyncStatus: 'error', createdAt: OLD },
      ]);
    });
    expect(ids(await observe(sentinelOneSource))).toContain(s1);
    const pax = ids(await observe(pax8Source));
    expect(pax).toContain(px);
    expect(pax).not.toContain(pxWrongVocab);
  });

  it('an inactive integration is not in the broken set, and retires when tracked', async () => {
    const id = randomUUID();
    await asSystem(async () => db.insert(huntressIntegrations).values({ id, partnerId: await partner(), name: 'H', apiKeyEncrypted: 'x', isActive: false, lastSyncStatus: 'error', createdAt: OLD }));
    expect(ids(await observe(huntressSource))).not.toContain(id);
    expect((await observe(huntressSource, [id])).find((o) => o.sourceId === id)).toMatchObject({ state: 'retired' });
  });
});

describe('vendor sources', () => {
  it('unifi reauth, backup sync error and edr stream error are observed', async () => {
    const [u, b, e] = [randomUUID(), randomUUID(), randomUUID()];
    await asSystem(async () => {
      await db.insert(unifiIntegrations).values({ id: u, partnerId: await partner(), apiKeyEncrypted: 'x', status: 'reauth_required', createdAt: OLD });
      await db.insert(backupProviderConnections).values({ id: b, partnerId: await partner(), provider: 'cove', name: 'Main', credentialsEncrypted: 'x', lastSyncStatus: 'error', lastSyncError: 'fetch failed', createdAt: OLD });
      await db.insert(edrConnections).values({ id: e, partnerId: await partner(), provider: 'gravityzone', name: 'GZ', credentialsEncrypted: 'x', lastDetectionSyncStatus: 'error', lastDetectionSyncError: '503', createdAt: OLD });
    });
    expect((await observe(unifiSource)).find((o) => o.sourceId === u)).toMatchObject({ state: 'broken', severity: 'permanent' });
    expect((await observe(backupProviderSource)).find((o) => o.sourceId === b)).toMatchObject({ state: 'broken', displayName: 'Main' });
    expect((await observe(edrSource)).find((o) => o.sourceId === e)).toMatchObject({ state: 'broken', detail: '503' });
  });

  it('backup: a retry in progress (running, error cleared) reports unknown for a tracked incident', async () => {
    const b = randomUUID();
    await asSystem(async () => db.insert(backupProviderConnections).values({ id: b, partnerId: await partner(), provider: 'cove', name: 'Main', credentialsEncrypted: 'x', lastSyncStatus: 'running', createdAt: OLD }));
    expect(ids(await observe(backupProviderSource))).not.toContain(b);
    expect((await observe(backupProviderSource, [b])).find((o) => o.sourceId === b)).toMatchObject({ state: 'unknown' });
  });
});

describe('accounting and mailbox', () => {
  it('accounting reauth is observed with the provider link', async () => {
    const id = randomUUID();
    await asSystem(async () => db.insert(accountingConnections).values({ id, partnerId: await partner(), provider: 'xero', status: 'reauth_required', lastError: 'Xero refresh token expired', createdAt: OLD }));
    expect((await observe(accountingSource)).find((o) => o.sourceId === id)).toMatchObject({ state: 'broken', fixHref: '/integrations#xero' });
  });

  it('mailbox: reauth and a failing poll streak are observed; a disabled tracked mailbox retires', async () => {
    const [reauth, streak, disabled] = [randomUUID(), randomUUID(), randomUUID()];
    const p = await partner();
    await asSystem(() => db.insert(ticketMailboxConnections).values([
      { id: reauth, partnerId: p, mailboxAddress: `a-${reauth}@example.test`, status: 'reauth_required', lastError: 'raw upstream text', createdAt: OLD },
      { id: streak, partnerId: p, provider: 'gmail', orgId: null, mailboxAddress: `b-${streak}@example.test`, status: 'error', consecutiveTransientFailures: 6, createdAt: OLD },
      { id: disabled, partnerId: p, mailboxAddress: `c-${disabled}@example.test`, status: 'disabled', createdAt: OLD },
    ]));
    const obs = await observe(ticketMailboxSource, [disabled]);
    expect(obs.find((o) => o.sourceId === reauth)).toMatchObject({ state: 'broken', severity: 'permanent', detail: null });
    expect(obs.find((o) => o.sourceId === streak)).toMatchObject({ state: 'broken' });
    expect(obs.find((o) => o.sourceId === disabled)).toMatchObject({ state: 'retired' });
  });
});

describe('org sources', () => {
  async function orgOf() {
    const p = await partner();
    const o = (await createOrganization({ partnerId: p })).id;
    return { p, o };
  }

  async function m365Connection(orgId: string, status: string, lastErrorCode: string | null = null) {
    const [row] = await asSystem(() => db.insert(m365Connections).values({
      orgId, userId: null, tenantId: randomUUID(), consentAttemptId: randomUUID(), clientId: randomUUID(),
      clientSecret: null, profile: 'customer-graph-read', authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/m365-customer-graph-read-${randomUUID()}/0123456789abcdef0123456789abcdef`,
      credentialVersion: '0123456789abcdef0123456789abcdef', permissionManifestVersion: 3,
      status: status as 'active', lastErrorCode, createdAt: OLD,
    }).returning({ id: m365Connections.id }));
    return row!.id;
  }

  it('dns: an org incident attributed to the org and its partner', async () => {
    const { p, o } = await orgOf();
    const id = randomUUID();
    await asSystem(() => db.insert(dnsFilterIntegrations).values({ id, orgId: o, provider: 'cloudflare', name: 'DNS', lastSyncStatus: 'error', lastSyncError: 'provider 500', createdAt: OLD }));
    expect((await observe(dnsFilterSource)).find((x) => x.sourceId === id)).toMatchObject({ state: 'broken', orgId: o, partnerId: p });
  });

  it('m365 connection: degraded is broken; revoked retires when tracked', async () => {
    const { p, o } = await orgOf();
    const degraded = await m365Connection(o, 'degraded', 'grant_missing');
    const other = await orgOf();
    const revoked = await m365Connection(other.o, 'revoked');
    const obs = await observe(m365ConnectionSource, [revoked]);
    expect(obs.find((x) => x.sourceId === degraded)).toMatchObject({ state: 'broken', severity: 'permanent', orgId: o, partnerId: p });
    expect(obs.find((x) => x.sourceId === revoked)).toMatchObject({ state: 'retired' });
  });

  it('m365 sync: one observation per connection; unknown under a degraded parent', async () => {
    const a = await orgOf();
    const healthyParent = await m365Connection(a.o, 'active');
    const b = await orgOf();
    const degradedParent = await m365Connection(b.o, 'degraded');
    await asSystem(() => db.insert(m365SyncState).values([
      { orgId: a.o, connectionId: healthyParent, domain: 'users', intervalSeconds: 21600, lastStatus: 'error', lastError: 'graph_call_failed: 503' },
      { orgId: a.o, connectionId: healthyParent, domain: 'skus', intervalSeconds: 86400, lastStatus: 'needs_consent' },
      { orgId: a.o, connectionId: healthyParent, domain: 'intune_devices', intervalSeconds: 21600, lastStatus: 'success' },
      { orgId: b.o, connectionId: degradedParent, domain: 'users', intervalSeconds: 21600, lastStatus: 'error' },
    ]));
    const untracked = await observe(m365SyncSource);
    expect(untracked.filter((x) => x.sourceId === healthyParent)).toEqual([
      expect.objectContaining({ state: 'broken', severity: 'permanent', condition: 'needs_consent', orgId: a.o, partnerId: a.p }),
    ]);
    expect(ids(untracked)).not.toContain(degradedParent);
    expect((await observe(m365SyncSource, [degradedParent])).find((x) => x.sourceId === degradedParent)).toMatchObject({ state: 'unknown' });
  });
});

describe('broken query covers every broken verdict branch', () => {
  // A verdict branch the broken query misses never opens an incident.
  it('unifi, backup, edr, accounting, m365 suspended and the mailbox streak boundary', async () => {
    const id = () => randomUUID();
    const [uConnFailed, uStatusErr, bReauth, bStatusErr, eInv, eStatusErr, aDisc, aErr] = Array.from({ length: 8 }, id);
    const p = await partner();
    const org = (await createOrganization({ partnerId: p })).id;
    const [box4, box5] = [id(), id()];
    await asSystem(async () => {
      await db.insert(unifiIntegrations).values([
        { id: uConnFailed, partnerId: await partner(), apiKeyEncrypted: 'x', status: 'connected', lastSyncStatus: 'failed', createdAt: OLD },
        { id: uStatusErr, partnerId: await partner(), apiKeyEncrypted: 'x', status: 'error', lastSyncStatus: 'success', createdAt: OLD },
      ]);
      await db.insert(backupProviderConnections).values([
        { id: bReauth, partnerId: p, provider: 'cove', name: 'R', credentialsEncrypted: 'x', status: 'reauth_required', lastSyncStatus: 'success', createdAt: OLD },
        { id: bStatusErr, partnerId: p, provider: 'cove', name: 'E', credentialsEncrypted: 'x', status: 'error', lastSyncStatus: 'success', createdAt: OLD },
      ]);
      await db.insert(edrConnections).values([
        { id: eInv, partnerId: p, provider: 'gravityzone', name: 'I', credentialsEncrypted: 'x', lastInventorySyncStatus: 'error', lastDetectionSyncStatus: 'success', createdAt: OLD },
        { id: eStatusErr, partnerId: p, provider: 'gravityzone', name: 'S', credentialsEncrypted: 'x', status: 'error', createdAt: OLD },
      ]);
      await db.insert(accountingConnections).values([
        { id: aDisc, partnerId: await partner(), provider: 'quickbooks', status: 'disconnected', createdAt: OLD },
        { id: aErr, partnerId: await partner(), provider: 'quickbooks', status: 'error', createdAt: OLD },
      ]);
      await db.insert(ticketMailboxConnections).values([
        { id: box4, partnerId: p, provider: 'gmail', orgId: org, googleAccountSub: `sub-${box4}`, mailboxAddress: `d-${box4}@example.test`, status: 'connected', consecutiveTransientFailures: 4, createdAt: OLD },
        { id: box5, partnerId: p, provider: 'gmail', orgId: org, googleAccountSub: `sub-${box5}`, mailboxAddress: `e-${box5}@example.test`, status: 'connected', consecutiveTransientFailures: 5, createdAt: OLD },
      ]);
    });
    const brokenIds = async (s: HealthSource) => (await observe(s)).filter((o) => o.state === 'broken').map((o) => o.sourceId);
    expect(await brokenIds(unifiSource)).toEqual(expect.arrayContaining([uConnFailed, uStatusErr]));
    expect(await brokenIds(backupProviderSource)).toEqual(expect.arrayContaining([bReauth, bStatusErr]));
    expect(await brokenIds(edrSource)).toEqual(expect.arrayContaining([eInv, eStatusErr]));
    expect(await brokenIds(accountingSource)).toEqual(expect.arrayContaining([aDisc, aErr]));
    const mailbox = await brokenIds(ticketMailboxSource);
    expect(mailbox).toContain(box5);
    expect(mailbox).not.toContain(box4);
  });

  it('m365 suspended is broken', async () => {
    const p = await partner();
    const o = (await createOrganization({ partnerId: p })).id;
    const [row] = await asSystem(() => db.insert(m365Connections).values({
      orgId: o, userId: null, tenantId: randomUUID(), consentAttemptId: randomUUID(), clientId: randomUUID(),
      clientSecret: null, profile: 'customer-graph-read', authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/m365-customer-graph-read-${randomUUID()}/0123456789abcdef0123456789abcdef`,
      credentialVersion: '0123456789abcdef0123456789abcdef', permissionManifestVersion: 3,
      status: 'suspended', createdAt: OLD,
    }).returning({ id: m365Connections.id }));
    expect((await observe(m365ConnectionSource)).find((x) => x.sourceId === row!.id)).toMatchObject({ state: 'broken', severity: 'permanent' });
  });
});

describe('full registry', () => {
  it('every registered kind reconciles against real Postgres (no failed kind)', async () => {
    const r = await runReconcile({ redis: getTestRedis(), now: () => NOW, budgetMs: 120_000 });
    expect(r.kinds.filter((k) => k.status !== 'ok')).toEqual([]);
    expect(r.kinds.map((k) => k.kind).sort()).toEqual([...CONNECTION_SOURCE_KINDS].sort());
  });
});
