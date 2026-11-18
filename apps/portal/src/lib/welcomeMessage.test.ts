import { describe, expect, it } from 'vitest';
import { landingWelcomeMessage, portalWelcomeMessage } from './welcomeMessage';

describe('portalWelcomeMessage (#9675)', () => {
  it('returns nothing when the org never wrote one', () => {
    expect(portalWelcomeMessage({})).toBeNull();
    expect(portalWelcomeMessage({ welcomeMessage: null })).toBeNull();
    expect(portalWelcomeMessage({ welcomeMessage: '' })).toBeNull();
    expect(portalWelcomeMessage({ welcomeMessage: '  \n\t ' })).toBeNull();
  });

  it('trims the edges and keeps the line breaks the MSP typed', () => {
    expect(portalWelcomeMessage({ welcomeMessage: '  Welcome to Acme IT.\r\nCall us any time.  \n' })).toBe(
      'Welcome to Acme IT.\nCall us any time.'
    );
  });

  it('passes markup through as text for the template to escape, never as HTML', () => {
    expect(portalWelcomeMessage({ welcomeMessage: '<b>Hi</b>' })).toBe('<b>Hi</b>');
  });
});

describe('landingWelcomeMessage (#9675)', () => {
  const message = 'Welcome to Acme IT.';

  it('shows on the proposals page when that is the landing page', () => {
    expect(landingWelcomeMessage({ welcomeMessage: message }, '/quotes')).toBe(message);
    expect(landingWelcomeMessage({ welcomeMessage: message, enableDashboard: false }, '/quotes')).toBe(message);
  });

  it('shows on the dashboard when the org turned the dashboard on, and not on proposals', () => {
    const branding = { welcomeMessage: message, enableDashboard: true };
    expect(landingWelcomeMessage(branding, '/dashboard')).toBe(message);
    expect(landingWelcomeMessage(branding, '/quotes')).toBeNull();
  });

  it('stays off every other page, including detail pages under the landing path', () => {
    expect(landingWelcomeMessage({ welcomeMessage: message }, '/invoices')).toBeNull();
    expect(landingWelcomeMessage({ welcomeMessage: message }, '/quotes/abc')).toBeNull();
    expect(landingWelcomeMessage({ welcomeMessage: message, enableDashboard: true }, '/devices')).toBeNull();
  });

  it('tolerates a trailing slash on the landing path', () => {
    expect(landingWelcomeMessage({ welcomeMessage: message }, '/quotes/')).toBe(message);
  });

  it('returns nothing on the landing page when the message is blank', () => {
    expect(landingWelcomeMessage({ welcomeMessage: '   ' }, '/quotes')).toBeNull();
  });
});
