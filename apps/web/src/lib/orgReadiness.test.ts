import { describe, expect, it } from 'vitest';
import {
  deriveReadinessChips,
  purgeCountdownDays,
  repairHref,
  shouldShowDeviceCount,
  staleCheckInDays,
  STALE_CHECK_IN_DAYS,
  type ChipKey,
  type ReadinessCapabilities,
  type ReadinessOrg,
} from './orgReadiness';
import {
  BOARD_COLUMNS,
  BOARD_FILTERS,
  compareRows,
  lensForFilter,
  matchesFilter,
  parseBoardHash,
  searchMatches,
  serializeBoardHash,
  sortRows,
  visibleColumns,
  visibleFilters,
  type BoardRow,
} from './orgReadiness';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const ORG_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ALL_CAPS: ReadinessCapabilities = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: true, integrations: false, contracts: false, backup: false,
};

type Overrides = Partial<Omit<ReadinessOrg, 'setup' | 'account'>> & {
  setup?: Partial<ReadinessOrg['setup']>;
  account?: Partial<ReadinessOrg['account']>;
};

/** A fully set-up, fully documented active customer — every chip test removes one thing from it. */
function readiness(overrides: Overrides = {}): ReadinessOrg {
  const { setup, account, ...rest } = overrides;
  return {
    orgId: ORG_ID,
    type: 'customer',
    status: 'active',
    ...rest,
    setup: { sites: 1, devices: 2, lastSeenAt: '2026-09-13T11:00:00.000Z', policyAssigned: true, ...setup },
    account: {
      primaryContact: { name: 'Jane Doe', email: 'jane@alpha.test', phone: '+1 555 0100', mobile: null },
      billingRoleContact: true,
      billingAddress: true,
      pendingInvitations: 0,
      overdueInvoices: 0,
      ...account,
    },
  };
}

const liveOrg = { id: ORG_ID, status: 'active' as const, type: 'customer' as const };
const daysAgo = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000 - extraMs).toISOString();
const derive = (
  r: ReadinessOrg | undefined,
  caps: ReadinessCapabilities | null = ALL_CAPS,
  mode: 'native' | 'external' | 'off' = 'native',
  org: Parameters<typeof deriveReadinessChips>[0] = liveOrg,
) => deriveReadinessChips(org, r, caps, mode, NOW);
const keys = (chips: Array<{ key: ChipKey }>) => chips.map((c) => c.key);

describe('deriveReadinessChips — a complete org', () => {
  it('yields no chips and an applicable account section', () => {
    expect(derive(readiness())).toEqual({ setup: [], account: [], accountApplicable: true });
  });

  it('returns null while the org has no readiness payload or the capabilities are unknown', () => {
    expect(derive(undefined)).toBeNull();
    expect(derive(readiness(), null)).toBeNull();
  });
});

describe('deriveReadinessChips — Setup chips', () => {
  it.each<[string, Overrides, ChipKey[], string]>([
    ['no site', { setup: { sites: 0 } }, ['noSite'], `/organizations/${ORG_ID}#sites`],
    ['no devices enrolled (and no check-in chip on top of it)', { setup: { devices: 0, lastSeenAt: null } }, ['noDevices'], `/organizations/${ORG_ID}#devices`],
    ['no agent has checked in', { setup: { devices: 3, lastSeenAt: null } }, ['noCheckIn'], `/organizations/${ORG_ID}#devices`],
    ['stale check-in at exactly the threshold', { setup: { lastSeenAt: daysAgo(STALE_CHECK_IN_DAYS) } }, ['staleCheckIn'], `/organizations/${ORG_ID}#devices`],
    ['no policy assigned', { setup: { policyAssigned: false } }, ['noPolicy'], '/configuration-policies'],
  ])('%s', (_name, overrides, expectedKeys, href) => {
    const result = derive(readiness(overrides))!;
    expect(keys(result.setup)).toEqual(expectedKeys);
    expect(result.setup[0].href).toBe(href);
    expect(result.setup[0].tone).toBe('warning');
  });

  it('reports the whole number of stale days', () => {
    const result = derive(readiness({ setup: { lastSeenAt: daysAgo(9, 5 * 60 * 60 * 1000) } }))!;
    expect(result.setup).toEqual([expect.objectContaining({ key: 'staleCheckIn', count: 9 })]);
  });

  it('does not flag a check-in younger than the threshold', () => {
    expect(derive(readiness({ setup: { lastSeenAt: daysAgo(STALE_CHECK_IN_DAYS - 1, 23 * 60 * 60 * 1000) } }))!.setup).toEqual([]);
  });

  it('does not flag an unparseable timestamp', () => {
    expect(derive(readiness({ setup: { lastSeenAt: 'not-a-date' } }))!.setup).toEqual([]);
  });

  it('keeps the spec order: site, devices, policy', () => {
    const result = derive(readiness({ setup: { sites: 0, devices: 0, policyAssigned: false } }))!;
    expect(keys(result.setup)).toEqual(['noSite', 'noDevices', 'noPolicy']);
  });

  it('still evaluates Setup for an internal org', () => {
    const result = derive(readiness({ type: 'internal', setup: { sites: 0 } }))!;
    expect(keys(result.setup)).toEqual(['noSite']);
  });
});

