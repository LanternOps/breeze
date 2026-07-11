import { describe, it, expect, afterEach } from 'vitest';
import { buildPortalUrl } from './helpers';

const ENV_KEYS = ['PUBLIC_PORTAL_URL', 'DASHBOARD_URL', 'PUBLIC_APP_URL'] as const;
const saved: Record<string, string | undefined> = {};
function setEnv(vals: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vals)) process.env[k] = v;
}
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('buildPortalUrl', () => {
  it('uses PUBLIC_PORTAL_URL when set', () => {
    setEnv({ PUBLIC_PORTAL_URL: 'https://us.2breeze.app/portal' });
    expect(buildPortalUrl('/accept-invite?token=abc')).toBe('https://us.2breeze.app/portal/accept-invite?token=abc');
  });
  it('falls back to DASHBOARD_URL + /portal', () => {
    setEnv({ DASHBOARD_URL: 'https://us.2breeze.app' });
    expect(buildPortalUrl('/reset-password?token=x')).toBe('https://us.2breeze.app/portal/reset-password?token=x');
  });
  it('does not double the /portal segment', () => {
    setEnv({ PUBLIC_PORTAL_URL: 'https://us.2breeze.app/portal/' });
    expect(buildPortalUrl('/reset-password')).toBe('https://us.2breeze.app/portal/reset-password');
  });
});
