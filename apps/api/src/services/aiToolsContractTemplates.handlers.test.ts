import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const PARTNER = '00000000-0000-4000-8000-0000000000e1';
const TEMPLATE = '00000000-0000-4000-8000-0000000000d1';
const VERSION = '00000000-0000-4000-8000-0000000000d2';
const DOC = '00000000-0000-4000-8000-0000000000d3';
const CONTRACT = '00000000-0000-4000-8000-0000000000d4';
const BODY = '<p>Master services agreement for {{ org.name }}</p>';

const h = vi.hoisted(() => ({
  auditAsync: vi.fn(),
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  getTemplateVersion: vi.fn(),
  getTemplateUsage: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  archiveTemplate: vi.fn(),
  createDraftVersion: vi.fn(),
  publishVersion: vi.fn(),
  listDocs: vi.fn(),
  linkDoc: vi.fn(),
}));

vi.mock('../db', () => ({ db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.auditAsync }));
vi.mock('./contractTemplateService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contractTemplateService')>();
  return {
    ...actual,
    listTemplates: h.listTemplates, getTemplate: h.getTemplate, getTemplateVersion: h.getTemplateVersion,
    getTemplateUsage: h.getTemplateUsage, createTemplate: h.createTemplate, updateTemplate: h.updateTemplate,
    archiveTemplate: h.archiveTemplate, createDraftVersion: h.createDraftVersion, publishVersion: h.publishVersion,
  };
});
vi.mock('./contractDocumentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contractDocumentService')>();
  return { ContractDocumentServiceError: actual.ContractDocumentServiceError, listContractDocuments: h.listDocs, linkContractDocument: h.linkDoc };
});

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerContractTemplateTools } from './aiToolsContractTemplates';
import { ContractDocumentServiceError } from './contractDocumentService';
import { ContractTemplateServiceError, PartnerWideWriteDeniedError } from './contractTemplateService';

const tools = new Map<string, AiTool>();
registerContractTemplateTools(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'partner',
  orgId: null,
  partnerId: PARTNER,
  partnerOrgAccess: 'all',
  accessibleOrgIds: [ORG],
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  allowedSiteIds: undefined,
  allowedDeviceIds: undefined,
  token: { mfa: true, amr: ['pwd', 'mfa'] },
  aiOrigin: { kind: 'chat', sessionId: 'session-1' },
  ...over,
}) as unknown as AuthContext;
const run = async (name: string, input: Record<string, unknown>, auth: AuthContext = makeAuth()) =>
  JSON.parse(await tools.get(name)!.handler(input, auth)) as Record<string, any>;

const template = (over: Record<string, unknown> = {}) => ({
  id: TEMPLATE, orgId: ORG, partnerId: null, name: 'MSA', description: null, status: 'active',
  createdBy: 'user-1', createdAt: new Date(), updatedAt: new Date(), ...over,
});
const version = (over: Record<string, unknown> = {}) => ({
  id: VERSION, templateId: TEMPLATE, orgId: ORG, partnerId: null, versionNumber: 1, status: 'draft', sourceType: 'authored',
  bodyHtml: BODY, fileData: Buffer.from('%PDF-secret-bytes'), mime: null, byteSize: null, sha256: null,
  declaredVariables: [], publishedAt: null, createdBy: 'user-1', createdAt: new Date(), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.getTemplate.mockResolvedValue({ ...template(), versions: [version()] });
});

