import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Redis is an in-memory map; safeFetch is a spy, so no test ever dials out.
const h = vi.hoisted(() => ({
  store: new Map<string, { value: string; ttl: number }>(),
  safeFetch: vi.fn(),
  redisAvailable: true,
}));
vi.mock('./redis', () => ({
  getRedis: () => (h.redisAvailable
    ? {
      get: vi.fn(async (key: string) => h.store.get(key)?.value ?? null),
      set: vi.fn(async (key: string, value: string, _ex: string, ttl: number) => {
        h.store.set(key, { value, ttl });
        return 'OK';
      }),
    }
    : null),
}));
vi.mock('./urlSafety', () => ({ safeFetch: (...args: unknown[]) => h.safeFetch(...args) }));

import {
  __resetPromptLogoMemoForTests,
  loadPromptIdentityLogo,
  promptLogoCacheKey,
  readCachedPromptLogo,
  validatePromptLogo,
} from './promptIdentityLogo';
import { SVG, jpeg, png, webpVp8, webpVp8l, webpVp8x } from '../__tests__/helpers/syntheticLogos';

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}


function dataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}
function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function okResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(Buffer.from(bytes), { status, headers: { 'content-type': 'image/svg+xml' } });
}

beforeEach(() => {
  h.store.clear();
  h.safeFetch.mockReset();
  h.redisAvailable = true;
  __resetPromptLogoMemoForTests();
});

describe('validatePromptLogo (headers only, by magic bytes)', () => {
  it('accepts a PNG and reads its IHDR dimensions', () => {
    expect(validatePromptLogo(png(64, 32))).toEqual({ mime: 'image/png', width: 64, height: 32 });
  });

  it.each([0xc0, 0xc1, 0xc2, 0xcf])('accepts a JPEG and reads the SOF%s frame header, skipping DHT', (sof) => {
    expect(validatePromptLogo(jpeg(200, 100, sof))).toEqual({ mime: 'image/jpeg', width: 200, height: 100 });
  });

  it.each([
    ['VP8', webpVp8(120, 60)],
    ['VP8L', webpVp8l(120, 60)],
    ['VP8X', webpVp8x(120, 60)],
  ])('accepts a WebP (%s) and reads its dimensions', (_label, bytes) => {
    expect(validatePromptLogo(bytes)).toEqual({ mime: 'image/webp', width: 120, height: 60 });
  });

  it('refuses SVG', () => {
    expect(validatePromptLogo(SVG)).toBeNull();
  });

  it('refuses anything over 262 144 bytes (a 300 KB PNG)', () => {
    expect(validatePromptLogo(png(64, 64, 300 * 1024))).toBeNull();
  });

  it('accepts exactly 262 144 bytes', () => {
    expect(validatePromptLogo(png(64, 64, 262_144))).not.toBeNull();
  });

  it.each([
    ['png 2048 wide', png(2048, 10)],
    ['png 2048 tall', png(10, 2048)],
    ['jpeg 2048', jpeg(2048, 2048)],
    ['webp VP8X 2048', webpVp8x(2048, 100)],
    ['webp VP8L 1025', webpVp8l(1025, 100)],
  ])('refuses a side over 1024 px (%s)', (_label, bytes) => {
    expect(validatePromptLogo(bytes)).toBeNull();
  });

  it('accepts 1024 px on a side', () => {
    expect(validatePromptLogo(png(1024, 1024))).toEqual({ mime: 'image/png', width: 1024, height: 1024 });
  });

  it.each([
    ['empty', new Uint8Array()],
    ['zero-size png', png(0, 10)],
    ['truncated png', png(10, 10).slice(0, 20)],
    ['jpeg without a frame header', Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])],
    ['riff that is not webp', Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')])],
    ['gif', Uint8Array.from([...ascii('GIF89a'), 10, 0, 10, 0])],
  ])('refuses %s', (_label, bytes) => {
    expect(validatePromptLogo(bytes)).toBeNull();
  });
});

