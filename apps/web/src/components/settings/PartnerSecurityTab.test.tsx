import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import PartnerSecurityTab, { parseAllowlistInput, currentIpCovered, displayIp } from './PartnerSecurityTab';

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
    const input = container.querySelector('#partner-security-session-timeout')!;
    expect(input.getAttribute('max')).toBe('720');
  });
});

describe('PartnerSecurityTab limit errors (#10081)', () => {
  it('a limit with no ceiling says "or more"; a valid or unset limit shows nothing', () => {
    const { getByTestId, queryByTestId } = render(<PartnerSecurityTab data={{ maxSessions: 0, minLength: 12 }} onChange={vi.fn()} />);
    expect(getByTestId('partner-security-max-sessions-error').textContent).toBe('Enter a whole number of 1 or more.');
    expect(queryByTestId('partner-security-min-length-error')).toBeNull();
    expect(queryByTestId('partner-security-expiration-error')).toBeNull();
  });

  it('native min/max hints match the shared bounds, so the browser never contradicts the inline message', () => {
    const { container, queryByTestId } = render(<PartnerSecurityTab data={{ expirationDays: 0, maxSessions: 50 }} onChange={vi.fn()} />);
    const attrs = (id: string) => {
      const el = container.querySelector(`#${id}`)!;
      return [el.getAttribute('min'), el.getAttribute('max')];
    };
    expect(attrs('partner-security-min-length')).toEqual(['6', '128']);
    expect(attrs('partner-security-expiration')).toEqual(['0', null]);
    expect(attrs('partner-security-session-timeout')).toEqual(['1', '720']);
    expect(attrs('partner-security-max-sessions')).toEqual(['1', null]);
    expect(queryByTestId('partner-security-expiration-error')).toBeNull();
    expect(queryByTestId('partner-security-max-sessions-error')).toBeNull();
  });

  it('a server message wins over the local range message', () => {
    const { getByTestId } = render(
      <PartnerSecurityTab data={{ minLength: 2 }} onChange={vi.fn()} serverErrors={{ minLength: 'Too small: expected number to be >=8' }} />,
    );
    expect(getByTestId('partner-security-min-length-error').textContent).toBe('Too small: expected number to be >=8');
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

describe('displayIp', () => {
  it('strips only the dotted IPv4-mapped prefix, case-insensitively', () => {
    expect(displayIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(displayIp('::FFFF:203.0.113.7')).toBe('203.0.113.7');
  });

  it('leaves plain IPv4, plain IPv6 and the hex-form mapped address untouched', () => {
    expect(displayIp('203.0.113.7')).toBe('203.0.113.7');
    expect(displayIp('2001:db8::1')).toBe('2001:db8::1');
    expect(displayIp('::ffff:cb00:7107')).toBe('::ffff:cb00:7107');
  });
});
