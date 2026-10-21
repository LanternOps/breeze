/**
 * #9418 W2a — the quote half of the customer-document assembler, per mode. The
 * DB is the table-keyed stand-in, so hidden-line ABSENCE cannot be proven here
 * (the filter is SQL): these tests prove the filter is IN the query (rendered
 * SQL), and customerDocument.quote.integration.test.ts proves it on Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    ctx: 'caller' as string,
    rows: {} as Record<string, readonly Record<string, unknown>[] | Error>,
    db: null as null | import('../__tests__/helpers/tableKeyedDb').TableKeyedDb,
  },
}));
vi.mock('../db', async () => {
  const { createTableKeyedDb } = await import('../__tests__/helpers/tableKeyedDb');
  state.db = createTableKeyedDb(() => state.rows, () => state.ctx);
  return {
    db: state.db.db,
    getCurrentDbAccessContext: () => undefined,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      const prev = state.ctx;
      state.ctx = 'system';
      try { return await fn(); } finally { state.ctx = prev; }
    },
  };
});
vi.mock('./sentry', () => ({ captureException: vi.fn() }));
const { renderContractsSpy } = vi.hoisted(() => ({ renderContractsSpy: vi.fn() }));
vi.mock('./contractTemplateRender', async (importActual) => {
  const actual = await importActual<typeof import('./contractTemplateRender')>();
  renderContractsSpy.mockImplementation(actual.renderContractBlocksForClient);
  return { ...actual, renderContractBlocksForClient: renderContractsSpy };
});

import {
  assembleCustomerQuoteDocument, loadCustomerQuoteRows, quoteDisplayStatus, CustomerDocumentModeError,
  type CustomerQuoteAssetPaths, type QuoteRow,
} from './customerQuoteDocument';
import { QuoteServiceError } from './quoteTypes';
import { buildSellerSnapshot } from './sellerSnapshot';
import { renderSql } from '../__tests__/helpers/tableKeyedDb';
import {
  PIN_QUOTE_ROW, PIN_QUOTE_BLOCK_ROWS, PIN_VISIBLE_QUOTE_LINE_ROWS, PIN_QUOTE_PARTNER_ROW, PIN_QUOTE_BRANDING_ROW,
  PIN_QUOTE_ID, PIN_QUOTE_ORG_ID, PIN_QUOTE_LINE_IDS, PIN_QUOTE_BLOCK_IDS,
} from '../routes/__fixtures__/customerQuotePin';
import PUBLIC_PIN from '../routes/__fixtures__/customerQuotePin.public.json';

const MODES = ['public', 'portal', 'staff'] as const;
const quote = (patch: Record<string, unknown> = {}) => ({ ...PIN_QUOTE_ROW, ...patch }) as unknown as QuoteRow;
const DRAFT = quote({
  status: 'draft', quoteNumber: null, issueDate: null, sentAt: null, sellerSnapshot: null,
  presentationSnapshot: null, documentLocale: null,
});
const ASSETS: CustomerQuoteAssetPaths = {
  lineImage: (l) => `/test/line-image/${l.id}`,
  contractFile: (blockId) => `/test/contract-file/${blockId}`,
};
/** PublicQuoteHeader + displayStatus, listed literally: a new header key is a visibility decision. */
const HEADER_DTO_KEYS = [
  'annualRecurringTotal', 'billToName', 'categoryBreakdown', 'coverPage', 'currencyCode', 'depositAmount',
  'depositDueTotal', 'depositType', 'displayStatus', 'dueOnAcceptanceTotal', 'expiryDate', 'id', 'introNotes',
  'issueDate', 'monthlyRecurringTotal', 'oneTimeTotal', 'quoteNumber', 'sellerSnapshot', 'status', 'subtotal',
  'taxRate', 'taxTotal', 'terms', 'termsAndConditions', 'title', 'total',
];
const INTERNAL_SENTINEL = /INTERNAL-/;

function setRows(patch: Record<string, readonly Record<string, unknown>[] | Error> = {}) {
  state.rows = {
    quote_blocks: PIN_QUOTE_BLOCK_ROWS,
    quote_lines: PIN_VISIBLE_QUOTE_LINE_ROWS,
    partners: [PIN_QUOTE_PARTNER_ROW],
    portal_branding: [PIN_QUOTE_BRANDING_ROW],
    ...patch,
  };
}
const selectOf = (table: string) => {
  const s = state.db!.selects.filter((x) => x.table === table);
  expect(s).toHaveLength(1);
  return s[0]!;
};

