import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  billingOn: true, rows: [] as unknown[][], capture: vi.fn(), holds: false,
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'where', 'limit']) chain[name] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(m.rows.shift() ?? []).then(resolve);
  return { db: chain, withSystemDbAccessContext: (fn: () => unknown) => fn(), runOutsideDbContext: (fn: () => unknown) => fn() };
});
vi.mock('../../db/partnerAxisRead', () => ({ readWithPartnerAxisVisibility: (fn: () => unknown) => fn() }));
vi.mock('../billingEnabled', () => ({ isBillingEnabledForOrg: async () => m.billingOn }));
vi.mock('./setupSession', () => ({ prepareAutopayCapture: m.capture }));
vi.mock('./setupCompletion', () => ({ persistCapturedAutopayMethod: vi.fn() }));
vi.mock('./paymentMethods', () => ({ enqueueRejectedAutopayMethod: vi.fn() }));
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: vi.fn() }));
vi.mock('./reservation', () => ({ holdsClientMoney: async () => m.holds }));
vi.mock('./autopayGate', () => ({ isAutopayEnabledForPartner: async () => true }));
vi.mock('./consentText', () => ({
  buildAutopayDisclosure: async () => ({ achMode: 'card_only', text: 'Consent', version: 'v1', hash: 'a'.repeat(64) }),
  withAcceptedAutopayDisclosure: (_hash: string, fn: () => unknown) => fn(),
}));
import { getInvoiceAutopayOffer, prepareCardPayAndSave } from './payAndSave';

const INVOICE = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const save = { saveForAutopay: true, consentAccepted: true as const, disclosureHash: 'a'.repeat(64), contactEmail: 'billing@example.test' };

beforeEach(() => {
  vi.clearAllMocks(); m.billingOn = true; m.holds = false; m.rows.length = 0;
  m.capture.mockResolvedValue({ id: 'attempt', stripeCustomerId: 'cus_one' });
});

describe('getInvoiceAutopayOffer with billing_enabled', () => {
  it('offers the save box when billing is on', async () => {
    m.rows.push([{ status: 'active', partnerId: 'p1' }]);
    expect(await getInvoiceAutopayOffer(ORG, INVOICE)).toMatchObject({ eligible: true, disclosureHash: 'a'.repeat(64) });
  });
  it('hides the save box when billing is off', async () => {
    m.billingOn = false;
    m.rows.push([{ status: 'active', partnerId: 'p1' }]);
    expect(await getInvoiceAutopayOffer(ORG, INVOICE)).toBeNull();
  });
});

describe('prepareCardPayAndSave with billing_enabled', () => {
  it('captures the card when billing is on', async () => {
    expect(await prepareCardPayAndSave(INVOICE, ORG, save, 'key')).toEqual({ id: 'attempt', stripeCustomerId: 'cus_one' });
    expect(m.capture).toHaveBeenCalledOnce();
  });
  it('a stale save-for-autopay payload pays normally, without enrolling, when billing is off', async () => {
    m.billingOn = false;
    expect(await prepareCardPayAndSave(INVOICE, ORG, save, 'key')).toBeNull();
    expect(m.capture).not.toHaveBeenCalled();
  });
});
