import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// Controllable Drizzle chain (contractDocumentService.test.ts idiom): every
// builder method returns the chain; awaiting a select shifts the next queued
// result; every insert's `.values(...)` payload is recorded, and its
// `.returning()` resolves to the next queued result.
const queued: unknown[][] = [];
const inserted: Array<Record<string, unknown>> = [];
function queue(rows: unknown[]) { queued.push(rows); }

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn((v: Record<string, unknown>) => { inserted.push(v); return chain; });
  chain.returning = vi.fn(() => Promise.resolve(queued.shift() ?? []));
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(queued.shift() ?? []).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

const assertTemplateVersionUsableMock = vi.fn();
vi.mock('./contractTemplateService', async (importActual) => ({
  ...(await importActual<typeof import('./contractTemplateService')>()),
  assertTemplateVersionUsable: (...args: unknown[]) => assertTemplateVersionUsableMock(...args),
}));

const freezeMock = vi.fn();
vi.mock('./contractDocumentService', async (importActual) => ({
  ...(await importActual<typeof import('./contractDocumentService')>()),
  freezeSignedAgreement: (...args: unknown[]) => freezeMock(...args),
}));

import { db } from '../db';
import {
  recordSignedAgreement,
  AgreementRequestServiceError,
  type RecordSignedAgreementParams,
} from './agreementRequestService';
import { ContractTemplateServiceError } from './contractTemplateService';
import { computeAgreementSha256 } from './agreementContentHash';
import type { TemplateVersionRenderData } from './contractTemplateRender';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VERSION = '22222222-2222-4222-8222-222222222222';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const CONTRACT = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-18T12:00:00.000Z');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('scan-bytes')]);

function renderData(over: Partial<TemplateVersionRenderData> = {}): TemplateVersionRenderData {
  return {
    templateId: TEMPLATE,
    templateVersionId: VERSION,
    sourceType: 'authored',
    bodyHtml: '<p>{{client.name}} PO {{custom.po}}</p>',
    fileData: null,
    versionSha256: 'vsha',
    declaredVariables: [{ name: 'client.name', kind: 'auto' }, { name: 'custom.po', kind: 'manual' }] as TemplateVersionRenderData['declaredVariables'],
    templateName: 'MSA',
    versionNumber: 1,
    ...over,
  };
}

function params(over: Partial<RecordSignedAgreementParams> = {}, input: Partial<RecordSignedAgreementParams['input']> = {}): RecordSignedAgreementParams {
  return {
    input: {
      orgId: ORG,
      templateVersionId: VERSION,
      contractId: null,
      label: 'MSA 2026',
      variableValues: { 'custom.po': 'PO-4471' },
      signerName: 'Jane Doe',
      signerEmail: 'jane@example.com',
      signedAt: new Date('2026-10-01T15:00:00.000Z'),
      effectiveDate: null,
      method: 'email',
      reference: 'email from Jane 2026-10-01',
      ...input,
    },
    renderData: renderData(),
    callerPartnerId: PARTNER,
    actorUserId: 'user-1',
    actorIp: '203.0.113.9',
    actorUserAgent: 'UA/1.0',
    file: null,
    now: NOW,
    ...over,
  };
}

const orgRow = {
  id: ORG, name: 'Acme', partnerId: PARTNER,
  billingAddressLine1: '1 Main St', billingAddressLine2: null, billingAddressCity: 'Springfield',
  billingAddressRegion: 'IL', billingAddressPostalCode: '62701', billingAddressCountry: 'US',
};
const partnerRow = { id: PARTNER, name: 'Best MSP', settings: {} };
const requestRow = { id: 'req-1', orgId: ORG, status: 'signed', acceptTokenJti: null };

/** Queue the reads + returning() of a successful run, in call order. */
function queueHappy(opts: { contract?: unknown[] } = {}) {
  queue([orgRow]);
  if (opts.contract) queue(opts.contract);
  queue([partnerRow]);
  queue([requestRow]);
}

