import { describe, expect, it } from 'vitest';
import { ENTRA_SETUP_COPY, resolveEntraSetupStatus } from './entraSetup';

describe('entraSetup', () => {
  it('maps each known status to its own copy', () => {
    for (const status of ['proven', 'consent_done', 'invalid', 'failed'] as const) {
      expect(resolveEntraSetupStatus(status)).toBe(status);
      expect(ENTRA_SETUP_COPY[status].body.length).toBeGreaterThan(10);
    }
    expect(ENTRA_SETUP_COPY.consent_done.body).toMatch(/can now sign in to the portal with Microsoft/);
    expect(ENTRA_SETUP_COPY.invalid.body).toMatch(/invalid or has expired/);
  });

  it('treats unknown or missing statuses as failed', () => {
    expect(resolveEntraSetupStatus(null)).toBe('failed');
    expect(resolveEntraSetupStatus(undefined)).toBe('failed');
    expect(resolveEntraSetupStatus('')).toBe('failed');
    expect(resolveEntraSetupStatus('<script>')).toBe('failed');
    expect(resolveEntraSetupStatus('constructor')).toBe('failed');
  });
});

describe('entra-setup page wiring', () => {
  it('renders per status through the shared copy module on the public AuthLayout', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/pages/entra-setup.astro', 'utf8');
    expect(src).toContain('AuthLayout');
    expect(src).toContain('resolveEntraSetupStatus');
    expect(src).toContain('ENTRA_SETUP_COPY');
    expect(src).toContain('data-testid="portal-entra-setup-status"');
    expect(src).toContain('data-status');
  });
});
