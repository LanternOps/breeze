import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { AuthContext } from '../middleware/auth';

/** A genuinely loadable minimal PDF (pdf-lib can create these). Uploaded contract
 *  PDFs are now validated with PDFDocument.load at write time, so the happy-path
 *  fixtures must be real PDFs, not `%PDF-…%%EOF` stubs. */
async function validPdfBytes(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** A minimal ENCRYPTED PDF. pdf-lib cannot CREATE encrypted PDFs, so we hand-build
 *  the bytes: a valid object graph plus a trailer that references a /Standard
 *  security-handler /Encrypt dictionary (V1/R2). pdf-lib detects the /Encrypt
 *  trailer entry on load and refuses it (EncryptedPDFError) — exactly the
 *  qpdf-encrypted-upload case. Provenance: constructed here rather than checked
 *  in as a binary blob so the structure is auditable. */
function encryptedPdfBytes(): Buffer {
  const objs: Record<number, string> = {
    1: '<< /Type /Catalog /Pages 2 0 R >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    4: '<< /Filter /Standard /V 1 /R 2 /O <0123456789ABCDEF0123456789ABCDEF> /U <0123456789ABCDEF0123456789ABCDEF> /P -44 >>',
  };
  let body = '%PDF-1.4\n';
  const offsets: Record<number, number> = {};
  for (let i = 1; i <= 4; i++) {
    offsets[i] = Buffer.byteLength(body, 'latin1');
    body += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(body, 'latin1');
  let xref = 'xref\n0 5\n0000000000 65535 f \n';
  for (let i = 1; i <= 4; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  body += xref;
  body += 'trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>] >>\n';
  body += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

// Controllable Drizzle chain mock (same pattern as quoteService.test.ts /
// invoiceService.test.ts): every builder method returns the same chain; a
// query resolves when awaited (the chain is a thenable that yields the next
// queued result). Tests queue the rows each db call should resolve to, in
// call order.
const results: unknown[][] = [];
function queueResult(rows: unknown[]) {
  results.push(rows);
}

vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete'];
    for (const m of methods) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = results.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    return chain;
  };
  const db = makeChain();
  return { db };
});

import * as svc from './contractTemplateService';
import { db } from '../db';
import { PartnerWideWriteDeniedError } from './partnerWideAccess';

type Chain = {
  values: { mock: { calls: unknown[][] } };
  set: { mock: { calls: unknown[][] } };
};
const chain = db as unknown as Chain;

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'User One', isPlatformAdmin: false },
    token: {} as never,
    partnerId: 'partner-1',
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: null,
    partnerOrgAccess: 'all',
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...overrides,
  } as AuthContext;
}

