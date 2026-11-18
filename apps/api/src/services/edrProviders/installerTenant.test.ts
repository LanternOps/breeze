import { beforeEach, describe, expect, it, vi } from 'vitest';

// Selection rules on mocked rows. The same rules against real Postgres (and the
// composite FK that makes a cross-partner row impossible) are in
// src/__tests__/integration/edrInstallerTenant.integration.test.ts.
const { state } = vi.hoisted(() => ({
  state: { rows: [] as Array<Record<string, unknown>>, queries: 0, contextOpened: 0, outsideOpened: 0 },
}));

vi.mock('../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'innerJoin', 'leftJoin']) c[m] = () => c;
    c.where = async () => { state.queries += 1; return state.rows; };
    return c;
  };
  return {
    db: { select: () => chain() },
    withSystemDbAccessContext: (fn: () => unknown) => { state.contextOpened += 1; return fn(); },
    runOutsideDbContext: (fn: () => unknown) => { state.outsideOpened += 1; return fn(); },
  };
});

import { loadInstallerTenantSelections, selectInstallerTenant } from './installerTenant';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PARTNER = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-11-05T12:00:00.000Z');
const row = (over: Record<string, unknown> = {}) => ({
  orgId: ORG,
  tenantId: 'tenant-1',
  connectionId: 'conn-1',
  tenantPartnerId: PARTNER,
  orgPartnerId: PARTNER,
  connectionActive: true,
  connectionStatus: 'connected',
  sealedMaterial: 'sealed',
  installerHasMaterial: true,
  installerFetchedAt: new Date(NOW.getTime() - 60 * 60_000),
  installerExpiresAt: null,
  ...over,
});
const select = () => selectInstallerTenant('bitdefender', ORG, NOW);

beforeEach(() => {
  state.rows = [];
  state.queries = 0;
  state.contextOpened = 0;
  state.outsideOpened = 0;
});

describe('selectInstallerTenant', () => {
  it('one tenant with material: ok, carrying the sealed blob', async () => {
    state.rows = [row()];
    await expect(select()).resolves.toEqual({
      kind: 'ok', tenantId: 'tenant-1', connectionId: 'conn-1', sealedMaterial: 'sealed', expiresAt: null,
    });
  });

  it('no tenant: not_mapped', async () => {
    await expect(select()).resolves.toEqual({ kind: 'not_mapped' });
  });

  it('two tenants: ambiguous, and it never picks one', async () => {
    state.rows = [row(), row({ tenantId: 'tenant-2', connectionId: 'conn-2' })];
    await expect(select()).resolves.toEqual({ kind: 'ambiguous', count: 2 });
  });

  it('ambiguity outranks a disabled connection: disabling one does not silently choose the other', async () => {
    state.rows = [row({ connectionActive: false }), row({ tenantId: 'tenant-2', connectionId: 'conn-2' })];
    await expect(select()).resolves.toEqual({ kind: 'ambiguous', count: 2 });
  });

  it.each([
    ['a deactivated connection', { connectionActive: false }],
    ['a connection that needs re-authentication', { connectionStatus: 'reauth_required' }],
  ])('%s: inactive', async (_label, over) => {
    state.rows = [row(over)];
    await expect(select()).resolves.toEqual({ kind: 'inactive' });
  });

  it.each([null, ''])('no sealed material (%j): material_missing', async (sealedMaterial) => {
    state.rows = [row({ sealedMaterial })];
    await expect(select()).resolves.toEqual({ kind: 'material_missing' });
  });

  it('material expiring within the hour: material_expired', async () => {
    state.rows = [row({ installerExpiresAt: new Date(NOW.getTime() + 30 * 60_000) })];
    await expect(select()).resolves.toEqual({ kind: 'material_expired' });
  });

  it('material whose refresh has failed for over a week: material_expired, never dispatched forever', async () => {
    state.rows = [row({ installerFetchedAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60_000) })];
    await expect(select()).resolves.toEqual({ kind: 'material_expired' });
  });

  it('material with no fetch time: material_expired (fail closed)', async () => {
    state.rows = [row({ installerFetchedAt: null })];
    await expect(select()).resolves.toEqual({ kind: 'material_expired' });
  });

  it('material six days old: ok', async () => {
    state.rows = [row({ installerFetchedAt: new Date(NOW.getTime() - 6 * 24 * 60 * 60_000) })];
    await expect(select()).resolves.toMatchObject({ kind: 'ok' });
  });

  it('material expiring later: ok', async () => {
    const expiresAt = new Date(NOW.getTime() + 2 * 60 * 60_000);
    state.rows = [row({ installerExpiresAt: expiresAt })];
    await expect(select()).resolves.toMatchObject({ kind: 'ok', expiresAt });
  });

  it('a tenant of another partner never counts (the org moved): not_mapped, no install into the other MSP', async () => {
    state.rows = [row({ orgPartnerId: '00000000-0000-4000-8000-0000000000b2' })];
    await expect(select()).resolves.toEqual({ kind: 'not_mapped' });
  });

  it('opens its own system context outside any ambient one, like the legacy resolvers', async () => {
    state.rows = [row()];
    await select();
    expect(state.outsideOpened).toBe(1);
    expect(state.contextOpened).toBe(1);
  });
});

describe('loadInstallerTenantSelections', () => {
  it('answers every requested org with one query', async () => {
    const other = '00000000-0000-4000-8000-0000000000a2';
    const unmapped = '00000000-0000-4000-8000-0000000000a3';
    state.rows = [row(), row({ orgId: other, tenantId: 't-2' }), row({ orgId: other, tenantId: 't-3' })];
    const selections = await loadInstallerTenantSelections('bitdefender', [ORG, other, unmapped], NOW);
    expect(state.queries).toBe(1);
    expect(selections.get(ORG)).toMatchObject({ kind: 'ok', tenantId: 'tenant-1' });
    expect(selections.get(other)).toEqual({ kind: 'ambiguous', count: 2 });
    expect(selections.get(unmapped)).toEqual({ kind: 'not_mapped' });
    expect(selections.size).toBe(3);
  });

  it('never hands the sealed material to its callers (readiness)', async () => {
    state.rows = [row()];
    const selections = await loadInstallerTenantSelections('bitdefender', [ORG], NOW);
    expect(selections.get(ORG)).toEqual({ kind: 'ok', tenantId: 'tenant-1', connectionId: 'conn-1', expiresAt: null });
    expect(JSON.stringify([...selections.values()])).not.toContain('sealed');
  });

  it('reports material_missing from the boolean alone', async () => {
    state.rows = [row({ installerHasMaterial: false, sealedMaterial: undefined })];
    const selections = await loadInstallerTenantSelections('bitdefender', [ORG], NOW);
    expect(selections.get(ORG)).toEqual({ kind: 'material_missing' });
  });

  it('no orgs: no query', async () => {
    const selections = await loadInstallerTenantSelections('bitdefender', [], NOW);
    expect(selections.size).toBe(0);
    expect(state.queries).toBe(0);
  });
});