beforeEach(() => {
  renderContractsSpy.mockClear(); // keeps the pass-through implementation
  state.ctx = 'caller';
  state.db!.reads.length = 0;
  state.db!.selects.length = 0;
  setRows();
});

describe.each(MODES)('%s mode', (mode) => {
  it('the line query filters quoteId, orgId and customerVisible in SQL, on the caller context', async () => {
    const doc = await assembleCustomerQuoteDocument(quote(), mode, { assets: ASSETS });
    expect(doc.lines.map((l) => l.id)).toEqual([PIN_QUOTE_LINE_IDS.firewall, PIN_QUOTE_LINE_IDS.monitoring]);
    const s = selectOf('quote_lines');
    expect(s.ctx).toBe('caller');
    const w = renderSql(s.where);
    expect(w.sql).toMatch(/"quote_lines"\."quote_id" = \$\d/);
    expect(w.sql).toMatch(/"quote_lines"\."org_id" = \$\d/);
    expect(w.sql).toMatch(/"quote_lines"\."customer_visible" = \$\d/);
    expect(w.params).toEqual(expect.arrayContaining([PIN_QUOTE_ID, PIN_QUOTE_ORG_ID, true]));
    expect(w.sql).not.toMatch(/\bor\b/i); // a disjunction could widen the filter
  });

  it('the block query filters quoteId and orgId, on the caller context', async () => {
    await assembleCustomerQuoteDocument(quote(), mode, { assets: ASSETS });
    const s = selectOf('quote_blocks');
    expect(s.ctx).toBe('caller');
    const w = renderSql(s.where);
    expect(w.sql).toMatch(/"quote_blocks"\."quote_id" = \$\d/);
    expect(w.sql).toMatch(/"quote_blocks"\."org_id" = \$\d/);
    expect(w.params).toEqual(expect.arrayContaining([PIN_QUOTE_ID, PIN_QUOTE_ORG_ID]));
    expect(w.sql).not.toMatch(/\bor\b/i);
  });

  it('partner and portal_branding are read in their own system context, keyed on the authorized row', async () => {
    await assembleCustomerQuoteDocument(quote(), mode, { assets: ASSETS });
    expect(selectOf('partners').ctx).toBe('system');
    expect(renderSql(selectOf('partners').where).params).toEqual(expect.arrayContaining([PIN_QUOTE_ROW.partnerId]));
    expect(selectOf('portal_branding').ctx).toBe('system');
    expect(renderSql(selectOf('portal_branding').where).params).toEqual(expect.arrayContaining([PIN_QUOTE_ORG_ID]));
  });

  it('the header keyset is exactly PublicQuoteHeader + displayStatus; no internal quote column leaves', async () => {
    const doc = await assembleCustomerQuoteDocument(quote(), mode, { assets: ASSETS });
    expect(Object.keys(doc.quote).sort()).toEqual(HEADER_DTO_KEYS);
    expect(Object.keys(doc).sort()).toEqual(['blocks', 'branding', 'documentLocale', 'lines', 'quote']);
    expect(JSON.stringify(doc)).not.toMatch(INTERNAL_SENTINEL);
  });

  it('a draft is refused unless the mode is staff', async () => {
    if (mode === 'staff') {
      await expect(assembleCustomerQuoteDocument(DRAFT, mode, { assets: ASSETS })).resolves.toMatchObject({ quote: { status: 'draft', displayStatus: null } });
    } else {
      await expect(assembleCustomerQuoteDocument(DRAFT, mode, { assets: ASSETS })).rejects.toBeInstanceOf(CustomerDocumentModeError);
      expect(state.db!.reads).toEqual([]); // refused before any read
    }
  });

  it('a superseded quote: public refuses with 410 QUOTE_SUPERSEDED; portal and staff serve the raw status', async () => {
    const superseded = quote({ status: 'superseded' });
    if (mode === 'public') {
      const err = await assembleCustomerQuoteDocument(superseded, mode, { assets: ASSETS }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QuoteServiceError);
      expect(err).toMatchObject({ status: 410, code: 'QUOTE_SUPERSEDED' });
    } else {
      const doc = await assembleCustomerQuoteDocument(superseded, mode, { assets: ASSETS });
      expect(doc.quote).toMatchObject({ status: 'superseded', displayStatus: 'superseded' });
      expect(doc.lines).toHaveLength(2);
    }
  });
});

