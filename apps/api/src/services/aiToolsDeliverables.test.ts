import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./orgDocumentService', () => ({
  listDocuments: vi.fn(),
  updateDocument: vi.fn(),
  supersedeDocument: vi.fn(),
}));

import { registerDeliverableTools } from './aiToolsDeliverables';
import { listDocuments, supersedeDocument, updateDocument } from './orgDocumentService';
import { DeliverableServiceError } from './serviceDeliverableService';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const auth: AuthContext = {
  principal: { kind: 'user_session' },
  user: { id: 'u-1', email: 'user@example.test', name: 'User', isPlatformAdmin: false },
  token: {
    sub: 'u-1', email: 'user@example.test', roleId: null, orgId: null, partnerId: 'p-1',
    scope: 'partner', type: 'access', mfa: true,
  },
  partnerId: 'p-1',
  orgId: null,
  scope: 'partner',
  accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'],
  orgCondition: () => undefined,
  canAccessOrg: () => true,
} as AuthContext;

const ORG = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const DOC2 = '33333333-3333-4333-8333-333333333333';
const ACTOR = { userId: 'u-1', partnerId: 'p-1', accessibleOrgIds: [ORG] };

function tools(): Map<string, AiTool> {
  const m = new Map<string, AiTool>();
  registerDeliverableTools(m);
  return m;
}
const tool = (name: string) => {
  const t = tools().get(name);
  if (!t) throw new Error(`${name} not registered`);
  return t;
};

describe('org document AI tools (service deliverables W03)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers exactly the two document tools at tier 2', () => {
    const m = tools();
    expect(m.get('list_org_documents')?.tier).toBe(2);
    expect(m.get('manage_org_documents')?.tier).toBe(2);
  });

  it('list_org_documents returns heads only by default and reports the count', async () => {
    vi.mocked(listDocuments).mockResolvedValueOnce([{ id: DOC, title: 'Runbook' }] as never);
    const out = JSON.parse(await tool('list_org_documents').handler({ orgId: ORG }, auth));
    expect(out).toEqual({ documents: [{ id: DOC, title: 'Runbook' }], showing: 1 });
    expect(listDocuments).toHaveBeenCalledWith(ORG, { category: undefined, includeSuperseded: false }, ACTOR);
  });

  it('list_org_documents never exposes bytes or storage keys in its description', () => {
    const d = tool('list_org_documents').definition.description ?? '';
    expect(d).toMatch(/metadata only/i);
    expect(d).toMatch(/never the file bytes/i);
  });

  it('manage_org_documents has NO byte-upload action', () => {
    const t = tool('manage_org_documents');
    const actions = (t.definition.input_schema.properties as Record<string, { enum?: string[] }>).action!.enum;
    expect(actions).toEqual(['update_metadata', 'set_portal_visibility', 'supersede']);
    expect(JSON.stringify(t.definition)).not.toMatch(/base64|upload|contentBase/i);
  });

  it('manage_org_documents rejects a missing documentId before coercing it to the string "undefined"', async () => {
    const out = JSON.parse(await tool('manage_org_documents').handler({ action: 'set_portal_visibility', portalVisible: true }, auth));
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(out.error).toContain('documentId');
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it('set_portal_visibility patches ONLY portalVisible', async () => {
    vi.mocked(updateDocument).mockResolvedValueOnce({ id: DOC, portalVisible: true } as never);
    await tool('manage_org_documents').handler({ action: 'set_portal_visibility', orgId: ORG, documentId: DOC, portalVisible: true }, auth);
    expect(updateDocument).toHaveBeenCalledWith(ORG, DOC, { portalVisible: true }, ACTOR);
  });

  it('set_portal_visibility rejects a non-boolean rather than coercing "false" to true', async () => {
    const out = JSON.parse(await tool('manage_org_documents').handler({ action: 'set_portal_visibility', orgId: ORG, documentId: DOC, portalVisible: 'false' }, auth));
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it('update_metadata validates the patch (unknown key rejected with a patch.* path)', async () => {
    const out = JSON.parse(await tool('manage_org_documents').handler({
      action: 'update_metadata', orgId: ORG, documentId: DOC, patch: { storageKey: 'org-documents/evil' },
    }, auth));
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(updateDocument).not.toHaveBeenCalled();
  });

  it('update_metadata forwards a valid patch', async () => {
    vi.mocked(updateDocument).mockResolvedValueOnce({ id: DOC, title: 'New' } as never);
    const out = JSON.parse(await tool('manage_org_documents').handler({
      action: 'update_metadata', orgId: ORG, documentId: DOC, patch: { title: 'New', category: 'runbook' },
    }, auth));
    expect(out).toEqual({ id: DOC, title: 'New' });
    expect(updateDocument).toHaveBeenCalledWith(ORG, DOC, { title: 'New', category: 'runbook' }, ACTOR);
  });

  it('supersede links two documents', async () => {
    vi.mocked(supersedeDocument).mockResolvedValueOnce({ id: DOC2, supersedesDocumentId: DOC } as never);
    await tool('manage_org_documents').handler({ action: 'supersede', orgId: ORG, documentId: DOC2, supersedesDocumentId: DOC }, auth);
    expect(supersedeDocument).toHaveBeenCalledWith(ORG, DOC2, DOC, ACTOR);
  });

  it('a document of another org answers a 404 JSON error, never a throw', async () => {
    vi.mocked(updateDocument).mockRejectedValueOnce(new DeliverableServiceError('Not found', 404, 'NOT_FOUND'));
    const out = JSON.parse(await tool('manage_org_documents').handler({ action: 'set_portal_visibility', orgId: ORG, documentId: DOC, portalVisible: false }, auth));
    expect(out).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('an unknown action is a structured error', async () => {
    const out = JSON.parse(await tool('manage_org_documents').handler({ action: 'upload', orgId: ORG }, auth));
    expect(out).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