describe('manage_contract_templates', () => {
  it('list strips every version body (quorum QW4)', async () => {
    h.listTemplates.mockResolvedValue([{ ...template(), latestVersion: { ...version(), fileData: undefined } }]);
    const out = await run('manage_contract_templates', { action: 'list' });
    expect(JSON.stringify(out)).not.toContain('Master services agreement');
    expect(out.templates[0]).toMatchObject({ id: TEMPLATE, ownerScope: 'organization' });
  });

  it('get lists versions without bodyHtml or file bytes; get_version returns the body but never the bytes', async () => {
    const got = await run('manage_contract_templates', { action: 'get', templateId: TEMPLATE });
    expect(JSON.stringify(got)).not.toContain('Master services agreement');
    expect(JSON.stringify(got)).not.toContain('secret-bytes');
    h.getTemplateVersion.mockResolvedValue(version());
    const v = await run('manage_contract_templates', { action: 'get_version', templateId: TEMPLATE, versionId: VERSION });
    expect(v.version.bodyHtml).toBe(BODY);
    expect(JSON.stringify(v)).not.toContain('secret-bytes');
  });

  it('a device-bound session cannot read the org-wide template library', async () => {
    expect((await run('manage_contract_templates', { action: 'list' }, makeAuth({ allowedDeviceIds: ['d1'] }))).code).toBe('ACCESS_DENIED');
    expect(h.listTemplates).not.toHaveBeenCalled();
  });

  it('update refuses an ownerScope assertion that does not match the row (both directions)', async () => {
    const asPartner = await run('manage_contract_templates', { action: 'update', templateId: TEMPLATE, ownerScope: 'partner', name: 'x' });
    expect(asPartner.code).toBe('OWNER_SCOPE_MISMATCH');
    h.getTemplate.mockResolvedValue({ ...template({ orgId: null, partnerId: PARTNER }), versions: [] });
    const asOrg = await run('manage_contract_templates', { action: 'update', templateId: TEMPLATE, name: 'x' });
    expect(asOrg.code).toBe('OWNER_SCOPE_MISMATCH');
    expect(h.updateTemplate).not.toHaveBeenCalled();
    h.updateTemplate.mockResolvedValue(template({ orgId: null, partnerId: PARTNER, name: 'x' }));
    expect((await run('manage_contract_templates', { action: 'update', templateId: TEMPLATE, ownerScope: 'partner', name: 'x' })).template.name).toBe('x');
  });

  it.each(['create_version', 'publish', 'archive'])('%s refuses a partner-wide template (irreversible + partner-wide, W14-D5)', async (action) => {
    h.getTemplate.mockResolvedValue({ ...template({ orgId: null, partnerId: PARTNER }), versions: [] });
    const out = await run('manage_contract_templates', { action, templateId: TEMPLATE, versionId: VERSION, bodyHtml: BODY, ownerScope: 'partner' });
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.createDraftVersion).not.toHaveBeenCalled();
    expect(h.publishVersion).not.toHaveBeenCalled();
    expect(h.archiveTemplate).not.toHaveBeenCalled();
  });

  it('org template writes refuse a site-restricted session (org-wide library)', async () => {
    const siteAuth = makeAuth({ scope: 'organization', orgId: ORG, allowedSiteIds: ['s1'] });
    for (const action of ['create', 'update', 'create_version', 'publish', 'archive']) {
      const out = await run('manage_contract_templates', { action, templateId: TEMPLATE, versionId: VERSION, orgId: ORG, name: 'n', bodyHtml: BODY }, siteAuth);
      expect(out.code, action).toBe('ACCESS_DENIED');
    }
    expect(h.createTemplate).not.toHaveBeenCalled();
  });

  it('create defaults to an org-owned template and audits; publish returns no body', async () => {
    h.createTemplate.mockResolvedValue(template());
    const out = await run('manage_contract_templates', { action: 'create', orgId: ORG, name: 'MSA' });
    expect(h.createTemplate).toHaveBeenCalledWith(expect.anything(), { ownerScope: 'organization', orgId: ORG, name: 'MSA' });
    expect(out.template.ownerScope).toBe('organization');
    expect(h.auditAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'contract_template.create', orgId: ORG }));
    h.publishVersion.mockResolvedValue(version({ status: 'published', sha256: 'abc' }));
    const pub = await run('manage_contract_templates', { action: 'publish', templateId: TEMPLATE, versionId: VERSION });
    expect(pub.version.status).toBe('published');
    expect(JSON.stringify(pub)).not.toContain('Master services agreement');
  });
});

