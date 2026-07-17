import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mirrors commandQueue.test.ts's mocking idiom: a passthrough default so most
// tests don't have to know the wrapper exists, with individual tests
// asserting on the vi.fn() call record where the wrapper usage itself is the
// thing under test (green-local/red-CI trap: an unmocked '../db' import here
// would pull in the real pg pool and either hang or throw on connect).
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  loadContractBlockRenderData,
  loadContractBlockAuthoring,
  resolveAutoVariables,
  substituteVariables,
  findUnresolvedVariables,
  renderContractBlocksForClient,
  loadContractPdfInputs,
  type ContractBlockRenderData,
  type QuoteRow,
} from './contractTemplateRender';

function selectReturning(rows: unknown[], onResolve?: () => void) {
  return {
    from: () => ({
      where: () => {
        onResolve?.();
        return Promise.resolve(rows);
      },
    }),
  };
}

// Variant whose `.where(...)` chains into `.orderBy(...)` — the latest-published
// query in loadContractBlockAuthoring orders desc by versionNumber.
function selectOrdered(rows: unknown[]) {
  return { from: () => ({ where: () => ({ orderBy: () => Promise.resolve(rows) }) }) };
}

// Full quotes row fixture — resolveAutoVariables takes the whole row (see
// contractTemplateRender.ts's QuoteRow comment), so every column needs a value.
function fixtureQuote(overrides: Partial<QuoteRow> = {}): QuoteRow {
  const base: QuoteRow = {
    id: 'quote-1',
    partnerId: 'partner-1',
    orgId: 'org-1',
    siteId: null,
    quoteNumber: 'Q-1001',
    title: 'Managed Services Proposal',
    status: 'draft',
    currencyCode: 'USD',
    issueDate: '2026-07-01',
    expiryDate: '2026-08-01',
    acceptedAt: null,
    declinedAt: null,
    convertedAt: null,
    subtotal: '810.00',
    taxRate: null,
    taxTotal: '0.00',
    total: '810.00',
    oneTimeTotal: '810.00',
    monthlyRecurringTotal: '0.00',
    annualRecurringTotal: '0.00',
    depositType: 'none',
    depositPercent: null,
    depositAmount: null,
    billToName: 'Acme Co',
    billToAddress: { line1: '1 Main St', line2: null, city: 'Springfield', region: 'IL', postalCode: '62701', country: 'USA' },
    billToTaxId: null,
    introNotes: null,
    terms: null,
    sellerSnapshot: { name: 'Breeze MSP', address: null, phone: null, email: null, website: null },
    coverPage: null,
    termsAndConditions: null,
    declineReason: null,
    convertedInvoiceId: null,
    pdfDocumentRef: null,
    pdfSha256: null,
    sentAt: null,
    firstViewedAt: null,
    viewedAt: null,
    createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
  return { ...base, ...overrides };
}

describe('substituteVariables', () => {
  it('HTML-escapes substituted values', () => {
    const { html, missing } = substituteVariables('<p>{{client.name}}</p>', {
      'client.name': '<b>Acme & Co</b>',
    });
    expect(html).toBe('<p>&lt;b&gt;Acme &amp; Co&lt;/b&gt;</p>');
    expect(missing).toEqual([]);
  });

  it('reports a missing manual variable and leaves its token in place', () => {
    const { html, missing } = substituteVariables('<p>Term: {{governing_state}}</p>', {});
    expect(html).toBe('<p>Term: {{governing_state}}</p>');
    expect(missing).toEqual(['governing_state']);
  });

  it('resolves known tokens while reporting unknown ones, in one pass', () => {
    const { html, missing } = substituteVariables('{{client.name}} / {{initial_term}}', {
      'client.name': 'Acme',
    });
    expect(html).toBe('Acme / {{initial_term}}');
    expect(missing).toEqual(['initial_term']);
  });

  it('does not double-report the same missing token repeated twice', () => {
    const { missing } = substituteVariables('{{x}} and {{x}} again', {});
    expect(missing).toEqual(['x']);
  });
});

describe('resolveAutoVariables', () => {
  it('formats money via the quotePdf money-formatting helper', () => {
    const values = resolveAutoVariables(fixtureQuote());
    expect(values['totals.one_time']).toBe('$810.00');
    expect(values['totals.monthly']).toBe('$0.00');
    expect(values['totals.annual']).toBe('$0.00');
    expect(values['totals.total']).toBe('$810.00');
  });

  it('resolves the non-money auto variables from the quote fixture', () => {
    const values = resolveAutoVariables(fixtureQuote());
    expect(values['client.name']).toBe('Acme Co');
    expect(values['client.address']).toBe('1 Main St, Springfield, IL, 62701, USA');
    expect(values['seller.name']).toBe('Breeze MSP');
    expect(values['quote.number']).toBe('Q-1001');
    expect(values['quote.title']).toBe('Managed Services Proposal');
  });

  it('defaults dates.effective to today and formats dates.expiry from the quote', () => {
    const values = resolveAutoVariables(fixtureQuote());
    expect(values['dates.expiry']).toBe('Aug 01, 2026');
    expect(values['dates.effective']).toMatch(/^[A-Z][a-z]{2} \d{2}, \d{4}$/);
  });

  it('honors an explicit effectiveDate override', () => {
    const values = resolveAutoVariables(fixtureQuote(), { effectiveDate: '2026-09-15' });
    expect(values['dates.effective']).toBe('Sep 15, 2026');
  });

  it('falls back to empty strings for null client/seller fields', () => {
    const values = resolveAutoVariables(fixtureQuote({ billToName: null, billToAddress: null, sellerSnapshot: null }));
    expect(values['client.name']).toBe('');
    expect(values['client.address']).toBe('');
    expect(values['seller.name']).toBe('');
  });
});

describe('findUnresolvedVariables', () => {
  const data: ContractBlockRenderData = {
    blockId: 'block-1',
    templateId: 'tmpl-1',
    templateVersionId: 'ver-1',
    sourceType: 'authored',
    bodyHtml: '<p>{{client.name}} agrees to {{governing_state}}</p>',
    fileData: null,
    versionSha256: 'sha',
    declaredVariables: [
      { name: 'client.name', kind: 'auto' },
      { name: 'governing_state', kind: 'manual' },
    ],
    templateName: 'MSA',
    versionNumber: 1,
  };

  it('reports only variables missing from their respective (auto/manual) source', () => {
    const unresolved = findUnresolvedVariables(data, {}, { 'client.name': 'Acme' });
    expect(unresolved).toEqual(['governing_state']);
  });

  it('returns empty when every declared variable has a value', () => {
    const unresolved = findUnresolvedVariables(data, { governing_state: 'Texas' }, { 'client.name': 'Acme' });
    expect(unresolved).toEqual([]);
  });

  it('an auto variable missing from autoValues is still reported even if present in variableValues', () => {
    const unresolved = findUnresolvedVariables(data, { 'client.name': 'stray manual entry' }, {});
    // 'client.name' is kind:'auto' so it's looked up in autoValues (empty here) —
    // its presence under the wrong key (variableValues) doesn't resolve it.
    // 'governing_state' is kind:'manual' and also absent from variableValues.
    expect(unresolved).toEqual(['client.name', 'governing_state']);
  });
});

describe('loadContractBlockRenderData', () => {
  beforeEach(() => {
    vi.mocked(withSystemDbAccessContext).mockClear();
    vi.mocked(runOutsideDbContext).mockClear();
    vi.mocked(db.select).mockReset();
  });

  const versionRow = {
    id: 'ver-1',
    templateId: 'tmpl-1',
    orgId: null,
    partnerId: 'partner-1',
    versionNumber: 2,
    status: 'published',
    sourceType: 'authored' as const,
    bodyHtml: '<p>Hello {{client.name}}</p>',
    fileData: null,
    mime: null,
    byteSize: null,
    sha256: 'abc123',
    declaredVariables: [{ name: 'client.name', kind: 'auto' }],
    publishedAt: new Date('2026-07-01T00:00:00Z'),
    createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };
  const templateRow = {
    id: 'tmpl-1',
    orgId: null,
    partnerId: 'partner-1',
    name: 'MSA',
    description: null,
    status: 'active',
    createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };

  const contractBlock = {
    id: 'block-1',
    blockType: 'contract',
    content: { templateId: 'tmpl-1', templateVersionId: 'ver-1', variableValues: {} },
  };

  it('wraps reads in withSystemDbAccessContext (partner-owned template rows are invisible to org-scoped RLS)', async () => {
    const callOrder: string[] = [];
    vi.mocked(runOutsideDbContext).mockImplementationOnce(async (fn: () => unknown) => {
      callOrder.push('enter-outside');
      const result = await fn();
      callOrder.push('exit-outside');
      return result;
    });
    vi.mocked(withSystemDbAccessContext).mockImplementationOnce(async (fn: () => unknown) => {
      callOrder.push('enter-system');
      const result = await fn();
      callOrder.push('exit-system');
      return result;
    });
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([versionRow], () => callOrder.push('versions-select')) as never)
      .mockReturnValueOnce(selectReturning([templateRow], () => callOrder.push('templates-select')) as never);

    const result = await loadContractBlockRenderData([contractBlock]);

    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
    // Both reads must fire between enter-system/exit-system, not before
    // enter-outside — proves the DB calls are actually inside the wrapper,
    // not just that the wrapper was called somewhere unrelated (this exact
    // pattern has gone green-local/red-CI before when the wrapper was
    // mocked as a bare no-op instead of asserted on).
    expect(callOrder).toEqual([
      'enter-outside',
      'enter-system',
      'versions-select',
      'templates-select',
      'exit-system',
      'exit-outside',
    ]);
    expect(result).toHaveLength(1);
  });

  it('returns render data for an authored contract block, re-sanitized and mapped from the version/template rows', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([versionRow]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    const [data] = await loadContractBlockRenderData([contractBlock]);

    expect(data).toEqual<ContractBlockRenderData>({
      blockId: 'block-1',
      templateId: 'tmpl-1',
      templateVersionId: 'ver-1',
      sourceType: 'authored',
      bodyHtml: '<p>Hello {{client.name}}</p>',
      fileData: null,
      versionSha256: 'abc123',
      declaredVariables: [{ name: 'client.name', kind: 'auto' }],
      templateName: 'MSA',
      versionNumber: 2,
    });
  });

  it('ignores non-contract blocks and short-circuits without touching the db', async () => {
    const result = await loadContractBlockRenderData([
      { id: 'block-2', blockType: 'heading', content: { text: 'Intro', level: 2 } },
    ]);
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it('throws when a block references a version that no longer resolves', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([]) as never)
      .mockReturnValueOnce(selectReturning([]) as never);

    await expect(loadContractBlockRenderData([contractBlock])).rejects.toThrow(/missing or mismatched/);
  });

  it('omits an uploaded version fileData by default and returns it only when includeFileData is set', async () => {
    const uploadedVersion = {
      ...versionRow, id: 'ver-1', sourceType: 'uploaded' as const, bodyHtml: null,
      fileData: Buffer.from('%PDF-1.4 stored bytes'),
    };
    const uploadedBlock = { id: 'block-1', blockType: 'contract', content: { templateId: 'tmpl-1', templateVersionId: 'ver-1' } };

    // Default: file_data is left out of the projection, so the result carries null.
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([uploadedVersion]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);
    const [dflt] = await loadContractBlockRenderData([uploadedBlock]);
    expect(dflt!.fileData).toBeNull();

    // includeFileData: true → the stored bytes are returned for merge/stream/snapshot.
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([uploadedVersion]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);
    const [withData] = await loadContractBlockRenderData([uploadedBlock], { includeFileData: true });
    expect(withData!.fileData).toEqual(uploadedVersion.fileData);
  });
});