describe('deriveReadinessChips — Account data chips', () => {
  it.each<[string, Overrides, ChipKey[], string, 'warning' | 'destructive']>([
    ['no primary contact (and no email/phone chips on top of it)', { account: { primaryContact: null } }, ['primaryContact'], `/organizations/${ORG_ID}#contacts`, 'warning'],
    ['primary contact without email', { account: { primaryContact: { name: 'Jane Doe', email: null, phone: '+1', mobile: null } } }, ['contactEmail'], `/organizations/${ORG_ID}#contacts`, 'warning'],
    ['primary contact with neither phone nor mobile', { account: { primaryContact: { name: 'Jane Doe', email: 'j@x.test', phone: null, mobile: null } } }, ['contactPhone'], `/organizations/${ORG_ID}#contacts`, 'warning'],
    ['no billing-role contact', { account: { billingRoleContact: false } }, ['billingContact'], `/organizations/${ORG_ID}#contacts`, 'warning'],
    ['no billing address', { account: { billingAddress: false } }, ['billingAddress'], `/settings/organizations/${ORG_ID}`, 'warning'],
    ['overdue invoices', { account: { overdueInvoices: 2 } }, ['overdueInvoices'], `/organizations/${ORG_ID}#billing`, 'destructive'],
    ['invitations not accepted', { account: { pendingInvitations: 1 } }, ['invitation'], `/organizations/${ORG_ID}#contacts`, 'warning'],
  ])('%s', (_name, overrides, expectedKeys, href, tone) => {
    const result = derive(readiness(overrides))!;
    expect(keys(result.account)).toEqual(expectedKeys);
    expect(result.account[0].href).toBe(href);
    expect(result.account[0].tone).toBe(tone);
  });

  it('a mobile number satisfies reachability when the phone is empty', () => {
    const result = derive(readiness({ account: { primaryContact: { name: 'Jane Doe', email: 'j@x.test', phone: null, mobile: '+1 555 0199' } } }))!;
    expect(result.account).toEqual([]);
  });

  it('carries the counts for overdue invoices and pending invitations', () => {
    const result = derive(readiness({ account: { overdueInvoices: 3, pendingInvitations: 2 } }))!;
    expect(result.account).toEqual([
      expect.objectContaining({ key: 'overdueInvoices', count: 3 }),
      expect.objectContaining({ key: 'invitation', count: 2 }),
    ]);
  });

  it('keeps the spec order: contact, billing contact, billing address, overdue, invitation', () => {
    const result = derive(readiness({
      account: { primaryContact: null, billingRoleContact: false, billingAddress: false, overdueInvoices: 1, pendingInvitations: 1 },
    }))!;
    expect(keys(result.account)).toEqual(['primaryContact', 'billingContact', 'billingAddress', 'overdueInvoices', 'invitation']);
  });
});

