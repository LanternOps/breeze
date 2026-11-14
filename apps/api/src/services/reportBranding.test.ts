import { crc32 } from 'node:zlib';
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
import { asDataUrl, ordinaryPng, pngInflatingTo } from './__fixtures__/pngImageData';

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

/** A PNG data URL with the given intrinsic dimensions. Up to 4096 pixels a
 * side it is a real image (rows and all, as the report renderer decodes it);
 * past that, only the signature, IHDR and IEND, which is enough for the
 * header checks that refuse it. */
function png(w: number, h: number): string {
  if (w > 0 && h > 0 && w <= 4096 && h <= 4096) return asDataUrl(ordinaryPng({ width: w, height: h }));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const b = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
  it('returns width/height for a valid PNG data URL', async () => {
    expect(await pngAspectFromDataUrl(png(1, 2))).toBe(0.5);
  });

  it('returns null for non-PNG data URLs', async () => {
    expect(await pngAspectFromDataUrl('data:image/jpeg;base64,abcd')).toBeNull();
    expect(await pngAspectFromDataUrl('https://example.com/logo.png')).toBeNull();
  });

  it('returns null for malformed/truncated PNG data', async () => {
    expect(await pngAspectFromDataUrl('data:image/png;base64,abcd')).toBeNull();
  });

  it('returns null (no logo) for a PNG whose image data inflates past its declared size', async () => {
    // A 10×10 header in front of 32 MB of image data: the report renderer
    // would inflate all of it before comparing it with the declared rows.
    const logo = asDataUrl(pngInflatingTo({ width: 10, height: 10 }, 32 * 1024 * 1024));
    expect(logo.length).toBeLessThan(64 * 1024);
    expect(await pngAspectFromDataUrl(logo)).toBeNull();
  });

  it('keeps an ordinary logo, interlaced or not', async () => {
    expect(await pngAspectFromDataUrl(asDataUrl(ordinaryPng({ width: 300, height: 100 })))).toBe(3);
    expect(await pngAspectFromDataUrl(asDataUrl(ordinaryPng({ width: 300, height: 100, interlaced: true })))).toBe(3);
  });

  it('returns null (no logo) for a PNG too large to embed', async () => {
    expect(await pngAspectFromDataUrl(png(30_000, 30_000))).toBeNull();
    expect(await pngAspectFromDataUrl(png(0, 10))).toBeNull();
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
