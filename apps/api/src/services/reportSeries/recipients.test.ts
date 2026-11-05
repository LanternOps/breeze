import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), rows: [] as unknown[] }));
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../contacts/responsibilities', () => ({
  resolveOrganizationResponsibilitiesForOrgs: mocks.resolve,
}));

import { isValidRecipientEmail, mergeSeriesRecipients, resolveSeriesRuleContactIds } from './recipients';

function fakeTx() {
  const chain: Record<string, any> = {};
  for (const m of ['from', 'where']) chain[m] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(mocks.rows).then(resolve);
  return { select: vi.fn(() => chain) } as any;
}

describe('resolveSeriesRuleContactIds (the preview badge == will receive)', () => {
  it('dedupes ids and drops contacts whose address the worker would drop', async () => {
    mocks.resolve.mockResolvedValue([{ contactId: 'c1' }]);
    mocks.rows = [
      { orgId: 'o1', contactId: 'c1', email: 'a@acme.test' },
      { orgId: 'o1', contactId: 'c1', email: 'a@acme.test' },
      { orgId: 'o1', contactId: 'c2', email: 'not-an-email' },
      { orgId: 'o1', contactId: 'c3', email: null },
      { orgId: 'o1', contactId: 'c4', email: 'd@acme.test' },
    ];
    const ids = await resolveSeriesRuleContactIds({
      orgId: 'o1',
      rule: { primaryContact: true, roles: ['billing'] },
      tx: fakeTx(),
    });
    expect(ids).toEqual(['c1', 'c4']);
    expect(mocks.resolve).toHaveBeenCalledWith(expect.anything(), { orgIds: ['o1'], roles: ['billing'] });
  });

  it('is [] when the rule selects nothing', async () => {
    mocks.resolve.mockResolvedValue([]);
    mocks.rows = [];
    expect(await resolveSeriesRuleContactIds({
      orgId: 'o1',
      rule: { primaryContact: false, roles: [] },
      tx: fakeTx(),
    })).toEqual([]);
  });
});

describe('mergeSeriesRecipients (spec §3.5: (rule ∪ add) − remove; cc = internal CC)', () => {
  it('unions rule matches and adds, then subtracts removes by contact', () => {
    const out = mergeSeriesRecipients({
      ruleMatches: [
        { contactId: 'c1', email: 'owner@acme.test' },
        { contactId: 'c2', email: 'it@acme.test' },
      ],
      overrides: [
        { contactId: 'c3', email: 'cfo@acme.test', mode: 'add' },
        { contactId: 'c2', email: 'it@acme.test', mode: 'remove' },
      ],
      internalCc: ['noc@msp.test'],
    });
    expect(out.customer).toEqual(['owner@acme.test', 'cfo@acme.test']);
    expect(out.cc).toEqual(['noc@msp.test']);
  });

  it('a remove beats an add of the same contact', () => {
    const out = mergeSeriesRecipients({
      ruleMatches: [],
      overrides: [
        { contactId: 'c1', email: 'a@acme.test', mode: 'add' },
        { contactId: 'c1', email: 'a@acme.test', mode: 'remove' },
      ],
      internalCc: [],
    });
    expect(out.customer).toEqual([]);
  });

  it('dedupes emails case-insensitively, keeping the first spelling, and counts dropped addresses', () => {
    const out = mergeSeriesRecipients({
      ruleMatches: [
        { contactId: 'c1', email: 'Owner@Acme.test' },
        { contactId: 'c2', email: 'owner@acme.test' },
        { contactId: 'c3', email: null },
        { contactId: 'c4', email: 'not-an-email' },
      ],
      overrides: [],
      internalCc: ['noc@msp.test', 'NOC@msp.test', 'bad'],
    });
    expect(out.customer).toEqual(['Owner@Acme.test']);
    expect(out.cc).toEqual(['noc@msp.test']);
    expect(out.dropped).toBe(3);
  });

  it('isValidRecipientEmail is the builder/worker loose regex', () => {
    expect(isValidRecipientEmail(' a@b.co ')).toBe(true);
    expect(isValidRecipientEmail('a@b')).toBe(false);
    expect(isValidRecipientEmail(null)).toBe(false);
  });
});