describe('deriveReadinessChips — applicability rules', () => {
  it('an internal org gets no Account chips and is marked not applicable, even with everything missing', () => {
    const result = derive(readiness({
      type: 'internal',
      account: { primaryContact: null, billingRoleContact: false, billingAddress: false, overdueInvoices: 4, pendingInvitations: 2 },
    }))!;
    expect(result.account).toEqual([]);
    expect(result.accountApplicable).toBe(false);
  });

  it('the readiness payload type wins over the list row type', () => {
    const result = derive(readiness({ type: 'internal', account: { primaryContact: null } }), ALL_CAPS, 'native', { ...liveOrg, type: 'customer' })!;
    expect(result.account).toEqual([]);
  });

  it.each(['trial', 'suspended', 'churned', 'offboarding', 'merging'])(
    'a %s org gets contact chips but no billing chips',
    (status) => {
      const result = derive(readiness({
        status,
        account: { primaryContact: { name: 'Jane Doe', email: null, phone: '+1', mobile: null }, billingRoleContact: false, billingAddress: false, overdueInvoices: 2 },
      }))!;
      expect(keys(result.account)).toEqual(['contactEmail']);
    },
  );

  it('does not evaluate overdue invoices outside native service-management mode', () => {
    expect(derive(readiness({ account: { overdueInvoices: 2 } }), ALL_CAPS, 'external')!.account).toEqual([]);
    expect(derive(readiness({ account: { overdueInvoices: 2 } }), ALL_CAPS, 'off')!.account).toEqual([]);
  });

  it.each<[keyof ReadinessCapabilities, Overrides]>([
    ['sites', { setup: { sites: 0 } }],
    ['devices', { setup: { devices: 0 } }],
    ['policies', { setup: { policyAssigned: false } }],
    ['invoices', { account: { overdueInvoices: 2 } }],
    ['portalUsers', { account: { pendingInvitations: 2 } }],
    ['contacts', { account: { primaryContact: null } }],
  ])('a section absent from capabilities (%s) contributes no chip', (capability, overrides) => {
    const result = derive(readiness(overrides), { ...ALL_CAPS, [capability]: false })!;
    expect([...result.setup, ...result.account]).toEqual([]);
  });

  it('an archived org yields null, not an empty-but-applicable chip set (matches archivedRows\' encoding)', () => {
    const result = derive(
      readiness({ setup: { sites: 0 }, account: { primaryContact: null } }),
      ALL_CAPS,
      'native',
      { id: ORG_ID, status: 'archived', archived: true },
    );
    expect(result).toBeNull();
  });

  it('an org mid-archive-drain (offboarding + archived flag) also yields null', () => {
    const result = derive(readiness({ setup: { sites: 0 } }), ALL_CAPS, 'native', { id: ORG_ID, status: 'offboarding', archived: true });
    expect(result).toBeNull();
  });
});

describe('helpers', () => {
  it('staleCheckInDays floors whole days and rejects garbage', () => {
    expect(staleCheckInDays(daysAgo(3, 60_000), NOW)).toBe(3);
    expect(staleCheckInDays('nope', NOW)).toBeNull();
  });

  it('repairHref maps every target', () => {
    expect(repairHref('sites', ORG_ID)).toBe(`/organizations/${ORG_ID}#sites`);
    expect(repairHref('devices', ORG_ID)).toBe(`/organizations/${ORG_ID}#devices`);
    expect(repairHref('contacts', ORG_ID)).toBe(`/organizations/${ORG_ID}#contacts`);
    expect(repairHref('billing', ORG_ID)).toBe(`/organizations/${ORG_ID}#billing`);
    expect(repairHref('settings', ORG_ID)).toBe(`/settings/organizations/${ORG_ID}`);
    expect(repairHref('policies', ORG_ID)).toBe('/configuration-policies');
  });

  // #3699 — the org card renders `{{count}} devices`; the org-scoped projection
  // omits the count and a bare " devices" read as a loading bug. 0 is a real value.
  it('shouldShowDeviceCount shows real numbers including zero, hides absent and non-finite', () => {
    expect(shouldShowDeviceCount(12)).toBe(true);
    expect(shouldShowDeviceCount(0)).toBe(true);
    expect(shouldShowDeviceCount(undefined)).toBe(false);
    expect(shouldShowDeviceCount(Number.NaN)).toBe(false);
  });

  it('purgeCountdownDays rounds up and collapses null/garbage to null', () => {
    expect(purgeCountdownDays('2026-09-14T00:00:01.000Z', NOW)).toBe(1);
    expect(purgeCountdownDays('2026-09-13T12:00:00.000Z', NOW)).toBe(0);
    expect(purgeCountdownDays(null, NOW)).toBeNull();
    expect(purgeCountdownDays(undefined, NOW)).toBeNull();
    expect(purgeCountdownDays('garbage', NOW)).toBeNull();
  });
});

