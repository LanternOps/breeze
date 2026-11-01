import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
import PartnerDefaultsTab from '../PartnerDefaultsTab';
import AgentVersionPinSelectors, { type PinnableVersions } from '../AgentVersionPinSelectors';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn(), useAuthStore: () => undefined }));

/**
 * #10372: placeholders/captions must agree with the field's inheritance badge.
 * TTL is "Org can override"; max TTL is "Partner-wide"; the partner pin is
 * "Org can override".
 */
const CONTRADICTS = /configure individually|pinned for all organizations/i;

describe('partner settings copy agrees with the inheritance badges (#10372)', () => {
  it('default-expiry select empty option does not say orgs configure individually', () => {
    render(<PartnerDefaultsTab data={{}} onChange={vi.fn()} pinnableVersions={null} />);
    const ttl = screen.getByTestId('partner-enrollment-ttl') as HTMLSelectElement;
    expect(ttl.options[0].textContent).not.toMatch(CONTRADICTS);
    expect(ttl.options[0].textContent).toBe('Not set — platform default; organizations can set their own');
  });

  it('max-lifetime select empty option says the cap applies to all organizations', () => {
    render(<PartnerDefaultsTab data={{}} onChange={vi.fn()} pinnableVersions={null} />);
    const max = screen.getByTestId('partner-max-enrollment-ttl') as HTMLSelectElement;
    expect(max.options[0].textContent).not.toMatch(CONTRADICTS);
    expect(max.options[0].textContent).toBe('Not set — platform maximum applies to all organizations');
  });

  it('partner pin caption says the pin is a default organizations can override', () => {
    const pinnable: PinnableVersions = {
      components: {
        agent: { versions: ['0.88.0'], promoted: ['0.88.0'] },
        watchdog: { versions: ['0.88.0'], promoted: ['0.88.0'] },
      },
    };
    render(<AgentVersionPinSelectors context="partner" value={{ agent: '0.88.0' }} onChange={vi.fn()} pinnable={pinnable} />);
    expect(document.body.textContent).not.toMatch(CONTRADICTS);
    expect(screen.getByText('Partner default — organizations can override')).toBeInTheDocument();
  });
});