describe('renderContractBlocksForClient', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  const authoredVersionRow = {
    id: 'ver-1',
    templateId: 'tmpl-1',
    orgId: null,
    partnerId: 'partner-1',
    versionNumber: 3,
    status: 'published',
    sourceType: 'authored' as const,
    bodyHtml: '<p>{{client.name}} agrees to {{governing_state}}</p>',
    fileData: null,
    mime: null,
    byteSize: null,
    sha256: 'abc123',
    declaredVariables: [
      { name: 'client.name', kind: 'auto' },
      { name: 'governing_state', kind: 'manual' },
    ],
    publishedAt: new Date('2026-07-01T00:00:00Z'),
    createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };
  const uploadedVersionRow = {
    ...authoredVersionRow,
    id: 'ver-2',
    sourceType: 'uploaded' as const,
    bodyHtml: null,
    fileData: Buffer.from('%PDF-1.4 fake'),
    mime: 'application/pdf',
  };
  const templateRow = {
    id: 'tmpl-1',
    orgId: null,
    partnerId: 'partner-1',
    name: 'MSA',
    description: null,
    status: 'active',
    createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
  };

  function contractBlockFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: 'block-1',
      blockType: 'contract',
      content: { templateId: 'tmpl-1', templateVersionId: 'ver-1', variableValues: { governing_state: 'Texas' }, ...overrides },
    };
  }

  it('resolves an authored block to renderedHtml containing the substituted client name, with no template ids leaking', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([authoredVersionRow]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    const [block] = await renderContractBlocksForClient(
      [contractBlockFixture()],
      fixtureQuote({ billToName: 'Acme Co' }),
      (blockId) => `/portal/quotes/quote-1/contract-file/${blockId}`
    );

    const content = block!.content as Record<string, unknown>;
    expect(content.renderedHtml).toContain('Acme Co');
    expect(content.renderedHtml).toContain('Texas');
    expect(content.sourceType).toBe('authored');
    expect(content.fileUrl).toBeNull();
    expect(content.templateName).toBe('MSA');
    expect(content.versionNumber).toBe(3);
    expect(content).not.toHaveProperty('templateId');
    expect(content).not.toHaveProperty('templateVersionId');
    expect(content).not.toHaveProperty('variableValues');
    expect(JSON.stringify(content)).not.toContain('{{');
  });

  it('defensively blanks an unresolved variable at render time instead of leaking a raw {{token}}', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([authoredVersionRow]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    const [block] = await renderContractBlocksForClient(
      [contractBlockFixture({ variableValues: {} })], // governing_state left unresolved
      fixtureQuote({ billToName: 'Acme Co' }),
      () => '/unused'
    );

    const content = block!.content as Record<string, unknown>;
    expect(content.renderedHtml).toContain('Acme Co');
    expect(content.renderedHtml).not.toContain('{{');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('unresolved variable'),
      expect.objectContaining({ missing: ['governing_state'] })
    );
    consoleErrorSpy.mockRestore();
  });

  it('pins {{dates.effective}} to the accept date for an accepted quote (not the viewing date)', async () => {
    const effectiveVersion = {
      ...authoredVersionRow,
      bodyHtml: '<p>Effective {{dates.effective}}</p>',
      declaredVariables: [{ name: 'dates.effective', kind: 'auto' }],
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([effectiveVersion]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    const [block] = await renderContractBlocksForClient(
      [contractBlockFixture({ variableValues: {} })],
      fixtureQuote({ status: 'accepted', acceptedAt: new Date('2026-05-01T12:00:00Z') }),
      () => '/unused',
    );
    const html = (block!.content as Record<string, unknown>).renderedHtml as string;
    expect(html).toContain('May 01, 2026'); // the accept date, not "today"
  });

  it('resolves an uploaded block to a null renderedHtml and a caller-built fileUrl', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([uploadedVersionRow]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    const [block] = await renderContractBlocksForClient(
      [contractBlockFixture({ templateVersionId: 'ver-2' })],
      fixtureQuote(),
      (blockId) => `/portal/quotes/quote-1/contract-file/${blockId}`
    );

    const content = block!.content as Record<string, unknown>;
    expect(content.sourceType).toBe('uploaded');
    expect(content.renderedHtml).toBeNull();
    expect(content.fileUrl).toBe('/portal/quotes/quote-1/contract-file/block-1');
  });

  it('preserves an optional label when present and omits it when absent', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([authoredVersionRow]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    const [block] = await renderContractBlocksForClient(
      [contractBlockFixture({ label: 'Master Services Agreement' })],
      fixtureQuote(),
      () => '/unused'
    );
    expect((block!.content as Record<string, unknown>).label).toBe('Master Services Agreement');
  });

  it('leaves non-contract blocks unchanged and short-circuits without touching the db', async () => {
    const blocks = [{ id: 'block-2', blockType: 'heading', content: { text: 'Intro', level: 2 } }];
    const result = await renderContractBlocksForClient(blocks, fixtureQuote(), () => '/unused');
    expect(result).toEqual(blocks);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('stored-XSS: substituted href re-sanitized at every served/PDF surface', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  // A template whose sanitized body embeds a variable INSIDE an href — this is a
  // legal write-time shape (`{{link}}` is a scheme-less relative href, so the
  // write-time sanitizer keeps it). The XSS lands only once a hostile value is
  // substituted in, AFTER write-time sanitization — so the final substituted
  // HTML must be re-sanitized before it reaches any served/PDF surface.
  const hrefVersionRow = {
    id: 'ver-x',
    templateId: 'tmpl-1',
    orgId: null,
    partnerId: 'partner-1',
    versionNumber: 1,
    status: 'published',
    sourceType: 'authored' as const,
    bodyHtml: '<p>See <a href="{{link}}">the portal</a></p>',
    fileData: null,
    mime: null,
    byteSize: null,
    sha256: 'abc123',
    declaredVariables: [{ name: 'link', kind: 'manual' }],
    publishedAt: new Date('2026-07-01T00:00:00Z'),
    createdBy: 'user-1',
    createdAt: new Date('2026-07-01T00:00:00Z'),
  };
  const templateRow = {
    id: 'tmpl-1', orgId: null, partnerId: 'partner-1', name: 'MSA', description: null,
    status: 'active', createdBy: 'user-1', createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
  const hostileBlock = {
    id: 'block-x',
    blockType: 'contract',
    content: { templateId: 'tmpl-1', templateVersionId: 'ver-x', variableValues: { link: 'javascript:alert(1)' } },
  };

  it('renderContractBlocksForClient strips a javascript: value substituted into an href', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([hrefVersionRow]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    const [block] = await renderContractBlocksForClient([hostileBlock], fixtureQuote(), () => '/unused');
    const html = (block!.content as Record<string, unknown>).renderedHtml as string;
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('href="javascript');
    // The link element survives but with no live href (bare <a>), text preserved.
    expect(html).toContain('the portal');
  });

  it('loadContractPdfInputs strips a javascript: value substituted into an href', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([hrefVersionRow]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    const { contractRenderData } = await loadContractPdfInputs([hostileBlock], fixtureQuote());
    const html = contractRenderData.get('block-x')!.html!;
    expect(html).not.toContain('javascript:');
    expect(html).toContain('the portal');
  });

  it('a protocol-relative //host value substituted into an href is stripped too', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([hrefVersionRow]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    const [block] = await renderContractBlocksForClient(
      [{ ...hostileBlock, content: { ...hostileBlock.content, variableValues: { link: '//evil.example' } } }],
      fixtureQuote(),
      () => '/unused',
    );
    const html = (block!.content as Record<string, unknown>).renderedHtml as string;
    expect(html).not.toContain('//evil.example');
    expect(html).toContain('the portal');
  });
});

describe('loadContractPdfInputs (uploaded block with no stored bytes)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  const templateRow = {
    id: 'tmpl-1', orgId: null, partnerId: 'partner-1', name: 'MSA', description: null,
    status: 'active', createdBy: 'user-1', createdAt: new Date('2026-07-01T00:00:00Z'), updatedAt: new Date('2026-07-01T00:00:00Z'),
  };
  const uploadedVersionRowNoBytes = {
    id: 'ver-2', templateId: 'tmpl-1', orgId: null, partnerId: 'partner-1', versionNumber: 1, status: 'published',
    sourceType: 'uploaded' as const, bodyHtml: null, fileData: null, mime: 'application/pdf', byteSize: null, sha256: 'abc123',
    declaredVariables: [], publishedAt: new Date('2026-07-01T00:00:00Z'), createdBy: 'user-1', createdAt: new Date('2026-07-01T00:00:00Z'),
  };
  const uploadedBlock = {
    id: 'block-1', blockType: 'contract', content: { templateId: 'tmpl-1', templateVersionId: 'ver-2' },
  };

  it('throws CONTRACT_RENDER_DATA_MISSING (500) instead of silently omitting the upload', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([uploadedVersionRowNoBytes]) as never)
      .mockReturnValueOnce(selectReturning([templateRow]) as never);

    await expect(loadContractPdfInputs([uploadedBlock], fixtureQuote())).rejects.toMatchObject({
      status: 500,
      code: 'CONTRACT_RENDER_DATA_MISSING',
    });
  });
});