const ORG_TEMPLATE = {
  id: 'tmpl-org-1',
  orgId: 'org-1',
  partnerId: null,
  name: 'Org Template',
  description: null,
  status: 'active',
  createdBy: 'user-1',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const PARTNER_TEMPLATE = {
  id: 'tmpl-partner-1',
  orgId: null,
  partnerId: 'partner-1',
  name: 'Partner-Wide Template',
  description: null,
  status: 'active',
  createdBy: 'user-1',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

const ARCHIVED_ORG_TEMPLATE = { ...ORG_TEMPLATE, id: 'tmpl-org-archived', status: 'archived' };

beforeEach(() => {
  results.length = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// createTemplate — partner-wide + org-scoped gating
// ---------------------------------------------------------------------------

describe('createTemplate', () => {
  it('rejects a partner-wide create when the caller lacks canManagePartnerWidePolicies', async () => {
    const auth = makeAuth({ scope: 'partner', partnerId: 'partner-1', partnerOrgAccess: 'selected' });
    await expect(
      svc.createTemplate(auth, { ownerScope: 'partner', name: 'Wide' } as never)
    ).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a partner-wide create when the caller has no partner scope at all', async () => {
    const auth = makeAuth({ scope: 'organization', partnerId: null, partnerOrgAccess: undefined });
    await expect(
      svc.createTemplate(auth, { ownerScope: 'partner', name: 'Wide' } as never)
    ).rejects.toMatchObject({ status: 403, code: 'PARTNER_SCOPE_REQUIRED' });
  });

  it('creates a partner-wide template when the caller has canManagePartnerWidePolicies', async () => {
    const auth = makeAuth({ scope: 'partner', partnerId: 'partner-1', partnerOrgAccess: 'all' });
    queueResult([PARTNER_TEMPLATE]); // insert().returning()
    const row = await svc.createTemplate(auth, { ownerScope: 'partner', name: 'Wide' } as never);
    expect(row.id).toBe('tmpl-partner-1');
    expect(chain.values.mock.calls[0]![0]).toMatchObject({ orgId: null, partnerId: 'partner-1', name: 'Wide' });
  });

  it('rejects an org-scoped create when the org is outside the caller\'s access', async () => {
    const auth = makeAuth({ scope: 'organization', partnerId: 'partner-1', canAccessOrg: () => false });
    await expect(
      svc.createTemplate(auth, { ownerScope: 'organization', orgId: 'org-1', name: 'Mine' } as never)
    ).rejects.toMatchObject({ status: 403, code: 'ORG_DENIED' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('creates an org-owned template when the org is within the caller\'s access', async () => {
    const auth = makeAuth({ scope: 'organization', partnerId: 'partner-1', canAccessOrg: (id) => id === 'org-1' });
    queueResult([ORG_TEMPLATE]);
    const row = await svc.createTemplate(auth, { ownerScope: 'organization', orgId: 'org-1', name: 'Mine' } as never);
    expect(row.id).toBe('tmpl-org-1');
    expect(chain.values.mock.calls[0]![0]).toMatchObject({ orgId: 'org-1', partnerId: null, name: 'Mine' });
  });
});

// ---------------------------------------------------------------------------
// updateTemplate / archiveTemplate — partner-wide + org-scoped gating
// ---------------------------------------------------------------------------

describe('updateTemplate', () => {
  it('rejects updating a partner-wide template without canManagePartnerWidePolicies', async () => {
    const auth = makeAuth({ scope: 'partner', partnerId: 'partner-1', partnerOrgAccess: 'selected' });
    queueResult([PARTNER_TEMPLATE]); // getTemplateOr404
    await expect(svc.updateTemplate(auth, PARTNER_TEMPLATE.id, { name: 'Renamed' })).rejects.toBeInstanceOf(
      PartnerWideWriteDeniedError
    );
    expect(db.update).not.toHaveBeenCalled();
  });

  it('updates a partner-wide template when the caller has canManagePartnerWidePolicies', async () => {
    const auth = makeAuth({ scope: 'partner', partnerId: 'partner-1', partnerOrgAccess: 'all' });
    queueResult([PARTNER_TEMPLATE]);
    queueResult([{ ...PARTNER_TEMPLATE, name: 'Renamed' }]);
    const updated = await svc.updateTemplate(auth, PARTNER_TEMPLATE.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');
    expect(chain.set.mock.calls[0]![0]).toMatchObject({ name: 'Renamed' });
  });

  it('rejects updating an org-owned template outside the caller\'s org access', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => false });
    queueResult([ORG_TEMPLATE]);
    await expect(svc.updateTemplate(auth, ORG_TEMPLATE.id, { name: 'Renamed' })).rejects.toMatchObject({
      status: 403,
      code: 'ORG_DENIED',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('throws TEMPLATE_NOT_FOUND for a missing template id', async () => {
    const auth = makeAuth();
    queueResult([]); // getTemplateOr404 miss
    await expect(svc.updateTemplate(auth, 'nope', { name: 'X' })).rejects.toMatchObject({
      status: 404,
      code: 'TEMPLATE_NOT_FOUND',
    });
  });
});

describe('archiveTemplate', () => {
  it('rejects archiving a partner-wide template without canManagePartnerWidePolicies', async () => {
    const auth = makeAuth({ scope: 'partner', partnerId: 'partner-1', partnerOrgAccess: 'none' });
    queueResult([PARTNER_TEMPLATE]);
    await expect(svc.archiveTemplate(auth, PARTNER_TEMPLATE.id)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('archives an org-owned template within the caller\'s org access', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    queueResult([{ ...ORG_TEMPLATE, status: 'archived' }]);
    await svc.archiveTemplate(auth, ORG_TEMPLATE.id);
    expect(chain.set.mock.calls[0]![0]).toMatchObject({ status: 'archived' });
  });
});

// ---------------------------------------------------------------------------
// createDraftVersion — version numbering, sanitize-on-write, archive block
// ---------------------------------------------------------------------------

describe('createDraftVersion', () => {
  it('allocates version 1 for a template with no existing versions', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]); // getTemplateOr404
    queueResult([{ maxVersion: null }]); // nextVersionNumber aggregate
    queueResult([{ id: 'v1', templateId: ORG_TEMPLATE.id, versionNumber: 1, status: 'draft', sourceType: 'authored' }]);
    const row = await svc.createDraftVersion(auth, ORG_TEMPLATE.id, { bodyHtml: '<p>Hello</p>' });
    expect(row.versionNumber).toBe(1);
    expect(chain.values.mock.calls[0]![0]).toMatchObject({ versionNumber: 1, status: 'draft', sourceType: 'authored' });
  });

  it('allocates max+1 when versions already exist', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    queueResult([{ maxVersion: 3 }]);
    queueResult([{ id: 'v4', templateId: ORG_TEMPLATE.id, versionNumber: 4, status: 'draft', sourceType: 'authored' }]);
    const row = await svc.createDraftVersion(auth, ORG_TEMPLATE.id, { bodyHtml: '<p>Hello</p>' });
    expect(row.versionNumber).toBe(4);
    expect(chain.values.mock.calls[0]![0]).toMatchObject({ versionNumber: 4 });
  });

  it('sanitizes bodyHtml before persisting (script tag stripped)', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    queueResult([{ maxVersion: null }]);
    queueResult([{ id: 'v1', versionNumber: 1 }]);
    await svc.createDraftVersion(auth, ORG_TEMPLATE.id, { bodyHtml: '<p>Hi<script>alert(1)</script></p>' });
    const persisted = chain.values.mock.calls[0]![0] as { bodyHtml: string };
    expect(persisted.bodyHtml).not.toContain('<script>');
    expect(persisted.bodyHtml).toContain('Hi');
  });

  it('rejects adding a draft version to an archived template', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ARCHIVED_ORG_TEMPLATE]);
    await expect(svc.createDraftVersion(auth, ARCHIVED_ORG_TEMPLATE.id, { bodyHtml: '<p>x</p>' })).rejects.toMatchObject({
      status: 409,
      code: 'TEMPLATE_ARCHIVED',
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('never mutates an existing (e.g. published) version — always inserts a new row', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    queueResult([{ maxVersion: 1 }]); // v1 already published
    queueResult([{ id: 'v2', versionNumber: 2 }]);
    await svc.createDraftVersion(auth, ORG_TEMPLATE.id, { bodyHtml: '<p>edit</p>' });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createUploadedVersion — PDF magic-byte + 10MB cap
// ---------------------------------------------------------------------------

describe('createUploadedVersion', () => {
  it('rejects a file that does not start with the %PDF- magic bytes', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    const notAPdf = Buffer.from('not a pdf at all');
    await expect(
      svc.createUploadedVersion(auth, ORG_TEMPLATE.id, { data: notAPdf, mime: 'application/pdf' })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_FILE' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a file larger than the 10MB cap even with a valid PDF header', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    const oversized = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(10 * 1024 * 1024)]);
    await expect(
      svc.createUploadedVersion(auth, ORG_TEMPLATE.id, { data: oversized, mime: 'application/pdf' })
    ).rejects.toMatchObject({ status: 400, code: 'FILE_TOO_LARGE' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('accepts a valid, under-cap PDF and allocates the next version number', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    queueResult([{ maxVersion: null }]);
    const pdf = await validPdfBytes();
    queueResult([{ id: 'v1', versionNumber: 1, sourceType: 'uploaded' }]);
    const row = await svc.createUploadedVersion(auth, ORG_TEMPLATE.id, { data: pdf, mime: 'application/pdf' });
    expect(row.versionNumber).toBe(1);
    expect(chain.values.mock.calls[0]![0]).toMatchObject({
      sourceType: 'uploaded',
      mime: 'application/pdf',
      byteSize: pdf.length,
    });
  });

  it('rejects an ENCRYPTED PDF (valid %PDF- magic, unloadable) with 400 ENCRYPTED_FILE', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    const pdf = encryptedPdfBytes();
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-'); // passes the magic-byte gate
    await expect(
      svc.createUploadedVersion(auth, ORG_TEMPLATE.id, { data: pdf, mime: 'application/pdf' })
    ).rejects.toMatchObject({ status: 400, code: 'ENCRYPTED_FILE' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects a corrupt PDF that passes the magic-byte gate but is not loadable with 400 INVALID_FILE', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    // Valid magic, then a malformed object pdf-lib's parser chokes on (its
    // recovery parser tolerates trailing garbage, but not a broken object ref).
    const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Broken >>\n');
    await expect(
      svc.createUploadedVersion(auth, ORG_TEMPLATE.id, { data: pdf, mime: 'application/pdf' })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_FILE' });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('rejects an upload against an archived template', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ARCHIVED_ORG_TEMPLATE]);
    const pdf = Buffer.from('%PDF-1.7\n%%EOF');
    await expect(
      svc.createUploadedVersion(auth, ARCHIVED_ORG_TEMPLATE.id, { data: pdf, mime: 'application/pdf' })
    ).rejects.toMatchObject({ status: 409, code: 'TEMPLATE_ARCHIVED' });
    expect(db.insert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// publishVersion — immutability, sha256, variable scanning
// ---------------------------------------------------------------------------

describe('publishVersion', () => {
  it('throws 409 VERSION_IMMUTABLE when publishing an already-published version', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]); // getTemplateOr404
    queueResult([{ id: 'v1', templateId: ORG_TEMPLATE.id, status: 'published', sourceType: 'authored', bodyHtml: '<p>x</p>' }]); // getVersionOr404
    await expect(svc.publishVersion(auth, ORG_TEMPLATE.id, 'v1')).rejects.toMatchObject({
      status: 409,
      code: 'VERSION_IMMUTABLE',
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('computes sha256 over body_html and scans {{vars}} for an authored version', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    const body = '<p>Dear {{client.name}}, custom note: {{special_clause}}</p>';
    queueResult([ORG_TEMPLATE]);
    queueResult([{ id: 'v1', templateId: ORG_TEMPLATE.id, status: 'draft', sourceType: 'authored', bodyHtml: body }]);
    queueResult([{ id: 'v1', status: 'published', sha256: 'x', declaredVariables: [], publishedAt: new Date() }]);

    await svc.publishVersion(auth, ORG_TEMPLATE.id, 'v1');

    const expectedSha = createHash('sha256').update(body, 'utf8').digest('hex');
    const setArg = chain.set.mock.calls[0]![0] as {
      status: string;
      sha256: string;
      declaredVariables: Array<{ name: string; kind: string }>;
      publishedAt: Date;
    };
    expect(setArg.status).toBe('published');
    expect(setArg.sha256).toBe(expectedSha);
    expect(setArg.publishedAt).toBeInstanceOf(Date);
    expect(setArg.declaredVariables).toEqual(
      expect.arrayContaining([
        { name: 'client.name', kind: 'auto' },
        { name: 'special_clause', kind: 'manual' },
      ])
    );
    expect(setArg.declaredVariables).toHaveLength(2);
  });

  it('computes sha256 over file_data and declares no variables for an uploaded version', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    const fileData = Buffer.from('%PDF-1.7\n%%EOF');
    queueResult([ORG_TEMPLATE]);
    queueResult([{ id: 'v1', templateId: ORG_TEMPLATE.id, status: 'draft', sourceType: 'uploaded', fileData }]);
    queueResult([{ id: 'v1', status: 'published' }]);

    await svc.publishVersion(auth, ORG_TEMPLATE.id, 'v1');

    const expectedSha = createHash('sha256').update(fileData).digest('hex');
    const setArg = chain.set.mock.calls[0]![0] as { sha256: string; declaredVariables: unknown[] };
    expect(setArg.sha256).toBe(expectedSha);
    expect(setArg.declaredVariables).toEqual([]);
  });

  it('rejects publishing a partner-wide template\'s version without canManagePartnerWidePolicies', async () => {
    const auth = makeAuth({ scope: 'partner', partnerId: 'partner-1', partnerOrgAccess: 'selected' });
    queueResult([PARTNER_TEMPLATE]); // getTemplateOr404 — gate runs before the version fetch
    await expect(svc.publishVersion(auth, PARTNER_TEMPLATE.id, 'v1')).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('throws VERSION_NOT_FOUND when the version does not belong to the template', async () => {
    const auth = makeAuth({ scope: 'organization', canAccessOrg: () => true });
    queueResult([ORG_TEMPLATE]);
    queueResult([]); // no matching (id, templateId) row
    await expect(svc.publishVersion(auth, ORG_TEMPLATE.id, 'not-mine')).rejects.toMatchObject({
      status: 404,
      code: 'VERSION_NOT_FOUND',
    });
  });
});

// ---------------------------------------------------------------------------
// listTemplates — happy path + latest-version rollup
// ---------------------------------------------------------------------------

describe('listTemplates', () => {
  it('attaches the highest-versionNumber version as latestVersion per template', async () => {
    const auth = makeAuth({ scope: 'system', partnerId: null, accessibleOrgIds: null, orgCondition: () => undefined });
    queueResult([ORG_TEMPLATE, PARTNER_TEMPLATE]);
    queueResult([
      { id: 'v3', templateId: ORG_TEMPLATE.id, versionNumber: 3 },
      { id: 'v2', templateId: ORG_TEMPLATE.id, versionNumber: 2 },
      { id: 'v1', templateId: PARTNER_TEMPLATE.id, versionNumber: 1 },
    ]);
    const rows = await svc.listTemplates(auth);
    const orgRow = rows.find((r) => r.id === ORG_TEMPLATE.id)!;
    const partnerRow = rows.find((r) => r.id === PARTNER_TEMPLATE.id)!;
    expect(orgRow.latestVersion?.versionNumber).toBe(3);
    expect(partnerRow.latestVersion?.versionNumber).toBe(1);
  });

  it('returns an empty latestVersion for a template with no versions', async () => {
    const auth = makeAuth({ scope: 'system', partnerId: null, accessibleOrgIds: null, orgCondition: () => undefined });
    queueResult([ORG_TEMPLATE]);
    queueResult([]);
    const rows = await svc.listTemplates(auth);
    expect(rows[0]!.latestVersion).toBeNull();
  });

  it('returns [] without querying versions when no templates match', async () => {
    const auth = makeAuth({ scope: 'system', partnerId: null, accessibleOrgIds: null, orgCondition: () => undefined });
    queueResult([]);
    const rows = await svc.listTemplates(auth);
    expect(rows).toEqual([]);
  });
});
