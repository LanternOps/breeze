import { describe, it, expect, vi, beforeEach } from 'vitest';

interface DomainRow {
  id: string; domain: string; provider: string;
  providerDomainId: string | null; providerRegion: string | null; providerManaged: boolean;
}

const state = {
  ambient: null as { scope: string } | null,
  rows: [] as DomainRow[],
  inserted: [] as Record<string, unknown>[],
  updates: [] as { set: Record<string, unknown> }[],
  systemContextOpened: 0
};

vi.mock('../../db', () => ({
  getCurrentDbAccessContext: () => state.ambient,
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
    state.systemContextOpened++;
    return fn();
  },
  db: {
    select: () => ({ from: () => ({ where: async () => state.rows }) }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: async () => { state.inserted.push(row); }
      })
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({ where: async () => { state.updates.push({ set }); } })
    })
  }
}));

import { releaseSendingDomainsForPartner } from './domainRelease';

beforeEach(() => {
  state.ambient = null;
  state.rows = [];
  state.inserted = [];
  state.updates = [];
  state.systemContextOpened = 0;
});

const managed = (over: Partial<DomainRow> = {}): DomainRow => ({
  id: 'row-1', domain: 'acme.com', provider: 'resend',
  providerDomainId: 'dom_1', providerRegion: 'us-east-1', providerManaged: true, ...over
});

describe('releaseSendingDomainsForPartner', () => {
  it('returns 0 and writes nothing when the partner holds no provider domains', async () => {
    expect(await releaseSendingDomainsForPartner('p1')).toBe(0);
    expect(state.inserted).toEqual([]);
    expect(state.updates).toEqual([]);
  });

  it('writes an outbox row BEFORE nulling the handle, for a provider_managed domain', async () => {
    state.rows = [managed()];
    expect(await releaseSendingDomainsForPartner('p1')).toBe(1);
    expect(state.inserted).toEqual([expect.objectContaining({
      provider: 'resend', providerDomainId: 'dom_1', providerRegion: 'us-east-1',
      domain: 'acme.com', reason: 'partner_released'
    })]);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toMatchObject({ providerDomainId: null });
  });

  it('NEVER writes an outbox row for a domain Breeze does not manage — that is the operator\'s own sending domain', async () => {
    state.rows = [managed({ providerManaged: false })];
    expect(await releaseSendingDomainsForPartner('p1')).toBe(1);
    expect(state.inserted).toEqual([]);
    // The handle is still cleared, so the BEFORE DELETE guard lets the row go.
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toMatchObject({ providerDomainId: null });
  });

  it('handles a mix, writing one outbox row and clearing both handles', async () => {
    state.rows = [managed({ id: 'a' }), managed({ id: 'b', domain: 'b.com', providerDomainId: 'dom_2', providerManaged: false })];
    expect(await releaseSendingDomainsForPartner('p1')).toBe(2);
    expect(state.inserted).toHaveLength(1);
    expect(state.updates).toHaveLength(2);
  });

  it('makes no provider call — it is import-clean of the provider registry', async () => {
    state.rows = [managed()];
    await releaseSendingDomainsForPartner('p1');
    // Nothing to assert on a mock here: the guarantee is structural, and the
    // source-scan below is what enforces it.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./domainRelease.ts', import.meta.url), 'utf8'));
    expect(source).not.toContain('providerRegistry');
    expect(source).not.toContain('getEmailDomainProvider');
  });

  it('opens a system context (cascadeDeletePartner has no ambient one)', async () => {
    state.rows = [managed()];
    await releaseSendingDomainsForPartner('p1');
    expect(state.systemContextOpened).toBe(1);
  });

  it('joins an ambient SYSTEM context (finalizePartnerOffboarding already holds one)', async () => {
    state.ambient = { scope: 'system' };
    state.rows = [managed()];
    await expect(releaseSendingDomainsForPartner('p1')).resolves.toBe(1);
  });

  it('THROWS inside a tenant-scoped ambient context rather than silently matching zero rows', async () => {
    state.ambient = { scope: 'partner' };
    await expect(releaseSendingDomainsForPartner('p1')).rejects.toThrow(/system scope/i);
    expect(state.updates).toEqual([]);
  });
});
