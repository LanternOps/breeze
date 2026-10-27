import { describe, expect, it, vi } from 'vitest';

import { resolveCallerLogo, type CallerLogoApi } from './callerVerifyLogo';
import type { Branding } from './CallerVerifyWindow';

/*
 * #10190 W04 (Todd's W03 decision 1): the caller-verify card shows the logo
 * bytes the agent synced to Assist, but only when /helper/config names the
 * same logo (branding.logo.sha256). Otherwise today's https logoUrl, else none.
 */

const SHA = 'c96253573225f1fa2044af43896a96056903b359eed7af9fad90bd626127ba99';
const OTHER = 'a'.repeat(64);
// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const ID = '11111111-1111-4111-8111-111111111111';

const withLogo: Branding = {
  partnerName: 'Example IT',
  logoUrl: 'https://cdn.example.invalid/logo.png',
  logoSha256: SHA,
};

/** Assist's command, standing in for Rust: bytes only for the synced sha. */
function api(synced: string | null): CallerLogoApi {
  return {
    fetch: vi.fn(async (_id: string, sha: string) => (synced && sha === synced ? { mime: 'image/png', data: PNG } : null)),
  };
}

const urls = () => {
  let n = 0;
  return { create: vi.fn((_b: Blob) => `blob:assist/${++n}`), revoke: vi.fn() };
};

describe('resolveCallerLogo', () => {
  it('match -> the synced bytes as a blob URL', async () => {
    const a = api(SHA);
    const u = urls();
    const logo = await resolveCallerLogo(withLogo, ID, a, u);
    expect(logo).toEqual({ src: 'blob:assist/1', kind: 'blob' });
    expect(a.fetch).toHaveBeenCalledWith(ID, SHA);
    const blob = u.create.mock.calls[0]![0];
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('mismatch (a stale or another partner\'s logo) -> https fallback', async () => {
    const u = urls();
    const logo = await resolveCallerLogo(withLogo, ID, api(OTHER), u);
    expect(logo).toEqual({ src: 'https://cdn.example.invalid/logo.png', kind: 'https' });
    expect(u.create).not.toHaveBeenCalled();
  });

  it('no identity synced -> https fallback, and no logo without one', async () => {
    expect(await resolveCallerLogo(withLogo, ID, api(null), urls())).toEqual({
      src: 'https://cdn.example.invalid/logo.png',
      kind: 'https',
    });
    // An uploaded (data:) logo has no https URL: with no synced bytes, no logo.
    expect(await resolveCallerLogo({ ...withLogo, logoUrl: null }, ID, api(null), urls())).toBeNull();
  });

  it('absent field (an older API) -> today: https only, and the command is not asked', async () => {
    const a = api(SHA);
    const today: Branding = { partnerName: 'Example IT', logoUrl: 'https://cdn.example.invalid/logo.png' };
    expect(await resolveCallerLogo(today, ID, a, urls())).toEqual({ src: today!.logoUrl, kind: 'https' });
    expect(await resolveCallerLogo({ ...today!, logoSha256: null }, ID, a, urls())).toEqual({
      src: today!.logoUrl,
      kind: 'https',
    });
    expect(await resolveCallerLogo({ partnerName: 'N', logoUrl: 'http://x.example/l.png' }, ID, a, urls())).toBeNull();
    expect(await resolveCallerLogo(null, ID, a, urls())).toBeNull();
    expect(a.fetch).not.toHaveBeenCalled();
  });

  it('a refused command (wrong window, no live request) -> https fallback, logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const refusing: CallerLogoApi = { fetch: vi.fn(async () => Promise.reject('wrong window')) };
    const logo = await resolveCallerLogo(withLogo, ID, refusing, urls());
    expect(logo).toEqual({ src: 'https://cdn.example.invalid/logo.png', kind: 'https' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('bytes that are not a PNG/JPEG/WebP base64 never become a blob', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of [
      { mime: 'image/svg+xml', data: PNG },
      { mime: 'image/png', data: 'not base64!!' },
      { mime: 'text/html', data: PNG },
    ]) {
      const u = urls();
      const odd: CallerLogoApi = { fetch: vi.fn(async () => bad) };
      expect(await resolveCallerLogo(withLogo, ID, odd, u)).toEqual({ src: withLogo!.logoUrl, kind: 'https' });
      expect(u.create).not.toHaveBeenCalled();
    }
    warn.mockRestore();
  });
});
