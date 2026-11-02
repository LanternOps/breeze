// The quote shown on the register page. Core holds no prices: every number
// comes from billing's public pricing endpoint, relative so an EU deployment
// reads EU billing. Anything unexpected is null and the page shows no price.

export type BetaTerm = 'monthly' | 'annual' | 'two_year';

export type SignupOffer =
  | {
      kind: 'cloud_beta';
      perDevices: number;
      terms: Record<BetaTerm, number>;
      holdMonths: Record<BetaTerm, number>;
    }
  | {
      kind: 'cloud_per_device';
      floorCents: number;
      floorUnder: number;
      tiers: [fromDevices: number, cents: number][];
    };

export const SIGNUP_PRICING_PATH = '/billing/api/portal/pricing';

const BETA_TERMS: BetaTerm[] = ['monthly', 'annual', 'two_year'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export function parseSignupOffer(body: unknown): SignupOffer | null {
  if (!isObj(body)) return null;
  if (body.offer === 'cloud_beta') {
    const beta = body.beta;
    if (!isObj(beta) || !posInt(beta.perDevices) || !Array.isArray(beta.terms)) return null;
    const terms: Partial<Record<BetaTerm, number>> = {};
    const holdMonths: Partial<Record<BetaTerm, number>> = {};
    for (const t of beta.terms) {
      if (!isObj(t) || !BETA_TERMS.includes(t.term as BetaTerm)) return null;
      if (!posInt(t.amountCents) || !posInt(t.holdMonths)) return null;
      terms[t.term as BetaTerm] = t.amountCents;
      holdMonths[t.term as BetaTerm] = t.holdMonths;
    }
    if (!BETA_TERMS.every((term) => terms[term] !== undefined)) return null;
    return {
      kind: 'cloud_beta',
      perDevices: beta.perDevices,
      terms: terms as Record<BetaTerm, number>,
      holdMonths: holdMonths as Record<BetaTerm, number>,
    };
  }
  if (body.offer === 'cloud_per_device') {
    const pd = body.perDevice;
    if (!isObj(pd) || !Array.isArray(pd.tiers) || pd.tiers.length === 0 || !isObj(pd.floor)) return null;
    if (!posInt(pd.floor.underDevices) || !posInt(pd.floor.monthlyCents)) return null;
    const tiers: [number, number][] = [];
    for (const t of pd.tiers) {
      if (!isObj(t) || !posInt(t.fromDevices) || !posInt(t.monthlyCentsPerDevice)) return null;
      tiers.push([t.fromDevices, t.monthlyCentsPerDevice]);
    }
    return { kind: 'cloud_per_device', floorCents: pd.floor.monthlyCents, floorUnder: pd.floor.underDevices, tiers };
  }
  return null;
}

/** Never throws and never blocks signup: a failed lookup is null (no price shown). */
export async function fetchSignupOffer(fetchImpl: typeof fetch = fetch): Promise<SignupOffer | null> {
  try {
    const response = await fetchImpl(SIGNUP_PRICING_PATH, { credentials: 'omit', headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
    return parseSignupOffer(await response.json());
  } catch {
    return null;
  }
}

export function formatCents(cents: number, locale = 'en'): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}
