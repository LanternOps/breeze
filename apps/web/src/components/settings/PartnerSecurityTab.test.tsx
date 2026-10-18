import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import PartnerSecurityTab, { parseAllowlistInput, currentIpCovered } from './PartnerSecurityTab';

describe('parseAllowlistInput', () => {
  it('splits lines, trims, and drops blanks', () => {
    expect(parseAllowlistInput('203.0.113.0/24\n  \n10.0.0.1')).toEqual(['203.0.113.0/24', '10.0.0.1']);
  });

  it('returns an empty array for empty input', () => {
    expect(parseAllowlistInput('')).toEqual([]);
    expect(parseAllowlistInput('\n  \n')).toEqual([]);
  });
});

describe('currentIpCovered', () => {
  it('is true when the current IP is inside a listed range', () => {
    expect(currentIpCovered('203.0.113.10', ['203.0.113.0/24'])).toBe(true);
  });

  it('is true on an exact match', () => {
    expect(currentIpCovered('10.0.0.1', ['10.0.0.1'])).toBe(true);
  });

  it('is false when not covered', () => {
    expect(currentIpCovered('198.51.100.1', ['203.0.113.0/24'])).toBe(false);
  });

  it('is true (no false lockout warning) when current IP is unknown', () => {
    expect(currentIpCovered(null, ['203.0.113.0/24'])).toBe(true);
  });
});

describe('PartnerSecurityTab session timeout (#6111)', () => {
  it('allows up to 720 minutes (12 hours)', () => {
    const { container } = render(<PartnerSecurityTab data={{ sessionTimeout: 60 }} onChange={vi.fn()} />);
    const input = container.querySelector('input[type="number"][min="15"]')!;
    expect(input.getAttribute('max')).toBe('720');
  });
});

describe('PartnerSecurityTab allowlist textarea', () => {
  // The API only clears a stored allowlist when `ipAllowlist` is present in the
  // write (routes/orgs.ts preserves it when the key is omitted), so emptying the
  // textarea must emit an explicit [] — `undefined` is dropped by JSON and the
  // old list silently survives the save.
  it('emits an explicit empty list when the textarea is cleared', () => {
    const onChange = vi.fn();
    const { container } = render(
      <PartnerSecurityTab data={{ ipAllowlist: ['203.0.113.0/24'] }} onChange={onChange} />,
    );
    const textarea = container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ ipAllowlist: [] }));
  });
});

// #9168: a dual-stack listener reports an IPv4 client as `::ffff:a.b.c.d`. The
// button shows the familiar dotted quad, but the entry it ADDS stays the exact
// address the server sees: the allowlist matcher never crosses address
// families (apps/api/src/services/ipMatch.ts), so adding the bare IPv4 form
// would not cover the session that added it.
describe('PartnerSecurityTab add-current-IP button', () => {
  it('shows an IPv4-mapped address without the ::ffff: prefix, and adds the exact address', () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <PartnerSecurityTab
        data={{ ipAllowlist: [] }}
        onChange={onChange}
        status={{ currentIp: '::ffff:203.0.113.7', enforced: true, active: true } as never}
      />,
    );
    const button = getByRole('button', { name: /203\.0\.113\.7/ });
    expect(button.textContent).not.toContain('::ffff:');
    fireEvent.click(button);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ ipAllowlist: ['::ffff:203.0.113.7'] }));
  });
});
