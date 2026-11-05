import { describe, it, expect, beforeEach, vi } from 'vitest';

const selectMock = vi.fn();
vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
}));

// The partner hop goes through readWithPartnerAxisVisibility (#2822); the org
// hop must NOT. Mocked as a pass-through so the chain order below is the only
// thing under test here — the real escape is proved in
// __tests__/integration/reportBrandingPartnerVisibility.integration.test.ts.
const readWithPartnerAxisVisibilityMock = vi.fn(async <T>(fn: () => Promise<T>) => fn());
vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: <T>(fn: () => Promise<T>) => readWithPartnerAxisVisibilityMock(fn),
}));

vi.mock('../db/schema', () => ({
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partner_id',
  },
  partners: {
    id: 'partners.id',
    name: 'partners.name',
    settings: 'partners.settings',
  },
  portalBranding: {
    orgId: 'portal_branding.org_id',
    logoUrl: 'portal_branding.logo_url',
    primaryColor: 'portal_branding.primary_color',
    secondaryColor: 'portal_branding.secondary_color',
  },
}));

import { loadReportBrandingForOrg, loadReportBrandingForPartner, pngAspectFromDataUrl } from './reportBranding';

const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  return chain;
}

/** Stage the hops in order: the org lookup, the org's portal_branding row, then the partner lookup. */
function stage(orgRows: unknown[], partnerRows: unknown[] = [], brandRows: unknown[] = []) {
  selectMock
    .mockReturnValueOnce(selectChain(orgRows))
    .mockReturnValueOnce(selectChain(brandRows))
    .mockReturnValueOnce(selectChain(partnerRows));
}

/** Build a minimal-but-valid PNG data URL with the given intrinsic dimensions
 * (8-byte PNG signature + a 13-byte IHDR chunk carrying width/height). */
function png(w: number, h: number): string {
  const b = Buffer.alloc(24);
  b.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return 'data:image/png;base64,' + b.toString('base64');
}

beforeEach(() => {
  vi.clearAllMocks();
  // mockClear leaves queued `mockReturnValueOnce` values in place, and a test
  // that stages two hops but consumes one would otherwise hand its leftover
  // chain to the NEXT test's org lookup. Reset the queues explicitly.
  selectMock.mockReset();
  readWithPartnerAxisVisibilityMock.mockReset().mockImplementation(async (fn: () => Promise<unknown>) => fn());
});

describe('pngAspectFromDataUrl', () => {
  it('returns width/height for a valid PNG data URL', () => {
    expect(pngAspectFromDataUrl(png(1, 2))).toBe(0.5);
  });

  it('returns null for non-PNG data URLs', () => {
    expect(pngAspectFromDataUrl('data:image/jpeg;base64,abcd')).toBeNull();
    expect(pngAspectFromDataUrl('https://example.com/logo.png')).toBeNull();
  });

  it('returns null for malformed/truncated PNG data', () => {
    expect(pngAspectFromDataUrl('data:image/png;base64,abcd')).toBeNull();
  });
});

