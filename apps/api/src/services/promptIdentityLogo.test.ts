import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  PROMPT_LOGO_FAILURE_TTL_SECONDS,
  PROMPT_LOGO_TRANSIENT_FAILURE_TTL_SECONDS,
  __resetPromptLogoMemoForTests,
  __setPromptLogoDeadlineForTests,
  loadPromptIdentityLogo,
  peekPromptIdentityLogo,
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
  __setPromptLogoDeadlineForTests(null);
});
afterEach(() => {
  vi.restoreAllMocks();
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

// ---------------------------------------------------------------------------
// Review round 1 (#10314)
// ---------------------------------------------------------------------------

/** A body that sends `first` and then never another byte (a trickle that stalls). */
function stalledResponse(first: Uint8Array): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
  });
  return new Response(body, { status: 200 });
}

describe('the fetch always settles (overall deadline)', () => {
  it('passes an overall abort signal and a headers timeout to safeFetch', async () => {
    h.safeFetch.mockResolvedValue(okResponse(png(4, 4)));
    await loadPromptIdentityLogo('https://logos.example.com/msp.png');
    const [, init] = h.safeFetch.mock.calls[0]!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headersTimeoutMs).toBeGreaterThan(0);
    expect(init.headersTimeoutMs).toBeLessThanOrEqual(8_000);
  });

  it('a body that trickles and stalls settles at the deadline, null, and caches a transient failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setPromptLogoDeadlineForTests(60);
    h.safeFetch.mockResolvedValue(stalledResponse(png(4, 4).slice(0, 10)));
    const source = 'https://logos.example.com/slow.png';
    const started = Date.now();
    await expect(loadPromptIdentityLogo(source)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(h.store.get(promptLogoCacheKey(source))?.ttl).toBe(PROMPT_LOGO_TRANSIENT_FAILURE_TTL_SECONDS);
  });

  it('a fetch whose headers never arrive (and that ignores the signal) still settles at the deadline', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setPromptLogoDeadlineForTests(60);
    h.safeFetch.mockImplementation(() => new Promise(() => {}));
    await expect(loadPromptIdentityLogo('https://logos.example.com/hang.png')).resolves.toBeNull();
  });

  it('aborts the signal it handed safeFetch when the deadline passes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setPromptLogoDeadlineForTests(60);
    h.safeFetch.mockImplementation(() => new Promise(() => {}));
    await loadPromptIdentityLogo('https://logos.example.com/hang.png');
    const [, init] = h.safeFetch.mock.calls[0]!;
    expect((init.signal as AbortSignal).aborted).toBe(true);
  });
});

describe('failure TTLs: transient errors are retried sooner than a bad image', () => {
  it.each([
    ['a thrown fetch', () => h.safeFetch.mockRejectedValue(new Error('ECONNRESET'))],
    ['a 503', () => h.safeFetch.mockResolvedValue(new Response(null, { status: 503 }))],
  ])('%s caches the failure for the transient TTL', async (_label, arrange) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    arrange();
    const source = 'https://logos.example.com/flaky.png';
    expect(await loadPromptIdentityLogo(source)).toBeNull();
    expect(PROMPT_LOGO_TRANSIENT_FAILURE_TTL_SECONDS).toBeLessThan(PROMPT_LOGO_FAILURE_TTL_SECONDS);
    expect(h.store.get(promptLogoCacheKey(source))?.ttl).toBe(PROMPT_LOGO_TRANSIENT_FAILURE_TTL_SECONDS);
  });

  it.each([
    ['an SVG body', () => h.safeFetch.mockResolvedValue(okResponse(SVG))],
    ['a 404', () => h.safeFetch.mockResolvedValue(new Response(null, { status: 404 }))],
  ])('%s caches the failure for the full failure TTL', async (_label, arrange) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    arrange();
    const source = 'https://logos.example.com/bad.png';
    expect(await loadPromptIdentityLogo(source)).toBeNull();
    expect(h.store.get(promptLogoCacheKey(source))?.ttl).toBe(PROMPT_LOGO_FAILURE_TTL_SECONDS);
  });
});

