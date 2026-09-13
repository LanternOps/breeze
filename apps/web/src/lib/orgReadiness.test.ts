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

const NOW = new Date('2026-09-13T12:00:00.000Z');
const ORG_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const ALL_CAPS: ReadinessCapabilities = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true, invoices: true, tickets: true, integrations: false,
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

  it('an archived org has no chips at all', () => {
    const result = derive(
      readiness({ setup: { sites: 0 }, account: { primaryContact: null } }),
      ALL_CAPS,
      'native',
      { id: ORG_ID, status: 'archived', archived: true },
    )!;
    expect(result).toEqual({ setup: [], account: [], accountApplicable: false });
  });

  it('an org mid-archive-drain (offboarding + archived flag) has no chips either', () => {
    const result = derive(readiness({ setup: { sites: 0 } }), ALL_CAPS, 'native', { id: ORG_ID, status: 'offboarding', archived: true })!;
    expect(result.setup).toEqual([]);
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