function row(overrides: {
  name?: string;
  status?: BoardRow['org']['status'];
  archived?: true;
  setup?: number;
  account?: number;
  open?: number;
  primary?: { name: string | null; email: string | null } | null;
}): BoardRow {
  const setupChips = Array.from({ length: overrides.setup ?? 0 }, () => ({
    key: 'noSite' as const, tone: 'warning' as const, target: 'sites' as const, href: '#',
  }));
  const accountChips = Array.from({ length: overrides.account ?? 0 }, () => ({
    key: 'primaryContact' as const, tone: 'warning' as const, target: 'contacts' as const, href: '#',
  }));
  const org = {
    id: 'aaaaaaaa-1111-4111-8111-111111111111',
    name: overrides.name ?? 'Alpha Ltd',
    status: overrides.status ?? ('active' as const),
    createdAt: '2026-01-01T00:00:00Z',
    ...(overrides.archived ? { archived: true as const } : {}),
  };
  const readiness: BoardRow['readiness'] = {
    orgId: org.id,
    type: 'customer',
    status: org.status,
    setup: { policyAssigned: true },
    account: {
      primaryContact: overrides.primary === undefined
        ? { name: 'Jane Doe', email: 'jane@alpha.test', phone: null, mobile: null }
        : overrides.primary && { ...overrides.primary, phone: null, mobile: null },
      billingRoleContact: true,
      billingAddress: true,
    },
    tickets: { open: overrides.open ?? 0, awaitingCustomer: 0, slaBreached: 0 },
  };
  return { org, readiness, state: 'ready', chips: { setup: setupChips, account: accountChips, accountApplicable: true }, badges: null };
}

describe('filters', () => {
  it('has the spec order', () => {
    expect([...BOARD_FILTERS]).toEqual(['all', 'setupIncomplete', 'accountMissing', 'unlinked', 'openTickets', 'trial', 'archived']);
    expect([...BOARD_COLUMNS]).toEqual(['setup', 'account', 'integrations', 'tickets']);
  });

  it('matchesFilter implements every predicate', () => {
    expect(matchesFilter('all', row({}))).toBe(true);
    expect(matchesFilter('setupIncomplete', row({ setup: 1 }))).toBe(true);
    expect(matchesFilter('setupIncomplete', row({}))).toBe(false);
    expect(matchesFilter('accountMissing', row({ account: 2 }))).toBe(true);
    expect(matchesFilter('accountMissing', row({}))).toBe(false);
    expect(matchesFilter('openTickets', row({ open: 3 }))).toBe(true);
    expect(matchesFilter('openTickets', row({ open: 0 }))).toBe(false);
    expect(matchesFilter('trial', row({ status: 'trial' }))).toBe(true);
    expect(matchesFilter('trial', row({}))).toBe(false);
    expect(matchesFilter('archived', row({ archived: true }))).toBe(true);
    expect(matchesFilter('archived', row({}))).toBe(false);
  });

  it('a row whose readiness has not landed matches no readiness filter', () => {
    const pending: BoardRow = { ...row({}), readiness: undefined, state: 'pending', chips: null };
    expect(matchesFilter('setupIncomplete', pending)).toBe(false);
    expect(matchesFilter('accountMissing', pending)).toBe(false);
    expect(matchesFilter('openTickets', pending)).toBe(false);
    expect(matchesFilter('all', pending)).toBe(true);
  });

  it('visibleFilters drops Open tickets without the tickets capability and always keeps Archived', () => {
    const caps = { sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: false, integrations: false, contracts: false, backup: false };
    expect(visibleFilters(caps)).toEqual(['all', 'setupIncomplete', 'accountMissing', 'trial', 'archived']);
    expect(visibleFilters({ ...caps, tickets: true, integrations: true })).toEqual([...BOARD_FILTERS]);
    expect(visibleFilters(null)).toEqual(['all', 'setupIncomplete', 'accountMissing', 'trial', 'archived']);
  });

  it('lensForFilter forces Both only when the filter’s evidence is hidden', () => {
    expect(lensForFilter('setupIncomplete', 'account')).toBe('both');
    expect(lensForFilter('setupIncomplete', 'setup')).toBe('setup');
    expect(lensForFilter('accountMissing', 'setup')).toBe('both');
    expect(lensForFilter('accountMissing', 'account')).toBe('account');
    expect(lensForFilter('openTickets', 'setup')).toBe('setup');
    expect(lensForFilter('trial', 'account')).toBe('account');
    expect(lensForFilter('all', 'setup')).toBe('setup');
  });
});