describe('a refused logo is logged once, with the partner and a reason, never the URL', () => {
  const SECRET_PATH = 'https://logos.example.com/s3cr3t-token-path.png';
  it.each([
    ['ssrf_refused', 'https://10.0.0.5/s3cr3t-token-path.png', () => undefined],
    ['http_status', SECRET_PATH, () => h.safeFetch.mockResolvedValue(new Response(null, { status: 403 }))],
    ['fetch_failed', SECRET_PATH, () => h.safeFetch.mockRejectedValue(new Error('boom s3cr3t'))],
    ['invalid_image', SECRET_PATH, () => h.safeFetch.mockResolvedValue(okResponse(SVG))],
    ['too_large', dataUrl('image/png', png(10, 10, 262_145)), () => undefined],
    ['too_many_pixels', dataUrl('image/png', png(2048, 10)), () => undefined],
    ['invalid_data_url', 'data:image/png;base64,@@@not-base64@@@', () => undefined],
    ['unsupported_source', 'http://logos.example.com/s3cr3t-token-path.png', () => undefined],
  ])('%s', async (reason, source, arrange) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    arrange();
    expect(await loadPromptIdentityLogo(source, { partnerId: 'partner-1' })).toBeNull();
    const hits = warn.mock.calls.filter((c) => String(c[0]).includes('[promptIdentityLogo]'));
    expect(hits).toHaveLength(1);
    expect(hits[0]![1]).toEqual({ partnerId: 'partner-1', reason });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cr3t');
  });

  it('a cached failure is not logged again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.safeFetch.mockResolvedValue(okResponse(SVG));
    await loadPromptIdentityLogo(SECRET_PATH, { partnerId: 'partner-1' });
    __resetPromptLogoMemoForTests();
    await loadPromptIdentityLogo(SECRET_PATH, { partnerId: 'partner-1' });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[promptIdentityLogo]'))).toHaveLength(1);
  });
});

describe('truncated headers are refused', () => {
  // Each cut keeps the high byte of a dimension and drops the rest, so a
  // parser that read past the end (missing bytes as 0) would see a plausible
  // size.
  function jpegCutInsideWidth(): Uint8Array {
    const full = jpeg(256, 100); // width 0x0100: high byte 0x01, low byte 0x00
    const sof = full.findIndex((v, i) => v === 0xff && full[i + 1] === 0xc0);
    // FF C0 | len(2) precision(1) height(2) width(2): keep the width high byte only.
    return full.slice(0, sof + 2 + 6);
  }
  it.each([
    ['jpeg cut inside the SOF width', jpegCutInsideWidth()],
    ['png cut inside IHDR height', png(64, 300).slice(0, 23)],
    ['webp VP8X cut inside the height', webpVp8x(100, 300).slice(0, 29)],
    ['webp VP8L cut inside the size bits', webpVp8l(100, 300).slice(0, 23)],
    ['webp VP8 cut inside the height', webpVp8(100, 300).slice(0, 29)],
  ])('%s', (_label, bytes) => {
    expect(validatePromptLogo(bytes)).toBeNull();
  });
});

describe('percent-encoded data: URLs', () => {
  it('decodes data:image/png,%89PNG... to the right bytes and sha', async () => {
    const bytes = png(12, 12);
    const encoded = Array.from(bytes, (b) => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join('');
    const logo = await loadPromptIdentityLogo(`data:image/png,${encoded}`);
    expect(logo).toMatchObject({ sha256: sha(bytes), mime: 'image/png', width: 12, height: 12, bytes: bytes.length });
  });

  it('a mix of literal ASCII and escapes decodes too', async () => {
    const bytes = png(5, 5);
    const encoded = Array.from(bytes, (b) => (b >= 0x41 && b <= 0x5a ? String.fromCharCode(b) : `%${b.toString(16).padStart(2, '0')}`)).join('');
    expect(encoded).toContain('PNG');
    expect((await loadPromptIdentityLogo(`data:image/png,${encoded}`))?.sha256).toBe(sha(bytes));
  });

  it('a bad escape is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadPromptIdentityLogo('data:image/png,%8')).toBeNull();
  });
});

describe('peekPromptIdentityLogo (the heartbeat never waits on the network)', () => {
  it('https cold cache: pending at once, warms in the background, ready on the next peek', async () => {
    const bytes = png(9, 9);
    let release!: (r: Response) => void;
    h.safeFetch.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    const source = 'https://logos.example.com/warm.png';
    expect(await peekPromptIdentityLogo(source)).toEqual({ state: 'pending' });
    // A second peek while the fetch runs joins it: no second fetch.
    expect(await peekPromptIdentityLogo(source)).toEqual({ state: 'pending' });
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    release(okResponse(bytes));
    await vi.waitFor(async () => expect((await peekPromptIdentityLogo(source)).state).toBe('ready'));
    const ready = await peekPromptIdentityLogo(source);
    expect(ready.state === 'ready' && ready.logo.sha256).toBe(sha(bytes));
  });

  it('https cached failure: none', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.safeFetch.mockResolvedValue(okResponse(SVG));
    const source = 'https://logos.example.com/bad.png';
    await loadPromptIdentityLogo(source);
    expect(await peekPromptIdentityLogo(source)).toEqual({ state: 'none' });
  });

  it('data: needs no network: decoded and answered in the same call', async () => {
    const bytes = png(7, 7);
    const peek = await peekPromptIdentityLogo(dataUrl('image/png', bytes));
    expect(peek.state === 'ready' && peek.logo.sha256).toBe(sha(bytes));
  });

  it('a refused source is none, never pending', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await peekPromptIdentityLogo('https://127.0.0.1/x.png')).toEqual({ state: 'none' });
  });
});
