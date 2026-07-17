import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// Record every contract_documents insert payload so the tests can assert the
// row shape (contract linkage, sha256 over the pdf, byteSize) without a DB. The
// insert chain resolves .returning() to a synthetic id per call.
const insertedValues: Array<Record<string, unknown>> = [];
// Rows the SELECT/UPDATE-path calls should resolve to (used by the
// linkContractDocument tests); createExecutedDocuments leaves this empty and
// keeps its synthetic-insert-id behavior.
const selectResults: unknown[][] = [];
function queueResult(rows: unknown[]) { selectResults.push(rows); }

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn((v: Record<string, unknown>) => {
    insertedValues.push(v);
    return chain;
  });
  chain.returning = vi.fn(() =>
    selectResults.length ? Promise.resolve(selectResults.shift()) : Promise.resolve([{ id: `doc-${insertedValues.length}` }]),
  );
  for (const m of ['select', 'from', 'where', 'limit', 'update', 'set']) chain[m] = vi.fn(() => chain);
  // Awaiting the chain (a select's `.limit(1)`) shifts the next queued result.
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(selectResults.shift() ?? []).then(resolve);
  return {
    db: chain,
    // contractTemplateRender (imported transitively) reads these at module load.
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import {
  createExecutedDocuments,
  buildContractHashParts,
  assertContractRenderDataComplete,
  linkContractDocument,
  ContractDocumentServiceError,
} from './contractDocumentService';
import type { AuthContext } from '../middleware/auth';
import type { ContractBlockRenderData } from './contractTemplateRender';
import { QuoteServiceError } from './quoteTypes';

const EFFECTIVE = '2026-07-16';

function makeQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q1', orgId: 'org1', partnerId: 'p1', currencyCode: 'USD',
    billToName: 'Acme Co', billToAddress: null, sellerSnapshot: { name: 'MSP LLC' },
    quoteNumber: 'Q-1', title: 'Proposal',
    oneTimeTotal: '100.00', monthlyRecurringTotal: '10.00', annualRecurringTotal: '0.00', total: '110.00',
    expiryDate: '2026-08-01',
    ...overrides,
  } as any;
}

function authoredRenderData(overrides: Partial<ContractBlockRenderData> = {}): ContractBlockRenderData {
  return {
    blockId: 'cb1', templateId: 't1', templateVersionId: 'v1',
    sourceType: 'authored', bodyHtml: '<p>Effective {{dates.effective}} for {{client.name}}.</p>',
    fileData: null, versionSha256: 'a'.repeat(64), declaredVariables: [],
    templateName: 'Master Services Agreement', versionNumber: 1,
    ...overrides,
  };
}

const authoredBlock = { id: 'cb1', blockType: 'contract', content: { templateId: 't1', templateVersionId: 'v1', variableValues: {} } };

describe('contractDocumentService.createExecutedDocuments', () => {
  beforeEach(() => {
    insertedValues.length = 0;
    vi.clearAllMocks();
  });

  it('inserts one authored contract_documents row linked to the acceptance + FIRST contract, sha256 over the pdf bytes', async () => {
    const ids = await createExecutedDocuments(
      makeQuote(), 'acc1', ['contractA', 'contractB'], [authoredRenderData()], [authoredBlock], EFFECTIVE,
    );

    expect(ids).toEqual(['doc-1']);
    expect(insertedValues).toHaveLength(1);
    const row = insertedValues[0]!;
    expect(row.orgId).toBe('org1');
    expect(row.quoteId).toBe('q1');
    expect(row.quoteAcceptanceId).toBe('acc1');
    // Deterministic first-created billing contract.
    expect(row.contractId).toBe('contractA');
    expect(row.templateId).toBe('t1');
    expect(row.templateVersionId).toBe('v1');

    // Authored → rendered_html is the substituted body; pdf is a real pdfkit doc.
    expect(row.renderedHtml).toContain('Effective');
    expect(row.renderedHtml).toContain('Acme Co'); // {{client.name}} resolved
    expect(String(row.renderedHtml)).not.toContain('{{'); // no raw tokens leak

    const pdf = row.pdfData as Buffer;
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(row.byteSize).toBe(pdf.length);
    expect(row.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
  });

  it('re-sanitizes the executed snapshot: a javascript: href variable value never lands in rendered_html or the PDF', async () => {
    // A body with a variable inside an href — a legal write-time shape ({{link}} is
    // a scheme-less relative href). The hostile scheme arrives only via substitution,
    // AFTER write-time sanitization, so the executed snapshot must re-sanitize.
    const hrefRenderData = authoredRenderData({
      bodyHtml: '<p>See <a href="{{link}}">the portal</a></p>',
    });
    const hostileBlock = { id: 'cb1', blockType: 'contract', content: { variableValues: { link: 'javascript:alert(1)' } } };

    await createExecutedDocuments(makeQuote(), 'acc1', ['contractA'], [hrefRenderData], [hostileBlock], EFFECTIVE);
    const row = insertedValues[0]!;

    // Stored rendered_html carries no live javascript: link.
    expect(String(row.renderedHtml)).not.toContain('javascript:');
    expect(String(row.renderedHtml)).toContain('the portal');
    // The generated PDF has no javascript: URI annotation either.
    const pdf = row.pdfData as Buffer;
    expect(pdf.toString('latin1')).not.toContain('javascript:');
  });

  it('re-sanitizes a protocol-relative //host href variable value in the executed snapshot', async () => {
    const hrefRenderData = authoredRenderData({ bodyHtml: '<p>See <a href="{{link}}">the portal</a></p>' });
    const hostileBlock = { id: 'cb1', blockType: 'contract', content: { variableValues: { link: '//evil.example' } } };
    await createExecutedDocuments(makeQuote(), 'acc1', ['contractA'], [hrefRenderData], [hostileBlock], EFFECTIVE);
    const row = insertedValues[0]!;
    expect(String(row.renderedHtml)).not.toContain('//evil.example');
    expect((row.pdfData as Buffer).toString('latin1')).not.toContain('//evil.example');
  });

  it('uploaded block stores the file bytes verbatim as the pdf with rendered_html null', async () => {
    const fileData = Buffer.from('%PDF-1.4 uploaded contract bytes');
    await createExecutedDocuments(
      makeQuote(), 'acc1', ['contractA'],
      [authoredRenderData({ blockId: 'cb2', sourceType: 'uploaded', bodyHtml: null, fileData })],
      [{ id: 'cb2', blockType: 'contract', content: {} }], EFFECTIVE,
    );
    const row = insertedValues[0]!;
    expect(row.renderedHtml).toBeNull();
    expect((row.pdfData as Buffer).equals(fileData)).toBe(true);
    expect(row.sha256).toBe(createHash('sha256').update(fileData).digest('hex'));
  });

  it('links contract_id to null when no billing contract was created', async () => {
    await createExecutedDocuments(makeQuote(), 'acc1', [], [authoredRenderData()], [authoredBlock], EFFECTIVE);
    expect(insertedValues[0]!.contractId).toBeNull();
  });

  it('inserts nothing when there is no contract render data', async () => {
    const ids = await createExecutedDocuments(makeQuote(), 'acc1', ['contractA'], [], [], EFFECTIVE);
    expect(ids).toEqual([]);
    expect(insertedValues).toHaveLength(0);
  });
});

describe('contractDocumentService.buildContractHashParts', () => {
  it('produces a hash part per render-data block with its version sha + resolved vars', () => {
    const parts = buildContractHashParts([authoredBlock], [authoredRenderData()], makeQuote(), EFFECTIVE);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.blockId).toBe('cb1');
    expect(parts[0]!.templateVersionSha256).toBe('a'.repeat(64));
    // Resolved variables fold in the accept-date effective value + quote-derived autos.
    expect(parts[0]!.resolvedVariables['client.name']).toBe('Acme Co');
    expect(parts[0]!.resolvedVariables['dates.effective']).toBeTruthy();
  });

  it('merges manual variableValues over auto values', () => {
    const block = { id: 'cb1', blockType: 'contract', content: { variableValues: { 'client.name': 'Override Inc' } } };
    const parts = buildContractHashParts([block], [authoredRenderData()], makeQuote(), EFFECTIVE);
    expect(parts[0]!.resolvedVariables['client.name']).toBe('Override Inc');
  });
});