describe('loadReportBrandingForOrg', () => {
  it('passes hex brand colours through and drops anything that is not hex', async () => {
    stage([{ partnerId: PARTNER_ID }], [{ partnerName: 'Olive MSP', partnerSettings: { branding: { primaryColor: '#7a1d18', secondaryColor: 'orange' } } }]);
    const branding = await loadReportBrandingForOrg(ORG_ID);
    expect(branding.primaryColor).toBe('#7a1d18');
    expect(branding.accentColor).toBeNull();
  });

  it('uploaded PNG logo: name + logoDataUrl + logoAspect all resolve', async () => {
    stage([{ partnerId: PARTNER_ID }], [
      { partnerName: 'Olive MSP', partnerSettings: { branding: { logoUrl: png(1, 2) } } },
    ]);
    const branding = await loadReportBrandingForOrg(ORG_ID);
    expect(branding).toEqual({ name: 'Olive MSP', logoDataUrl: png(1, 2), logoAspect: 0.5, primaryColor: null, accentColor: null, contactEmail: null, contactName: null });
  });

  it('external https logo URL: name resolves, logo degrades to null (server cannot format-verify it)', async () => {
    stage([{ partnerId: PARTNER_ID }], [
      { partnerName: 'Olive MSP', partnerSettings: { branding: { logoUrl: 'https://cdn.example.com/logo.png' } } },
    ]);
    const branding = await loadReportBrandingForOrg(ORG_ID);
    expect(branding).toEqual({ name: 'Olive MSP', logoDataUrl: null, logoAspect: null, primaryColor: null, accentColor: null, contactEmail: null, contactName: null });
  });

  it('contact name + email ride along from partner settings (the portal closing line, #6078)', async () => {
    stage([{ partnerId: PARTNER_ID }], [
      { partnerName: 'Olive MSP', partnerSettings: { contact: { name: ' Dana Ops ', email: ' dana@olive.example ' } } },
    ]);
    const branding = await loadReportBrandingForOrg(ORG_ID);
    expect(branding.contactName).toBe('Dana Ops');
    expect(branding.contactEmail).toBe('dana@olive.example');
  });

  it('org has no partner: all-null branding, and the partner read never happens', async () => {
    stage([{ partnerId: null }]);
    expect(await loadReportBrandingForOrg(ORG_ID)).toEqual({ name: null, logoDataUrl: null, logoAspect: null });
    expect(readWithPartnerAxisVisibilityMock).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('org row missing entirely (cross-tenant orgId hidden by RLS): all-null branding, no partner read', async () => {
    stage([]);
    expect(await loadReportBrandingForOrg(ORG_ID)).toEqual({ name: null, logoDataUrl: null, logoAspect: null });
    expect(readWithPartnerAxisVisibilityMock).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('reads the partner row through readWithPartnerAxisVisibility ONLY — the org read runs outside it (#2822)', async () => {
    stage([{ partnerId: PARTNER_ID }], [{ partnerName: 'Olive MSP', partnerSettings: {} }]);
    await loadReportBrandingForOrg(ORG_ID);
    expect(readWithPartnerAxisVisibilityMock).toHaveBeenCalledTimes(1);
    expect(selectMock).toHaveBeenCalledTimes(3);
  });

  // #9673: reports follow the same partner default -> org override chain as
  // quotes and invoices (resolveDocumentBrand).
  it("the org's logo and colours override the partner's, field by field", async () => {
    stage(
      [{ partnerId: PARTNER_ID }],
      [{ partnerName: 'Olive MSP', partnerSettings: { branding: { logoUrl: png(1, 2), primaryColor: '#7a1d18', secondaryColor: '#0b1b2d' } } }],
      [{ logoUrl: png(2, 1), primaryColor: '#123456', secondaryColor: null }],
    );
    const branding = await loadReportBrandingForOrg(ORG_ID);
    expect(branding.logoDataUrl).toBe(png(2, 1));
    expect(branding.logoAspect).toBe(2);
    expect(branding.primaryColor).toBe('#123456');
    expect(branding.accentColor).toBe('#0b1b2d');
    expect(branding.name).toBe('Olive MSP');
  });

  it("an org secondary colour becomes the report accent", async () => {
    stage(
      [{ partnerId: PARTNER_ID }],
      [{ partnerName: 'Olive MSP', partnerSettings: { branding: { secondaryColor: '#0b1b2d' } } }],
      [{ logoUrl: null, primaryColor: null, secondaryColor: '#654321' }],
    );
    expect((await loadReportBrandingForOrg(ORG_ID)).accentColor).toBe('#654321');
  });

  it("the org's portal_branding row is read in the caller's own context, not the partner-axis escape", async () => {
    let brandReadInsideEscape = false;
    let insideEscape = false;
    readWithPartnerAxisVisibilityMock.mockImplementation(async (fn: () => Promise<unknown>) => {
      insideEscape = true;
      try { return await fn(); } finally { insideEscape = false; }
    });
    const brandChain = selectChain([]);
    const whereSpy = vi.fn(() => { brandReadInsideEscape = insideEscape; return brandChain; });
    brandChain.where = whereSpy;
    selectMock
      .mockReturnValueOnce(selectChain([{ partnerId: PARTNER_ID }]))
      .mockReturnValueOnce(brandChain)
      .mockReturnValueOnce(selectChain([{ partnerName: 'Olive MSP', partnerSettings: {} }]));
    await loadReportBrandingForOrg(ORG_ID);
    expect(whereSpy).toHaveBeenCalledOnce();
    expect(brandReadInsideEscape).toBe(false);
  });
});

describe('loadReportBrandingForPartner (#3198 W01)', () => {
  it('reads ONLY the partner row, through readWithPartnerAxisVisibility, and maps it like the org path', async () => {
    const partnerChain = selectChain([{
      partnerName: 'Olive MSP',
      partnerSettings: {
        branding: { logoUrl: png(1, 2), primaryColor: '#7a1d18', secondaryColor: 'orange' },
        contact: { name: ' Dana Ops ', email: ' dana@olive.example ' },
      },
    }]);
    selectMock.mockReturnValueOnce(partnerChain);

    const branding = await loadReportBrandingForPartner(PARTNER_ID);

    expect(branding).toEqual({
      name: 'Olive MSP',
      logoDataUrl: png(1, 2),
      logoAspect: 0.5,
      primaryColor: '#7a1d18',
      accentColor: null,
      contactEmail: 'dana@olive.example',
      contactName: 'Dana Ops',
    });
    // No organizations hop: the partner id comes from the proven owner.
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(readWithPartnerAxisVisibilityMock).toHaveBeenCalledTimes(1);
    expect(partnerChain.where).toHaveBeenCalledTimes(1);
  });

  it('missing partner row: all-null branding', async () => {
    selectMock.mockReturnValueOnce(selectChain([]));
    expect(await loadReportBrandingForPartner(PARTNER_ID)).toEqual({ name: null, logoDataUrl: null, logoAspect: null });
  });
});
