import { describe, expect, it } from 'vitest';
import {
  BOARD_FILTERS,
  connectorRepairs,
  deriveIntegrationBadges,
  deriveReadinessChips,
  hasUnlinked,
  matchesFilter,
  repairHref,
  visibleColumns,
  visibleFilters,
  type BoardRow,
  type ReadinessCapabilities,
  type ReadinessConnector,
  type ReadinessOrg,
} from './orgReadiness';
import type { Organization } from '@/components/settings/organizationTypes';

const NOW = new Date('2026-09-13T12:00:00.000Z');

const CAPS: ReadinessCapabilities = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true,
  invoices: true, tickets: true, integrations: true, contracts: true, backup: true,
};

function org(overrides: Partial<Organization> = {}): Organization {
  return { id: 'org-1', name: 'Acme', status: 'active', type: 'customer', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

function readiness(overrides: Partial<ReadinessOrg> = {}): ReadinessOrg {
  return {
    orgId: 'org-1',
    type: 'customer',
    status: 'active',
    setup: { sites: 1, devices: 2, lastSeenAt: NOW.toISOString(), policyAssigned: true, backupApplicable: true, backupConfigured: true },
    account: {
      primaryContact: { name: 'Jo', email: 'jo@acme.example', phone: '1', mobile: null },
      billingRoleContact: true, billingAddress: true, pendingInvitations: 0, overdueInvoices: 0, activeContracts: 1,
    },
    integrations: [],
    ...overrides,
  };
}

const CONNECTED: ReadinessConnector[] = [
  { system: 'quickbooks', state: 'connected' },
  { system: 'psa', state: 'connected', provider: 'connectwise' },
  { system: 'pax8', state: 'connected' },
  { system: 'huntress', state: 'connected' },
];

describe('deriveIntegrationBadges', () => {
  it('returns null when the section is withheld or the payload is missing', () => {
    expect(deriveIntegrationBadges(readiness({ integrations: undefined }), CONNECTED, { ...CAPS, integrations: false })).toBeNull();
    expect(deriveIntegrationBadges(readiness({ integrations: undefined }), CONNECTED, CAPS)).toBeNull();
    expect(deriveIntegrationBadges(undefined, CONNECTED, CAPS)).toBeNull();
    expect(deriveIntegrationBadges(readiness(), CONNECTED, null)).toBeNull();
  });

  it('keeps real badges in order and appends a dashed "not linked" for each connected connector the customer org lacks', () => {
    expect(deriveIntegrationBadges(
      readiness({ integrations: [{ system: 'quickbooks', state: 'linked' }, { system: 'm365', state: 'pending', reason: 'consent_pending' }] }),
      CONNECTED,
      CAPS,
    )).toEqual([
      { system: 'quickbooks', state: 'linked', muted: false },
      { system: 'm365', state: 'pending', reason: 'consent_pending', muted: false },
      { system: 'psa', state: 'not_linked', muted: false },
      { system: 'pax8', state: 'not_linked', muted: false },
      { system: 'huntress', state: 'not_linked', muted: false },
    ]);
  });

  it('mutes badges of a connector that is not connected and does not evaluate "not linked" for it', () => {
    expect(deriveIntegrationBadges(
      readiness({ integrations: [{ system: 'quickbooks', state: 'error', reason: 'sync_error' }] }),
      [{ system: 'quickbooks', state: 'reauth_required' }, { system: 'pax8', state: 'disabled' }],
      CAPS,
    )).toEqual([{ system: 'quickbooks', state: 'error', reason: 'sync_error', muted: true }]);
  });

  it('never evaluates "not linked" for an internal org, nor when the partner has no connectors', () => {
    expect(deriveIntegrationBadges(readiness({ type: 'internal', integrations: [{ system: 'huntress', state: 'linked' }] }), CONNECTED, CAPS))
      .toEqual([{ system: 'huntress', state: 'linked', muted: false }]);
    expect(deriveIntegrationBadges(readiness({ integrations: [] }), [], CAPS)).toEqual([]);
    expect(deriveIntegrationBadges(readiness({ integrations: [] }), undefined, CAPS)).toEqual([]);
  });

  it('a Xero connector expects a xero badge, not a quickbooks one', () => {
    expect(deriveIntegrationBadges(readiness({ integrations: [{ system: 'quickbooks', state: 'linked' }] }), [{ system: 'xero', state: 'connected' }], CAPS))
      .toEqual([
        { system: 'quickbooks', state: 'linked', muted: false },
        { system: 'xero', state: 'not_linked', muted: false },
      ]);
  });
});

describe('the Unlinked filter and the Integrations column', () => {
  const row = (badges: BoardRow['badges']): BoardRow => ({ org: org(), readiness: readiness(), state: 'ready', chips: null, badges });

  it('BOARD_FILTERS carries unlinked between accountMissing and openTickets', () => {
    expect([...BOARD_FILTERS]).toEqual(['all', 'setupIncomplete', 'accountMissing', 'unlinked', 'openTickets', 'trial', 'archived']);
  });

  it('hasUnlinked is true only with at least one not_linked badge; matchesFilter uses it', () => {
    expect(hasUnlinked(null)).toBe(false);
    expect(hasUnlinked([])).toBe(false);
    expect(hasUnlinked([{ system: 'pax8', state: 'linked', muted: false }])).toBe(false);
    expect(hasUnlinked([{ system: 'pax8', state: 'not_linked', muted: false }])).toBe(true);
    expect(matchesFilter('unlinked', row([{ system: 'pax8', state: 'not_linked', muted: false }]))).toBe(true);
    expect(matchesFilter('unlinked', row([]))).toBe(false);
    expect(matchesFilter('unlinked', row(null))).toBe(false);
  });

  it('the filter and the column follow capabilities.integrations', () => {
    expect(visibleFilters(CAPS)).toContain('unlinked');
    expect(visibleFilters({ ...CAPS, integrations: false })).not.toContain('unlinked');
    expect(visibleFilters(null)).not.toContain('unlinked');
    expect(visibleColumns('both', CAPS)).toEqual(['setup', 'account', 'integrations', 'tickets']);
    expect(visibleColumns('setup', CAPS)).toEqual(['setup', 'integrations', 'tickets']);
    expect(visibleColumns('account', CAPS)).toEqual(['account', 'integrations', 'tickets']);
    expect(visibleColumns('both', { ...CAPS, integrations: false })).toEqual(['setup', 'account', 'tickets']);
  });
});

describe('connectorRepairs', () => {
  it('lists every connector that is not connected, once, with its settings link', () => {
    expect(connectorRepairs([
      { system: 'quickbooks', state: 'reauth_required' },
      { system: 'xero', state: 'disconnected' },
      { system: 'psa', state: 'disabled', provider: 'autotask' },
      { system: 'pax8', state: 'error' },
      { system: 'huntress', state: 'connected' },
      { system: 'sentinelone', state: 'disabled' },
    ])).toEqual([
      { system: 'quickbooks', state: 'reauth_required', href: '/integrations#quickbooks' },
      { system: 'xero', state: 'disconnected', href: '/integrations#accounting' },
      { system: 'psa', state: 'disabled', provider: 'autotask', href: '/integrations/psa' },
      { system: 'pax8', state: 'error', href: '/integrations#pax8' },
      { system: 'sentinelone', state: 'disabled', href: '/integrations#sentinelone' },
    ]);
    expect(connectorRepairs(undefined)).toEqual([]);
    expect(connectorRepairs(null)).toEqual([]);
  });
});

describe('deriveReadinessChips — noActiveContract and noBackup', () => {
  const keys = (list: Array<{ key: string }>) => list.map((c) => c.key);
  const derive = (r: ReadinessOrg, caps = CAPS, mode: 'native' | 'external' | 'off' = 'native', o = org()) =>
    deriveReadinessChips(o, r, caps, mode, NOW);

  it('noActiveContract: active customer org, native, contracts section present, zero active contracts', () => {
    const chips = derive(readiness({ account: { ...readiness().account, activeContracts: 0 } }));
    expect(keys(chips!.account)).toContain('noActiveContract');
    const contract = chips!.account.find((c) => c.key === 'noActiveContract')!;
    expect(contract).toMatchObject({ tone: 'warning', target: 'billing', href: '/organizations/org-1#billing' });
  });

  it.each([
    ['section withheld', readiness({ account: { ...readiness().account, activeContracts: undefined } }), { ...CAPS, contracts: false }, 'native'],
    ['has a contract', readiness(), CAPS, 'native'],
    ['internal org', readiness({ type: 'internal', account: { ...readiness().account, activeContracts: 0 } }), CAPS, 'native'],
    ['trial org', readiness({ status: 'trial', account: { ...readiness().account, activeContracts: 0 } }), CAPS, 'native'],
    ['suspended org', readiness({ status: 'suspended', account: { ...readiness().account, activeContracts: 0 } }), CAPS, 'native'],
    ['external service mode', readiness({ account: { ...readiness().account, activeContracts: 0 } }), CAPS, 'external'],
  ] as const)('noActiveContract does not fire: %s', (_label, r, caps, mode) => {
    expect(keys(derive(r, caps, mode)!.account)).not.toContain('noActiveContract');
  });

  it('noBackup: partner uses backup, this org has no active config — a setup chip, internal orgs included', () => {
    const chips = derive(readiness({ setup: { ...readiness().setup, backupConfigured: false } }));
    const backup = chips!.setup.find((c) => c.key === 'noBackup')!;
    expect(backup).toMatchObject({ tone: 'warning', target: 'backup', href: '/backup' });
    expect(keys(derive(readiness({ type: 'internal', setup: { ...readiness().setup, backupConfigured: false } }))!.setup)).toContain('noBackup');
    expect(repairHref('backup', 'org-1')).toBe('/backup');
  });

  it('noBackup does not fire when withheld, not applicable, or configured', () => {
    expect(keys(derive(readiness({ setup: { ...readiness().setup, backupApplicable: undefined, backupConfigured: undefined } }), { ...CAPS, backup: false })!.setup)).not.toContain('noBackup');
    expect(keys(derive(readiness({ setup: { ...readiness().setup, backupApplicable: false, backupConfigured: false } }))!.setup)).not.toContain('noBackup');
    expect(keys(derive(readiness())!.setup)).not.toContain('noBackup');
  });
});
