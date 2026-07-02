import { describe, it, expect, beforeEach, vi } from 'vitest';

const selectMock = vi.fn();
vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
  },
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
}));

import { loadReportBrandingForOrg, pngAspectFromDataUrl } from './reportBranding';

const ORG_ID = '22222222-2222-2222-2222-222222222222';

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => rows);
  return chain;
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
  it('uploaded PNG logo: name + logoDataUrl + logoAspect all resolve', async () => {
    selectMock.mockReturnValueOnce(
      selectChain([
        { partnerName: 'Olive MSP', partnerSettings: { branding: { logoUrl: png(1, 2) } } },
      ]),
    );
    const branding = await loadReportBrandingForOrg(ORG_ID);
    expect(branding).toEqual({ name: 'Olive MSP', logoDataUrl: png(1, 2), logoAspect: 0.5 });
  });

  it('external https logo URL: name resolves, logo degrades to null (server cannot format-verify it)', async () => {
    selectMock.mockReturnValueOnce(
      selectChain([
        { partnerName: 'Olive MSP', partnerSettings: { branding: { logoUrl: 'https://cdn.example.com/logo.png' } } },
      ]),
    );
    const branding = await loadReportBrandingForOrg(ORG_ID);
    expect(branding).toEqual({ name: 'Olive MSP', logoDataUrl: null, logoAspect: null });
  });

  it('org has no partner: all-null branding', async () => {
    selectMock.mockReturnValueOnce(selectChain([{ partnerName: null, partnerSettings: null }]));
    expect(await loadReportBrandingForOrg(ORG_ID)).toEqual({ name: null, logoDataUrl: null, logoAspect: null });
  });

  it('org row missing entirely: all-null branding', async () => {
    selectMock.mockReturnValueOnce(selectChain([]));
    expect(await loadReportBrandingForOrg(ORG_ID)).toEqual({ name: null, logoDataUrl: null, logoAspect: null });
  });
});
