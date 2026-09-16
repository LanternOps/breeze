import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DEFAULT_IDENTITY_ACCESS_OPTIONS,
  IdentityAccessOptionsFields,
  identityAccessOptionsFromConfig,
} from './IdentityAccessOptionsForm';

describe('IdentityAccessOptionsFields (#5784 W06)', () => {
  it('does not offer a site selector — the report is org-wide', () => {
    render(<IdentityAccessOptionsFields value={DEFAULT_IDENTITY_ACCESS_OPTIONS} onChange={() => {}} />);
    expect(screen.queryByTestId('identity-access-sites')).toBeNull();
    expect(screen.getByTestId('identity-access-org-wide-note')).toBeInTheDocument();
  });

  it('reports a changed dormant threshold', async () => {
    const onChange = vi.fn();
    render(<IdentityAccessOptionsFields value={DEFAULT_IDENTITY_ACCESS_OPTIONS} onChange={onChange} />);
    const user = userEvent.setup();
    const input = screen.getByTestId('identity-access-dormant-days');
    await user.clear(input);
    await user.type(input, '90');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ dormantDays: 90 }));
  });

  it('toggles the administrator detail section', async () => {
    const onChange = vi.fn();
    render(<IdentityAccessOptionsFields value={DEFAULT_IDENTITY_ACCESS_OPTIONS} onChange={onChange} />);
    await userEvent.setup().click(screen.getByTestId('identity-access-admin-detail'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ adminDetail: false }));
  });

  it('normalises home countries to upper-case ISO-3166 alpha-2 codes', async () => {
    const onChange = vi.fn();
    render(<IdentityAccessOptionsFields value={DEFAULT_IDENTITY_ACCESS_OPTIONS} onChange={onChange} />);
    const user = userEvent.setup();
    await user.type(screen.getByTestId('identity-access-home-countries'), 'us, ca');
    // The server's schema is /^[A-Z]{2}$/ — a lower-case entry would 400.
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ homeCountries: ['US', 'CA'] }));
  });
});

describe('identityAccessOptionsFromConfig', () => {
  it('falls back to the spec defaults for an empty config', () => {
    expect(identityAccessOptionsFromConfig({})).toEqual(DEFAULT_IDENTITY_ACCESS_OPTIONS);
  });

  it('clamps an out-of-range dormantDays to the server schema bounds', () => {
    expect(identityAccessOptionsFromConfig({ dormantDays: 9999 }).dormantDays).toBe(365);
    expect(identityAccessOptionsFromConfig({ dormantDays: 0 }).dormantDays).toBe(1);
  });

  it('keeps adminDetail on unless it is explicitly false', () => {
    expect(identityAccessOptionsFromConfig({ adminDetail: false }).adminDetail).toBe(false);
    expect(identityAccessOptionsFromConfig({ adminDetail: 'yes' as never }).adminDetail).toBe(true);
  });

  it('drops a malformed country code rather than seeding a value the API would reject', () => {
    expect(identityAccessOptionsFromConfig({ homeCountries: ['US', 'United States', 'ca'] }).homeCountries)
      .toEqual(['US', 'CA']);
  });
});