describe('loadPromptIdentityLogo', () => {
  it('decodes a base64 data: URL and reports sha256/mime/bytes of the decoded image', async () => {
    const bytes = png(48, 48);
    const logo = await loadPromptIdentityLogo(dataUrl('image/png', bytes));
    expect(logo).toMatchObject({ sha256: sha(bytes), mime: 'image/png', bytes: bytes.length, width: 48, height: 48 });
    expect(Buffer.from(logo!.data).equals(Buffer.from(bytes))).toBe(true);
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it('takes the mime from the magic bytes, not from the data: header', async () => {
    const bytes = jpeg(16, 16);
    const logo = await loadPromptIdentityLogo(dataUrl('image/png', bytes));
    expect(logo?.mime).toBe('image/jpeg');
  });

  it('refuses an SVG data: URL', async () => {
    expect(await loadPromptIdentityLogo(dataUrl('image/svg+xml', SVG))).toBeNull();
  });

  it('refuses a 300 KB data: URL', async () => {
    expect(await loadPromptIdentityLogo(dataUrl('image/png', png(10, 10, 300 * 1024)))).toBeNull();
  });

  it('refuses a 2048 px data: URL', async () => {
    expect(await loadPromptIdentityLogo(dataUrl('image/png', png(2048, 2048)))).toBeNull();
  });

  it.each([
    'http://logos.example.com/msp.png',
    'https://10.0.0.5/msp.png',
    'https://127.0.0.1/msp.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/msp.png',
    'https://localhost/msp.png',
    'https://user:pw@logos.example.com/msp.png',
    'ftp://logos.example.com/msp.png',
    'javascript:alert(1)',
  ])('refuses %s without fetching it', async (source) => {
    expect(await loadPromptIdentityLogo(source)).toBeNull();
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it('fetches an https source once through safeFetch with a byte cap and a timeout', async () => {
    const bytes = webpVp8x(100, 50);
    h.safeFetch.mockResolvedValue(okResponse(bytes));
    const source = 'https://logos.example.com/msp.webp';
    const logo = await loadPromptIdentityLogo(source);
    expect(logo).toMatchObject({ sha256: sha(bytes), mime: 'image/webp', bytes: bytes.length });
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.safeFetch.mock.calls[0]!;
    expect(url).toBe(source);
    expect(init).toMatchObject({ method: 'GET', maxBytes: 262_144 });
    expect(init.timeoutMs).toBeGreaterThan(0);
    expect(init.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('refuses an https body that is not a valid logo (server says image, bytes say SVG)', async () => {
    h.safeFetch.mockResolvedValue(okResponse(SVG));
    expect(await loadPromptIdentityLogo('https://logos.example.com/msp.png')).toBeNull();
  });

  it('refuses a non-200 response (redirects are not followed)', async () => {
    h.safeFetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://10.0.0.5/' } }));
    expect(await loadPromptIdentityLogo('https://logos.example.com/msp.png')).toBeNull();
  });

  it('a fetch error (size cap, timeout, private DNS answer) means no logo, never a throw', async () => {
    h.safeFetch.mockRejectedValue(new Error('response body exceeded maxBytes (262144)'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadPromptIdentityLogo('https://logos.example.com/msp.png')).toBeNull();
  });

  it('caches a success under prompt-identity-logo:<sha256(source)> for 3600 s', async () => {
    const bytes = png(20, 20);
    h.safeFetch.mockResolvedValue(okResponse(bytes));
    const source = 'https://logos.example.com/msp.png';
    await loadPromptIdentityLogo(source);
    const key = `prompt-identity-logo:${sha(source)}`;
    expect(promptLogoCacheKey(source)).toBe(key);
    expect(h.store.get(key)?.ttl).toBe(3600);

    // A second load (fresh process memo) is served from Redis: no second fetch.
    __resetPromptLogoMemoForTests();
    const again = await loadPromptIdentityLogo(source);
    expect(again?.sha256).toBe(sha(bytes));
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    expect((await readCachedPromptLogo(sha(source)))?.sha256).toBe(sha(bytes));
  });

  it('caches a failure for 600 s and does not refetch inside it', async () => {
    h.safeFetch.mockResolvedValue(okResponse(SVG));
    const source = 'https://logos.example.com/bad.png';
    expect(await loadPromptIdentityLogo(source)).toBeNull();
    expect(h.store.get(promptLogoCacheKey(source))?.ttl).toBe(600);
    __resetPromptLogoMemoForTests();
    expect(await loadPromptIdentityLogo(source)).toBeNull();
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
  });

  it('a corrupted cache entry whose bytes no longer match its sha is a miss', async () => {
    const source = 'https://logos.example.com/msp.png';
    h.store.set(promptLogoCacheKey(source), {
      value: JSON.stringify({ v: 1, ok: true, sha256: 'f'.repeat(64), mime: 'image/png', width: 1, height: 1, data: Buffer.from(png(1, 1)).toString('base64') }),
      ttl: 3600,
    });
    const bytes = png(30, 30);
    h.safeFetch.mockResolvedValue(okResponse(bytes));
    const logo = await loadPromptIdentityLogo(source);
    expect(logo?.sha256).toBe(sha(bytes));
  });

  it('works without Redis (no cache, still validated)', async () => {
    h.redisAvailable = false;
    const bytes = png(8, 8);
    expect((await loadPromptIdentityLogo(dataUrl('image/png', bytes)))?.sha256).toBe(sha(bytes));
  });
});