describe('manage_contract_templates (review round)', () => {
  it('a partner-wide create: refused without full partner access (service gate), lands with it and audits on the partner', async () => {
    h.createTemplate.mockRejectedValueOnce(new PartnerWideWriteDeniedError());
    const sel = await run('manage_contract_templates', { action: 'create', ownerScope: 'partner', name: 'MSA' }, makeAuth({ partnerOrgAccess: 'selected' }));
    expect(sel.code).toBe('ACCESS_DENIED');
    h.createTemplate.mockResolvedValue(template({ orgId: null, partnerId: PARTNER }));
    const ok = await run('manage_contract_templates', { action: 'create', ownerScope: 'partner', name: 'MSA' });
    expect(h.createTemplate).toHaveBeenLastCalledWith(expect.anything(), { ownerScope: 'partner', name: 'MSA' });
    expect(ok.template.ownerScope).toBe('partner');
    expect(h.auditAsync).toHaveBeenCalledWith(expect.objectContaining({ action: 'contract_template.create', orgId: null, partnerId: PARTNER }));
  });

  it('a partner-wide create with an orgId is a validation error (XOR ownership)', async () => {
    const out = await run('manage_contract_templates', { action: 'create', ownerScope: 'partner', orgId: ORG, name: 'MSA' });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(h.createTemplate).not.toHaveBeenCalled();
  });

  it.each(['list', 'get', 'get_version', 'usage'])('%s refuses a device-bound session', async (action) => {
    const out = await run('manage_contract_templates', { action, templateId: TEMPLATE, versionId: VERSION }, makeAuth({ allowedDeviceIds: ['d1'] }));
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.listTemplates).not.toHaveBeenCalled();
    expect(h.getTemplate).not.toHaveBeenCalled();
    expect(h.getTemplateVersion).not.toHaveBeenCalled();
    expect(h.getTemplateUsage).not.toHaveBeenCalled();
  });

  it('a partner session without a partnerId is refused before any read', async () => {
    const out = await run('manage_contract_templates', { action: 'list' }, makeAuth({ partnerId: null }));
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.listTemplates).not.toHaveBeenCalled();
  });

  it('update returns and audits the previous name / description; an empty update is a validation error', async () => {
    h.updateTemplate.mockResolvedValue(template({ name: 'MSA v2' }));
    const out = await run('manage_contract_templates', { action: 'update', templateId: TEMPLATE, name: 'MSA v2' });
    expect(out.before).toEqual({ name: 'MSA', description: null });
    expect(h.auditAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: 'contract_template.update', details: expect.objectContaining({ changedFields: ['name'], before: { name: 'MSA', description: null } }),
    }));
    expect((await run('manage_contract_templates', { action: 'update', templateId: TEMPLATE })).code).toBe('VALIDATION_ERROR');
    expect(h.updateTemplate).toHaveBeenCalledTimes(1);
  });

  it('service errors keep their code; an unexpected error never reaches the model', async () => {
    h.publishVersion.mockRejectedValueOnce(new ContractTemplateServiceError('Published versions are immutable', 409, 'VERSION_IMMUTABLE'));
    expect((await run('manage_contract_templates', { action: 'publish', templateId: TEMPLATE, versionId: VERSION })).code).toBe('VERSION_IMMUTABLE');
    h.publishVersion.mockRejectedValueOnce(new Error('connection reset by db-internal-host'));
    const raw = await tools.get('manage_contract_templates')!.handler({ action: 'publish', templateId: TEMPLATE, versionId: VERSION }, makeAuth());
    expect(raw).not.toContain('db-internal-host');
    expect(JSON.parse(raw).error).toBeTruthy();
  });

  it('create_version returns the strip warnings and no body; get_version flags a clipped body', async () => {
    h.createDraftVersion.mockResolvedValue({ ...version(), warnings: [{ field: 'bodyHtml', removedTags: ['script'] }] });
    const v = await run('manage_contract_templates', { action: 'create_version', templateId: TEMPLATE, bodyHtml: BODY });
    expect(v.warnings).toHaveLength(1);
    expect(JSON.stringify(v)).not.toContain('Master services agreement');
    h.getTemplateVersion.mockResolvedValue(version({ bodyHtml: 'x'.repeat(20_001) }));
    const long = await run('manage_contract_templates', { action: 'get_version', templateId: TEMPLATE, versionId: VERSION });
    expect(long.version.bodyHtml).toHaveLength(20_000);
    expect(long.version.bodyTruncated).toBe(true);
  });
});