describe('status', () => {
  it('displayStatus: draft → null, sent → viewed, every other status as itself', () => {
    expect(quoteDisplayStatus('draft')).toBeNull();
    expect(quoteDisplayStatus('sent')).toBe('viewed');
    for (const s of ['viewed', 'accepted', 'declined', 'expired', 'converted', 'superseded'] as const) {
      expect(quoteDisplayStatus(s)).toBe(s);
    }
  });

  it('public maps sent → viewed in status; portal and staff keep sent; displayStatus is viewed in all three', async () => {
    const pub = await assembleCustomerQuoteDocument(quote(), 'public', { assets: ASSETS });
    const portal = await assembleCustomerQuoteDocument(quote(), 'portal', { assets: ASSETS });
    const staff = await assembleCustomerQuoteDocument(quote(), 'staff', { assets: ASSETS });
    expect([pub.quote.status, portal.quote.status, staff.quote.status]).toEqual(['viewed', 'sent', 'sent']);
    expect([pub.quote.displayStatus, portal.quote.displayStatus, staff.quote.displayStatus]).toEqual(['viewed', 'viewed', 'viewed']);
  });
});

describe('public mode reproduces the public link payload', () => {
  it('quote, blocks, lines and branding equal the recorded pin (plus displayStatus)', async () => {
    const tokenAssets: CustomerQuoteAssetPaths = {
      lineImage: (l) => `/quotes/public/${'pin-quote-token-'.padEnd(43, 'Q')}/line-image/${l.id}`,
      contractFile: (b) => `/quotes/public/x/contract-file/${b}`,
    };
    const doc = JSON.parse(JSON.stringify(await assembleCustomerQuoteDocument(quote(), 'public', { assets: tokenAssets })));
    const { displayStatus, ...header } = doc.quote;
    expect(displayStatus).toBe('viewed');
    expect(header).toEqual(PUBLIC_PIN.data.quote);
    expect(doc.blocks).toEqual(PUBLIC_PIN.data.blocks);
    expect(doc.lines).toEqual(PUBLIC_PIN.data.lines);
    expect(doc.branding).toEqual(PUBLIC_PIN.data.branding);
    expect(doc.documentLocale).toBe('en');
  });
});

describe('draft resolution (staff only)', () => {
  it('a staff draft gets the seller sending would freeze (from the partner); its theme from the partner', async () => {
    const doc = await assembleCustomerQuoteDocument(DRAFT, 'staff', { assets: ASSETS });
    const expected = buildSellerSnapshot(PIN_QUOTE_PARTNER_ROW);
    expect(doc.quote.sellerSnapshot).toEqual({
      name: expected.name, address: expected.address, phone: expected.phone, email: expected.email, website: expected.website,
    });
    expect(doc.quote.sellerSnapshot?.name).toBeTruthy();
    expect(doc.branding).toMatchObject({ theme: 'condensed', pageSize: 'a4' });
  });

  it('an issued quote always reads its frozen seller and presentation snapshots', async () => {
    const frozen = { ...PIN_QUOTE_ROW.sellerSnapshot, name: 'Frozen seller' };
    const doc = await assembleCustomerQuoteDocument(quote({ sellerSnapshot: frozen }), 'staff', { assets: ASSETS });
    expect(doc.quote.sellerSnapshot?.name).toBe('Frozen seller');
    expect(doc.branding).toMatchObject({ theme: 'classic', pageSize: 'letter' });
  });

  it('a legacy issued quote with no seller snapshot is NOT synthesized outside a staff draft', async () => {
    const doc = await assembleCustomerQuoteDocument(quote({ sellerSnapshot: null }), 'portal', { assets: ASSETS });
    expect(doc.quote.sellerSnapshot).toBeNull();
  });
});

