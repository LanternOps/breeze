import { describe, it, expect, afterEach, vi } from 'vitest';
import { partnerTrustMode } from './partnerTrustMode';

const env = process.env;
afterEach(() => { process.env = { ...env }; });

describe('partnerTrustMode', () => {
  it('is off when not hosted, regardless of the env value', () => {
    process.env.IS_HOSTED = 'false';
    process.env.PARTNER_TRUST_MODE = 'enforce';
    expect(partnerTrustMode()).toBe('off');
  });
  it('defaults to shadow when hosted and unset', () => {
    process.env.IS_HOSTED = 'true';
    delete process.env.PARTNER_TRUST_MODE;
    expect(partnerTrustMode()).toBe('shadow');
  });
  it('honours enforce when hosted', () => {
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'enforce';
    expect(partnerTrustMode()).toBe('enforce');
  });
  it('is off and silent when nothing at all is configured (fresh self-hosted install)', () => {
    delete process.env.IS_HOSTED; delete process.env.PARTNER_TRUST_MODE;
    delete process.env.IP_CLASSIFY_PROVIDER; delete process.env.IP_CLASSIFY_API_KEY; delete process.env.PARTNER_MEETING_URL;
    const warn = vi.spyOn(console, 'warn');
    expect(partnerTrustMode()).toBe('off');
    expect(warn).not.toHaveBeenCalled();
  });
  it('falls back to shadow on an unrecognised value', () => {
    process.env.IS_HOSTED = 'true';
    process.env.PARTNER_TRUST_MODE = 'yes';
    expect(partnerTrustMode()).toBe('shadow');
  });
});