describe('manage_contract_documents', () => {
  const docRow = {
    id: DOC, orgId: ORG, contractId: null, quoteId: null, templateId: TEMPLATE, templateVersionId: VERSION,
    templateName: 'MSA', templateVersionNumber: 1, signerName: 'Pat Signer', signedAt: new Date(), signerEmail: 'pat@example.test',
    acceptanceOrigin: 'customer', acceptanceMethod: 'typed', acceptanceReference: 'ref-123', evidenceAvailable: true,
    sourceKind: 'quote', agreementRequestId: null, mime: 'application/pdf', quoteNumber: 'Q-1', byteSize: 10, sha256: 'x', createdAt: new Date(),
  };

  it('list drops the signer email and acceptance reference (W14-D6)', async () => {
    h.listDocs.mockResolvedValue([docRow]);
    const out = await run('manage_contract_documents', { action: 'list', linked: 'all' });
    expect(out.documents[0]).toMatchObject({ id: DOC, signerName: 'Pat Signer' });
    expect(JSON.stringify(out)).not.toContain('pat@example.test');
    expect(JSON.stringify(out)).not.toContain('ref-123');
  });

  it('link returns identifiers only and maps the already-linked race to ALREADY_LINKED', async () => {
    h.linkDoc.mockResolvedValue({ ...docRow, contractId: CONTRACT, pdfData: Buffer.from('%PDF-signed') });
    const out = await run('manage_contract_documents', { action: 'link', documentId: DOC, contractId: CONTRACT });
    expect(out).toEqual({ linked: true, documentId: DOC, contractId: CONTRACT });
    h.linkDoc.mockRejectedValueOnce(new ContractDocumentServiceError('Contract document is already linked to a contract', 409, 'ALREADY_LINKED'));
    expect((await run('manage_contract_documents', { action: 'link', documentId: DOC, contractId: CONTRACT })).code).toBe('ALREADY_LINKED');
  });

  it('list refuses a device-bound session', async () => {
    expect((await run('manage_contract_documents', { action: 'list' }, makeAuth({ allowedDeviceIds: ['d1'] }))).code).toBe('ACCESS_DENIED');
    expect(h.listDocs).not.toHaveBeenCalled();
  });

  it('link: a contract in another org keeps the service\'s not-found code', async () => {
    h.linkDoc.mockRejectedValueOnce(new ContractDocumentServiceError('Contract not found or belongs to a different organization', 404, 'CONTRACT_NOT_FOUND'));
    expect((await run('manage_contract_documents', { action: 'link', documentId: DOC, contractId: CONTRACT })).code).toBe('CONTRACT_NOT_FOUND');
  });

  it('link refuses a site-restricted session', async () => {
    const out = await run('manage_contract_documents', { action: 'link', documentId: DOC, contractId: CONTRACT }, makeAuth({ scope: 'organization', orgId: ORG, allowedSiteIds: [] }));
    expect(out.code).toBe('ACCESS_DENIED');
    expect(h.linkDoc).not.toHaveBeenCalled();
  });
});
