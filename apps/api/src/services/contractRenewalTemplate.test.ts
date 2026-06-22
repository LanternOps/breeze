import { describe, it, expect } from 'vitest';
import { buildContractRenewalEmail } from './contractRenewalTemplate';

describe('buildContractRenewalEmail', () => {
  const base = { contractName: 'Acme Managed Services', orgName: 'Acme Inc', endDate: '2027-07-01', contractUrl: 'https://app/contracts/abc' };

  it('advance notice names the contract, org, and date and has a plain-text fallback', () => {
    const out = buildContractRenewalEmail({ ...base, kind: 'advance', noticeDays: 30 });
    expect(out.subject).toMatch(/renew/i);
    expect(out.subject).toContain('Acme Managed Services');
    expect(out.html).toContain('Acme Inc');
    expect(out.html).toContain('2027-07-01');
    expect(out.text).toContain('Acme Managed Services');
    expect(out.text.length).toBeGreaterThan(0);
  });

  it('renewed confirmation states the new term end date', () => {
    const out = buildContractRenewalEmail({ ...base, kind: 'renewed', endDate: '2028-07-01' });
    expect(out.subject).toMatch(/renewed/i);
    expect(out.html).toContain('2028-07-01');
  });
});