describe('locale, assets, projection, failures', () => {
  it('documentLocale: the quote stamp, else the partner language, else en', async () => {
    expect((await assembleCustomerQuoteDocument(quote({ documentLocale: 'fr-FR' }), 'portal', { assets: ASSETS })).documentLocale).toBe('fr-FR');
    setRows({ partners: [{ ...PIN_QUOTE_PARTNER_ROW, settings: { language: 'pt-BR' } }] });
    expect((await assembleCustomerQuoteDocument(quote({ documentLocale: null }), 'portal', { assets: ASSETS })).documentLocale).toBe('pt-BR');
    setRows({ partners: [] });
    expect((await assembleCustomerQuoteDocument(quote({ documentLocale: null }), 'portal', { assets: ASSETS })).documentLocale).toBe('en');
  });

  it('a missing partner row: null partnerName (the routes apply their envelope fallback)', async () => {
    setRows({ partners: [] });
    const doc = await assembleCustomerQuoteDocument(quote(), 'portal', { assets: ASSETS });
    expect(doc.branding.partnerName).toBeNull();
  });

  it('line image paths come from the route, given the line id and its image source', async () => {
    const seen: unknown[] = [];
    const doc = await assembleCustomerQuoteDocument(quote(), 'staff', {
      assets: { ...ASSETS, lineImage: (l) => { seen.push(l); return `/p/${l.id}`; } },
    });
    expect(seen).toEqual([
      { id: PIN_QUOTE_LINE_IDS.firewall, imageId: '99999999-0000-4000-8000-000000000002', catalogItemId: null },
      { id: PIN_QUOTE_LINE_IDS.monitoring, imageId: null, catalogItemId: '99999999-0000-4000-8000-000000000003' },
    ]);
    expect(doc.lines.map((l) => l.imageUrl)).toEqual([`/p/${PIN_QUOTE_LINE_IDS.firewall}`, `/p/${PIN_QUOTE_LINE_IDS.monitoring}`]);
    for (const l of doc.lines) {
      expect(l).not.toHaveProperty('imageId');
      expect(l).not.toHaveProperty('catalogItemId');
      expect(l).not.toHaveProperty('unitCost');
    }
  });

  it('contract files are rendered with the route path and the document locale', async () => {
    await assembleCustomerQuoteDocument(quote({ documentLocale: 'de-DE' }), 'portal', { assets: ASSETS });
    expect(renderContractsSpy).toHaveBeenCalledTimes(1);
    const [, row, fileUrlFor, locale] = renderContractsSpy.mock.calls.at(-1)!;
    expect((row as { id: string }).id).toBe(PIN_QUOTE_ID);
    expect((fileUrlFor as (b: string) => string)(PIN_QUOTE_BLOCK_IDS.pricing)).toBe(`/test/contract-file/${PIN_QUOTE_BLOCK_IDS.pricing}`);
    expect(locale).toBe('de-DE');
  });

  it('blocks are the read-sanitized rows (a legacy script tag never leaves)', async () => {
    const doc = await assembleCustomerQuoteDocument(quote(), 'portal', { assets: ASSETS });
    const rich = doc.blocks.find((b) => b.id === PIN_QUOTE_BLOCK_IDS.richText)!;
    expect(rich.blockType).toBe('rich_text');
    expect(JSON.stringify(doc.blocks)).not.toContain('<script');
    expect(JSON.stringify(doc.blocks)).not.toContain('onerror');
  });

  it('OD-9 screen: no isChild key; a projection with bundleNesting adds it from parentLineId', async () => {
    const off = await assembleCustomerQuoteDocument(quote(), 'portal', { assets: ASSETS });
    for (const l of off.lines) expect(l).not.toHaveProperty('isChild');
    setRows({ quote_lines: [PIN_VISIBLE_QUOTE_LINE_ROWS[0]!, { ...PIN_VISIBLE_QUOTE_LINE_ROWS[1]!, parentLineId: PIN_QUOTE_LINE_IDS.firewall }] });
    const on = await assembleCustomerQuoteDocument(quote(), 'portal', {
      assets: ASSETS,
      projection: { screen: { ticketSubject: false, bundleNesting: true }, pdf: { ticketSubject: false, bundleNesting: true } },
    });
    expect(on.lines.map((l) => l.isChild)).toEqual([false, true]);
  });

  it('createdAt leaves as the ISO string JSON.stringify would send', async () => {
    const doc = await assembleCustomerQuoteDocument(quote(), 'portal', { assets: ASSETS });
    expect(doc.blocks[0]!.createdAt).toBe('2026-02-20T10:00:00.000Z');
    expect(doc.lines[0]!.createdAt).toBe('2026-02-20T10:00:00.000Z');
  });

  it('a failing partner or branding read rejects (fail closed, as both quote routes are today)', async () => {
    setRows({ partners: new Error('partners down') });
    await expect(assembleCustomerQuoteDocument(quote(), 'portal', { assets: ASSETS })).rejects.toThrow('partners down');
    setRows({ portal_branding: new Error('branding down') });
    await expect(assembleCustomerQuoteDocument(quote(), 'portal', { assets: ASSETS })).rejects.toThrow('branding down');
  });

  it('loadCustomerQuoteRows returns the sanitized blocks and the projected lines', async () => {
    const rows = await loadCustomerQuoteRows(quote());
    expect(rows.blocks.map((b) => b.id)).toEqual(PIN_QUOTE_BLOCK_ROWS.map((b) => b.id));
    expect(rows.lines.map((l) => l.id)).toEqual([PIN_QUOTE_LINE_IDS.firewall, PIN_QUOTE_LINE_IDS.monitoring]);
    expect(rows.lines[0]).not.toHaveProperty('unitCost');
    expect(rows.lines[0]).not.toHaveProperty('vendorSku');
  });
});