describe('contractDocumentService.assertContractRenderDataComplete', () => {
  it('throws CONTRACT_RENDER_DATA_MISSING (500) when a contract block has no render data', () => {
    try {
      assertContractRenderDataComplete([authoredBlock], []);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(QuoteServiceError);
      expect((err as QuoteServiceError).status).toBe(500);
      expect((err as QuoteServiceError).code).toBe('CONTRACT_RENDER_DATA_MISSING');
    }
  });

  it('throws when renderData is undefined but a contract block exists', () => {
    expect(() => assertContractRenderDataComplete([authoredBlock], undefined)).toThrow(QuoteServiceError);
  });

  it('does not throw when every contract block has render data', () => {
    expect(() => assertContractRenderDataComplete([authoredBlock], [authoredRenderData()])).not.toThrow();
  });

  it('does not throw when there are no contract blocks', () => {
    expect(() => assertContractRenderDataComplete([{ id: 'b1', blockType: 'heading', content: {} }], undefined)).not.toThrow();
  });
});

describe('contractDocumentService.linkContractDocument', () => {
  beforeEach(() => { insertedValues.length = 0; selectResults.length = 0; vi.clearAllMocks(); });

  const auth = { canAccessOrg: () => true } as unknown as AuthContext;

  it('rejects re-linking a document that is already attached to a contract (409 ALREADY_LINKED)', async () => {
    // getDocumentOr404 select → a doc already linked to contract-existing.
    queueResult([{ id: 'doc1', orgId: 'org1', contractId: 'contract-existing', pdfData: Buffer.from('x'), mime: 'application/pdf', byteSize: 1, sha256: 's' }]);

    await expect(linkContractDocument(auth, 'doc1', 'contract-new'))
      .rejects.toMatchObject({ status: 409, code: 'ALREADY_LINKED' });
    // The guard fires before any UPDATE — nothing was re-filed.
    expect(insertedValues).toEqual([]);
  });

  it('links an unattached document (contract_id NULL) to a same-org contract', async () => {
    queueResult([{ id: 'doc1', orgId: 'org1', contractId: null, pdfData: Buffer.from('x'), mime: 'application/pdf', byteSize: 1, sha256: 's' }]); // getDocumentOr404
    queueResult([{ id: 'contract-new', orgId: 'org1' }]); // contract lookup (same org)
    queueResult([{ id: 'doc1', orgId: 'org1', contractId: 'contract-new' }]); // update ... returning

    const updated = await linkContractDocument(auth, 'doc1', 'contract-new');
    expect(updated.contractId).toBe('contract-new');
  });

  it('surfaces a ContractDocumentServiceError type on the already-linked guard', async () => {
    queueResult([{ id: 'doc1', orgId: 'org1', contractId: 'c', pdfData: Buffer.from('x'), mime: 'application/pdf', byteSize: 1, sha256: 's' }]);
    await expect(linkContractDocument(auth, 'doc1', 'c2')).rejects.toBeInstanceOf(ContractDocumentServiceError);
  });
});
