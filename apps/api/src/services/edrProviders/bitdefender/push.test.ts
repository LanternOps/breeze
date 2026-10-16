import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Spy on the constant-time compare without changing its behaviour.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
import { timingSafeEqual } from 'node:crypto';
import { GZ_MAX_HINTS, verifyGravityZoneWebhook as verify } from './push';

const fx = (n: string) => readFileSync(join(__dirname, '__fixtures__', n), 'utf8');
const SECRET = 'q9Hk3bQ0V4m2Zc8pXw7tYr1uNs6aLd5eFg0hJiKoMlP';
const C1 = '5f0a1b2c3d4e5f60718293a1';
const C2 = '5f0a1b2c3d4e5f60718293a2';
const body = fx('push-event-add-events.json');

const events = (list: unknown[]) => JSON.stringify({ jsonrpc: '2.0', method: 'addEvents', params: { events: list } });

describe('verifyGravityZoneWebhook — secret', () => {
  it.each([
    ['wrong secret', { authorization: `${SECRET}x` }],
    ['missing header', {}],
    ['empty header', { authorization: '' }],
    ['bearer-prefixed secret', { authorization: `Bearer ${SECRET}` }],
    ['shorter prefix of the secret', { authorization: SECRET.slice(0, 10) }],
  ])('%s -> not ok, and no hints', (_n, headers) => {
    const r = verify({ headers, body }, SECRET);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty('hints');
  });

  it('an empty configured secret never verifies (even against an empty header)', () => {
    expect(verify({ headers: { authorization: '' }, body }, '').ok).toBe(false);
    expect(verify({ headers: { authorization: 'x' }, body }, '').ok).toBe(false);
  });

  it('correct secret with a forged Event-Push-Service-Md5 header -> ok (the md5 header is ignored)', () => {
    const r = verify({ headers: { authorization: SECRET, 'event-push-service-md5': 'deadbeef' }, body }, SECRET);
    expect(r.ok).toBe(true);
  });

  it('header name lookup is case-insensitive', () => {
    expect(verify({ headers: { Authorization: SECRET }, body }, SECRET).ok).toBe(true);
  });

  it('a length mismatch still goes through timingSafeEqual over equal-length SHA-256 digests', () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    expect(verify({ headers: { authorization: 'short' }, body }, SECRET).ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    const [a, b] = spy.mock.calls[0]! as unknown as [Buffer, Buffer];
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
  });
});

describe('verifyGravityZoneWebhook — hints', () => {
  it('emits one hint per distinct company, a detection id only for new-incident', () => {
    const r = verify({ headers: { authorization: SECRET }, body }, SECRET);
    expect(r).toEqual({
      ok: true,
      hints: [
        { vendorTenantId: C1 },
        { vendorTenantId: C2, vendorDetectionId: '6b0000000000000000000c01' },
      ],
    });
  });

  it('hint objects carry no field other than vendorTenantId / vendorDetectionId (no vendor content)', () => {
    const r = verify({ headers: { authorization: SECRET }, body }, SECRET);
    if (!r.ok) throw new Error('expected ok');
    for (const h of r.hints) {
      for (const k of Object.keys(h)) expect(['vendorTenantId', 'vendorDetectionId']).toContain(k);
    }
    expect(JSON.stringify(r)).not.toMatch(/EICAR|WS-EXAMPLE|192\.0\.2|phish|file_path|computer/);
  });

  it(`caps the hint list at ${GZ_MAX_HINTS}`, () => {
    const list = Array.from({ length: 250 }, (_, i) => ({ module: 'av', companyId: `c${String(i).padStart(23, '0')}` }));
    const r = verify({ headers: { authorization: SECRET }, body: events(list) }, SECRET);
    if (!r.ok) throw new Error('expected ok');
    expect(GZ_MAX_HINTS).toBe(100);
    expect(r.hints).toHaveLength(100);
  });

  it('drops non-string, over-long, empty and separator-bearing ids', () => {
    const r = verify({
      headers: { authorization: SECRET },
      body: events([
        { module: 'av', companyId: 12345 },
        { module: 'av', companyId: 'x'.repeat(129) },
        { module: 'av', companyId: '' },
        { module: 'av', companyId: 'a:b' },
        { module: 'av' },
        'not-an-object',
        null,
        { module: 'new-incident', companyId: C1, incidentId: { nested: true } },
        { module: 'av', companyId: C2, incidentId: '6b0000000000000000000c09' },
      ]),
    }, SECRET);
    expect(r).toEqual({ ok: true, hints: [{ vendorTenantId: C1 }, { vendorTenantId: C2 }] });
  });

  it('a valid secret with malformed JSON or an unknown method -> ok with no hints (one connection-wide poll)', () => {
    for (const b of ['{not json', '[]', '"str"', JSON.stringify({ method: 'other', params: { events: [{ companyId: C1 }] } }),
      JSON.stringify({ method: 'addEvents', params: { events: 'nope' } })]) {
      expect(verify({ headers: { authorization: SECRET }, body: b }, SECRET)).toEqual({ ok: true, hints: [] });
    }
  });
});