beforeEach(() => {
  queued.length = 0;
  inserted.length = 0;
  vi.mocked(db.insert).mockClear();
  assertTemplateVersionUsableMock.mockReset().mockResolvedValue(undefined);
  freezeMock.mockReset().mockResolvedValue({ id: 'sa-1', sha256: 'pdfsha' });
});

describe('recordSignedAgreement — refusals write nothing', () => {
  it('signedAt 10 minutes ahead → 400 SIGNED_AT_IN_FUTURE before any read or insert', async () => {
    queueHappy();
    const p = params({}, { signedAt: new Date(NOW.getTime() + 10 * 60 * 1000) });
    await expect(recordSignedAgreement(p)).rejects.toMatchObject({ status: 400, code: 'SIGNED_AT_IN_FUTURE' });
    expect(db.insert).not.toHaveBeenCalled();
    expect(freezeMock).not.toHaveBeenCalled();
  });

  it('signedAt within the 5-minute skew is accepted', async () => {
    queueHappy();
    const p = params({}, { signedAt: new Date(NOW.getTime() + 4 * 60 * 1000) });
    await expect(recordSignedAgreement(p)).resolves.toMatchObject({ signedAgreementId: 'sa-1' });
  });

  it('blank signer name → 400 INVALID_SIGNER_NAME', async () => {
    queueHappy();
    await expect(recordSignedAgreement(params({}, { signerName: '   ' }))).rejects.toMatchObject({ status: 400, code: 'INVALID_SIGNER_NAME' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('render data for a different version than the input → 500, never freezes the wrong template', async () => {
    queueHappy();
    const p = params({ renderData: renderData({ templateVersionId: 'other-version' }) });
    await expect(recordSignedAgreement(p)).rejects.toMatchObject({ status: 500 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('org missing → 404 ORG_NOT_FOUND', async () => {
    queue([]);
    await expect(recordSignedAgreement(params())).rejects.toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('org belongs to another partner than the caller → the SAME 404 ORG_NOT_FOUND', async () => {
    queue([{ ...orgRow, partnerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);
    await expect(recordSignedAgreement(params())).rejects.toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('template guard rejection propagates unchanged (ContractTemplateServiceError)', async () => {
    queueHappy();
    const guardErr = new ContractTemplateServiceError('archived', 422, 'TEMPLATE_ARCHIVED');
    assertTemplateVersionUsableMock.mockRejectedValueOnce(guardErr);
    await expect(recordSignedAgreement(params())).rejects.toBe(guardErr);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('template guard is checked against the ORG\'s partner, explicitly, with the input ids', async () => {
    queueHappy();
    await recordSignedAgreement(params({ callerPartnerId: null }));
    expect(assertTemplateVersionUsableMock).toHaveBeenCalledWith(
      { templateId: TEMPLATE, templateVersionId: VERSION },
      { orgId: ORG, partnerId: PARTNER },
    );
  });

  it('contract from another org → 404 CONTRACT_NOT_FOUND, no insert', async () => {
    queueHappy({ contract: [{ id: CONTRACT, orgId: OTHER_ORG }] });
    await expect(recordSignedAgreement(params({}, { contractId: CONTRACT }))).rejects.toMatchObject({ status: 404, code: 'CONTRACT_NOT_FOUND' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('missing contract → the SAME 404 CONTRACT_NOT_FOUND (non-oracular)', async () => {
    queueHappy({ contract: [] });
    const err = await recordSignedAgreement(params({}, { contractId: CONTRACT })).catch((e) => e);
    expect(err).toBeInstanceOf(AgreementRequestServiceError);
    expect(err).toMatchObject({ status: 404, code: 'CONTRACT_NOT_FOUND' });
    expect(err.message).toBe('Contract not found');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('template declaring totals.monthly → 422 AGREEMENT_VARIABLES_UNRESOLVED naming it, no insert', async () => {
    queueHappy();
    const p = params({
      renderData: renderData({
        bodyHtml: '<p>{{totals.monthly}}</p>',
        declaredVariables: [{ name: 'totals.monthly', kind: 'auto' }] as TemplateVersionRenderData['declaredVariables'],
      }),
    });
    const err = await recordSignedAgreement(p).catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'AGREEMENT_VARIABLES_UNRESOLVED' });
    expect(err.message).toBe('Agreement variables unresolved: totals.monthly');
    expect(db.insert).not.toHaveBeenCalled();
    expect(freezeMock).not.toHaveBeenCalled();
  });

  it('missing manual variable → 422 listing every unresolved name sorted', async () => {
    queueHappy();
    const p = params({
      renderData: renderData({
        declaredVariables: [
          { name: 'custom.zeta', kind: 'manual' }, { name: 'custom.po', kind: 'manual' },
        ] as TemplateVersionRenderData['declaredVariables'],
      }),
    }, { variableValues: {} });
    const err = await recordSignedAgreement(p).catch((e) => e);
    expect(err.message).toBe('Agreement variables unresolved: custom.po, custom.zeta');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('empty file → 400 EMPTY_FILE', async () => {
    queueHappy();
    await expect(recordSignedAgreement(params({ file: { buffer: Buffer.alloc(0), filename: 'x.pdf' } })))
      .rejects.toMatchObject({ status: 400, code: 'EMPTY_FILE' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('non-image/pdf bytes → 415 UNSUPPORTED_FILE_TYPE', async () => {
    queueHappy();
    await expect(recordSignedAgreement(params({ file: { buffer: Buffer.from('MZ\x90\x00 not a scan'), filename: 'x.exe' } })))
      .rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_FILE_TYPE' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('11 MB PNG → 413 FILE_TOO_LARGE', async () => {
    queueHappy();
    const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
    await expect(recordSignedAgreement(params({ file: { buffer: big, filename: 'x.png' } })))
      .rejects.toMatchObject({ status: 413, code: 'FILE_TOO_LARGE' });
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('recordSignedAgreement — happy paths', () => {
  it('rendered: inserts a signed request with snapshots and freezes it with on-behalf evidence', async () => {
    queueHappy();
    const res = await recordSignedAgreement(params());

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      status: 'signed',
      orgId: ORG,
      templateId: TEMPLATE,
      templateVersionId: VERSION,
      contractId: null,
      label: 'MSA 2026',
      variableValues: { 'custom.po': 'PO-4471' },
      clientNameSnapshot: 'Acme',
      clientAddressSnapshot: expect.objectContaining({ line1: '1 Main St', city: 'Springfield' }),
      sellerSnapshot: expect.objectContaining({ name: 'Best MSP' }),
      renderLocale: 'en',
      effectiveDate: '2026-10-01',
      createdBy: 'user-1',
    });
    const signedAt = new Date('2026-10-01T15:00:00.000Z');
    expect(inserted[0]!.signedAt).toEqual(signedAt);
    // A signed request has no live link: it "expires" the moment it was signed.
    expect(inserted[0]!.expiresAt).toEqual(signedAt);

    expect(freezeMock).toHaveBeenCalledTimes(1);
    const freezeArg = freezeMock.mock.calls[0]![0];
    expect(freezeArg).toMatchObject({
      source: { kind: 'request', agreementRequestId: 'req-1', label: 'MSA 2026' },
      orgId: ORG,
      contractId: null,
      templateId: TEMPLATE,
      templateVersionId: VERSION,
      allowUnresolvedFallback: false,
      manualValues: { 'custom.po': 'PO-4471' },
      evidence: {
        signerName: 'Jane Doe',
        signerEmail: 'jane@example.com',
        signedAt,
        // The TECH's IP / UA — this is an MSP-recorded acceptance.
        signerIp: '203.0.113.9',
        signerUserAgent: 'UA/1.0',
        acceptanceOrigin: 'on_behalf',
        acceptanceMethod: 'email',
        acceptanceReference: 'email from Jane 2026-10-01',
        recordedByUserId: 'user-1',
        contentHashVersion: 1,
        acceptanceRenderLocale: 'en',
      },
    });
    expect(freezeArg.externalBytes).toBeUndefined();
    expect(freezeArg.ctx).toMatchObject({ clientName: 'Acme', sellerName: 'Best MSP', renderLocale: 'en', effectiveDate: '2026-10-01' });
    expect(freezeArg.ctx.quote).toBeUndefined();

    const expectedHash = computeAgreementSha256({
      kind: 'rendered',
      versionSha: 'vsha',
      vars: {
        'client.name': 'Acme',
        'client.address': '1 Main St, Springfield, IL, 62701, US',
        'seller.name': 'Best MSP',
        'dates.effective': 'Oct 01, 2026',
        'custom.po': 'PO-4471',
      },
      renderLocale: 'en',
      effectiveDate: '2026-10-01',
    });
    expect(freezeArg.evidence.contentSha256).toBe(expectedHash);
    expect(res).toEqual({ request: requestRow, signedAgreementId: 'sa-1', contentSha256: expectedHash });
  });

  it('a sender-set effectiveDate is used for the context, the hash and the stored row', async () => {
    queueHappy();
    await recordSignedAgreement(params({}, { effectiveDate: '2026-11-01' }));
    expect(inserted[0]).toMatchObject({ effectiveDate: '2026-11-01' });
    expect(freezeMock.mock.calls[0]![0].ctx.effectiveDate).toBe('2026-11-01');
  });

  it('manual values cannot override auto variables or smuggle undeclared keys', async () => {
    queueHappy();
    await recordSignedAgreement(params({}, { variableValues: { 'custom.po': 'PO-1', 'client.name': 'Evil Corp', 'stray.key': 'x' } }));
    expect(inserted[0]!.variableValues).toEqual({ 'custom.po': 'PO-1' });
    expect(freezeMock.mock.calls[0]![0].manualValues).toEqual({ 'custom.po': 'PO-1' });
  });

  it('contract in the same org is linked on the request and the signed agreement', async () => {
    queueHappy({ contract: [{ id: CONTRACT, orgId: ORG }] });
    await recordSignedAgreement(params({}, { contractId: CONTRACT }));
    expect(inserted[0]).toMatchObject({ contractId: CONTRACT });
    expect(freezeMock.mock.calls[0]![0]).toMatchObject({ contractId: CONTRACT });
  });

  it('external PNG: freezes the bytes verbatim and binds them in content_sha256', async () => {
    queueHappy();
    // A scanned copy is the record: manual variables are not required for it.
    const res = await recordSignedAgreement(params({ file: { buffer: PNG, filename: 'scan.png' } }, { variableValues: {} }));
    const freezeArg = freezeMock.mock.calls[0]![0];
    expect(freezeArg.externalBytes).toEqual({ data: PNG, mime: 'image/png' });
    const expected = computeAgreementSha256({
      kind: 'external',
      versionSha: 'vsha',
      bytesSha256: createHash('sha256').update(PNG).digest('hex'),
      mime: 'image/png',
    });
    expect(freezeArg.evidence.contentSha256).toBe(expected);
    expect(res.contentSha256).toBe(expected);
  });

  it('a partner document language becomes the render locale', async () => {
    queue([orgRow]);
    queue([{ ...partnerRow, settings: { language: 'de-DE' } }]);
    queue([requestRow]);
    await recordSignedAgreement(params());
    expect(inserted[0]).toMatchObject({ renderLocale: 'de-DE' });
    expect(freezeMock.mock.calls[0]![0].evidence.acceptanceRenderLocale).toBe('de-DE');
  });

  it('a freeze failure propagates (the caller tx rolls the request insert back)', async () => {
    queueHappy();
    freezeMock.mockRejectedValueOnce(Object.assign(new Error('Agreement variables unresolved: x'), { status: 422, code: 'AGREEMENT_VARIABLES_UNRESOLVED' }));
    await expect(recordSignedAgreement(params())).rejects.toMatchObject({ status: 422 });
  });
});