describe('loadContractBlockAuthoring (admin-only editor fields)', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    vi.mocked(withSystemDbAccessContext).mockClear();
  });

  const contractBlock = {
    id: 'blk-1',
    blockType: 'contract',
    content: { templateId: 'tpl-1', templateVersionId: 'ver-1', variableValues: { initial_term: '12 months' } },
  };
  const pinnedVersionRow = {
    id: 'ver-1', templateId: 'tpl-1', versionNumber: 1, status: 'published',
    declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'initial_term', kind: 'manual' }],
  };

  it('returns raw authoring fields + the latest published version as the nudge target', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([pinnedVersionRow]) as never) // pinned versions
      .mockReturnValueOnce(selectOrdered([ // published versions, desc versionNumber
        { id: 'ver-2', templateId: 'tpl-1', versionNumber: 2 },
        { id: 'ver-1', templateId: 'tpl-1', versionNumber: 1 },
      ]) as never);

    const map = await loadContractBlockAuthoring([contractBlock]);
    expect(map.get('blk-1')).toEqual({
      templateId: 'tpl-1',
      templateVersionId: 'ver-1',
      variableValues: { initial_term: '12 months' },
      declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'initial_term', kind: 'manual' }],
      latestPublishedVersionId: 'ver-2',
      latestPublishedVersionNumber: 2,
    });
  });

  it('reports no nudge target (null) when the pinned version is already the latest published', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectReturning([pinnedVersionRow]) as never)
      .mockReturnValueOnce(selectOrdered([{ id: 'ver-1', templateId: 'tpl-1', versionNumber: 1 }]) as never);

    const map = await loadContractBlockAuthoring([contractBlock]);
    const a = map.get('blk-1')!;
    // The editor compares versionNumber (1) against latestPublishedVersionNumber
    // (1) → no "Update to vN". latestPublishedVersionId still points at the pin.
    expect(a.latestPublishedVersionNumber).toBe(1);
    expect(a.latestPublishedVersionId).toBe('ver-1');
  });

  it('returns an empty map (no DB read) when there are no contract blocks', async () => {
    const map = await loadContractBlockAuthoring([{ id: 'h1', blockType: 'heading', content: { text: 'x' } }]);
    expect(map.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
