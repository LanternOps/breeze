import { describe, expect, it, vi } from 'vitest';
import { fetchSignupOffer } from './signupOffer';

const beta = {
  offer: 'cloud_beta', plans: [{ id: 'legacy', price: 999 }],
  beta: { perDevices: 250, terms: [
    { term: 'monthly', amountCents: 9900, holdMonths: 12 },
    { term: 'annual', amountCents: 100000, holdMonths: 12 },
    { term: 'two_year', amountCents: 180000, holdMonths: 24 },
  ] },
};
const perDevice = {
  offer: 'cloud_per_device', plans: [],
  perDevice: {
    tiers: [
      { fromDevices: 1, monthlyCentsPerDevice: 400 },
      { fromDevices: 1000, monthlyCentsPerDevice: 300 },
      { fromDevices: 2500, monthlyCentsPerDevice: 250 },
    ],
    floor: { underDevices: 50, monthlyCents: 19900 },
  },
};

function respond(body: unknown, init: { status?: number; type?: string } = {}) {
  const status = init.status ?? 200;
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? (init.type ?? 'application/json') : null) },
    json: async () => {
      if (typeof body === 'string') throw new SyntaxError('not json');
      return body;
    },
  });
}

describe('fetchSignupOffer', () => {
  it('reads the relative pricing endpoint without credentials', async () => {
    const f = respond(beta);
    await fetchSignupOffer(f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith('/billing/api/portal/pricing', expect.objectContaining({ credentials: 'omit' }));
    expect(f.mock.calls[0]![0]).toBe('/billing/api/portal/pricing');
  });

  it('parses the beta quote', async () => {
    expect(await fetchSignupOffer(respond(beta) as unknown as typeof fetch)).toEqual({
      kind: 'cloud_beta', perDevices: 250,
      terms: { monthly: 9900, annual: 100000, two_year: 180000 },
      holdMonths: { monthly: 12, annual: 12, two_year: 24 },
    });
  });

  it('parses the per-device quote', async () => {
    expect(await fetchSignupOffer(respond(perDevice) as unknown as typeof fetch)).toEqual({
      kind: 'cloud_per_device', floorCents: 19900, floorUnder: 50,
      tiers: [[1, 400], [1000, 300], [2500, 250]],
    });
  });

  it('returns null for anything unexpected', async () => {
    const bad = [
      respond({ plans: [{ id: 'community', price: 99 }] }),
      respond({ error: 'nope' }, { status: 404 }),
      respond('<html></html>', { type: 'text/html' }),
      vi.fn().mockRejectedValue(new Error('offline')),
      respond({ ...beta, beta: { ...beta.beta, terms: [{ term: 'monthly', amountCents: '9900', holdMonths: 12 }, ...beta.beta.terms.slice(1)] } }),
    ];
    for (const f of bad) expect(await fetchSignupOffer(f as unknown as typeof fetch)).toBeNull();
  });
});