describe('columns', () => {
  const caps = { sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: true, integrations: true, contracts: true, backup: true };

  it('follows the lens, the tickets capability and the integrations capability', () => {
    expect(visibleColumns('both', caps)).toEqual(['setup', 'account', 'integrations', 'tickets']);
    expect(visibleColumns('setup', caps)).toEqual(['setup', 'integrations', 'tickets']);
    expect(visibleColumns('account', caps)).toEqual(['account', 'integrations', 'tickets']);
    expect(visibleColumns('both', { ...caps, tickets: false })).toEqual(['setup', 'account', 'integrations']);
  });

  it('renders Setup and Account (always-true capabilities) before the first batch lands, never Tickets', () => {
    expect(visibleColumns('both', null)).toEqual(['setup', 'account']);
  });
});

describe('sort', () => {
  const a = row({ name: 'Alpha', open: 1 });
  const b = row({ name: 'Beta', open: 5 });
  const c = row({ name: 'Gamma', open: 5 });

  it('manual keeps the given order (same array reference)', () => {
    const rows = [c, a, b];
    expect(compareRows('manual')).toBeNull();
    expect(sortRows(rows, 'manual')).toBe(rows);
  });

  it('name sorts A to Z', () => {
    expect(sortRows([c, a, b], 'name').map((r) => r.org.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('tickets sorts by open count descending, then name', () => {
    expect(sortRows([c, a, b], 'tickets').map((r) => r.org.name)).toEqual(['Beta', 'Gamma', 'Alpha']);
  });

  it('tickets treats an unknown count as zero', () => {
    const unknown: BoardRow = { ...row({ name: 'Zed' }), readiness: undefined, state: 'pending', chips: null };
    expect(sortRows([unknown, a], 'tickets').map((r) => r.org.name)).toEqual(['Alpha', 'Zed']);
  });
});

describe('search', () => {
  const r = row({ name: 'Alpha Ltd', primary: { name: 'Jane Doe', email: 'jane@alpha.test' } });

  it('matches org name, contact name and contact email, case-insensitively', () => {
    expect(searchMatches('alpha', r.org, r.readiness)).toBe(true);
    expect(searchMatches('JANE', r.org, r.readiness)).toBe(true);
    expect(searchMatches('@alpha.test', r.org, r.readiness)).toBe(true);
    expect(searchMatches('nothing', r.org, r.readiness)).toBe(false);
  });

  it('an empty query matches everything and a missing contact matches only the name', () => {
    expect(searchMatches('   ', r.org, r.readiness)).toBe(true);
    const noContact = row({ name: 'Alpha Ltd', primary: null });
    expect(searchMatches('jane', noContact.org, noContact.readiness)).toBe(false);
    expect(searchMatches('jane', r.org, undefined)).toBe(false);
  });
});

describe('hash', () => {
  it('serialises lens and filter explicitly so a localStorage default can never override a chosen value', () => {
    expect(serializeBoardHash({ lens: 'both', filter: 'all' })).toBe('lens=both&filter=all');
    expect(serializeBoardHash({ lens: 'setup', filter: 'trial' })).toBe('lens=setup&filter=trial');
  });

  it('parses its own output, with or without the leading #', () => {
    expect(parseBoardHash('#lens=setup&filter=archived')).toEqual({ lens: 'setup', filter: 'archived' });
    expect(parseBoardHash('lens=account')).toEqual({ lens: 'account' });
    expect(parseBoardHash('filter=openTickets')).toEqual({ filter: 'openTickets' });
  });

  it('ignores unknown values and falls back to undefined for an empty or foreign hash', () => {
    expect(parseBoardHash('')).toBeUndefined();
    expect(parseBoardHash('#')).toBeUndefined();
    expect(parseBoardHash('lens=nope&filter=bogus')).toBeUndefined();
    expect(parseBoardHash('lens=setup&filter=bogus')).toEqual({ lens: 'setup' });
    expect(parseBoardHash('tickets')).toBeUndefined();
  });

  it('treats a bare uuid as a row highlight (the incumbent’s selected-org deep link)', () => {
    expect(parseBoardHash('#AAAAAAAA-1111-4111-8111-111111111111')).toEqual({ highlightOrgId: 'aaaaaaaa-1111-4111-8111-111111111111' });
  });
});
