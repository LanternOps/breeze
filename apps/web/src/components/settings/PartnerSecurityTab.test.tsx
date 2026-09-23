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
