import { describe, expect, it } from 'vitest';
import { isValidRecipientEmail, mergeSeriesRecipients } from './recipients';

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
