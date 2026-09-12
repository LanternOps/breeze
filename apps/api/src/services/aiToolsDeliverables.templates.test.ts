/**
 * W05 handler tests for the two template-facing AI tool doors:
 * `manage_deliverables.apply_template` (the family's ONLY approval-gated
 * action) and `list_deliverable_templates`. The registry/tier/permission
 * wiring is covered by aiToolsDeliverables.registryParity.contract.test.ts;
 * this file drives the HANDLERS so a field-mapping slip cannot ship silently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const tpl = vi.hoisted(() => ({ listTemplateSets: vi.fn(), applyTemplateSet: vi.fn() }));
vi.mock('./deliverableTemplateService', async (orig) => ({
  ...(await orig<typeof import('./deliverableTemplateService')>()),
  listTemplateSets: tpl.listTemplateSets,
  applyTemplateSet: tpl.applyTemplateSet,
}));
// Sibling collaborators never reached here, but they must not touch a DB on import.
vi.mock('./serviceDeliverableService', async (orig) => ({ ...(await orig<typeof import('./serviceDeliverableService')>()) }));
vi.mock('./orgDocumentService', () => ({ listDocuments: vi.fn(), updateDocument: vi.fn(), supersedeDocument: vi.fn() }));

import { registerDeliverableTools, MANAGE_DELIVERABLES_TOOL } from './aiToolsDeliverables';
import { TemplateServiceError } from './deliverableTemplateService';
import type { AiTool } from './aiTools';

const ORG = '11111111-1111-4111-8111-111111111111';
const SET = '22222222-2222-4222-8222-222222222222';
const CONTRACT = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const partnerAuth = {
  user: { id: 'u1', email: 'u1@example.com' }, scope: 'partner', partnerId: 'p1',
  partnerOrgAccess: 'selected', accessibleOrgIds: [ORG],
} as never;
const orgAuth = { ...(partnerAuth as object), scope: 'organization', partnerOrgAccess: undefined } as never;

const tools = new Map<string, AiTool>();
registerDeliverableTools(tools);
const call = async (name: string, input: Record<string, unknown>, as = partnerAuth) =>
  JSON.parse(await tools.get(name)!.handler(input, as));

describe('manage_deliverables.apply_template handler (W05)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('is in the definition enum', () => {
    const props = MANAGE_DELIVERABLES_TOOL.definition.input_schema.properties as Record<string, { enum?: string[] }>;
    expect(props.action!.enum).toContain('apply_template');
  });

  it('refuses an org-scoped session before touching the service', async () => {
    expect(await call('manage_deliverables', { action: 'apply_template', orgId: ORG, setId: SET }, orgAuth))
      .toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect(tpl.applyTemplateSet).not.toHaveBeenCalled();
  });

  it('reports missing orgId/setId as a structured error, never the string "undefined"', async () => {
    const out = await call('manage_deliverables', { action: 'apply_template', orgId: ORG });
    expect(out.error ?? out.code).toBeTruthy();
    expect(tpl.applyTemplateSet).not.toHaveBeenCalled();
  });

  it('maps every input field onto applyTemplateSet with the PARTNER-axis actor', async () => {
    tpl.applyTemplateSet.mockResolvedValueOnce({ setId: SET, created: [{ id: 'd1', name: 'x' }], skipped: [] });
    const out = await call('manage_deliverables', {
      action: 'apply_template', orgId: ORG, setId: SET, contractId: CONTRACT, effectiveFrom: '2026-10-01', ownerUserId: OWNER,
    });
    expect(out).toMatchObject({ setId: SET, created: [{ id: 'd1' }] });
    expect(tpl.applyTemplateSet).toHaveBeenCalledWith(
      ORG, SET,
      { contractId: CONTRACT, effectiveFrom: '2026-10-01', ownerUserId: OWNER },
      { userId: 'u1', scope: 'partner', partnerId: 'p1', partnerOrgAccess: 'selected', accessibleOrgIds: [ORG] },
    );
  });

  it('validates the payload with the shared schema (bad effectiveFrom = VALIDATION_ERROR)', async () => {
    const out = await call('manage_deliverables', { action: 'apply_template', orgId: ORG, setId: SET, effectiveFrom: '31/10/2026' });
    expect(out.code).toBe('VALIDATION_ERROR');
    expect(tpl.applyTemplateSet).not.toHaveBeenCalled();
  });

  it('surfaces a 409 collision with its details instead of throwing', async () => {
    tpl.applyTemplateSet.mockRejectedValueOnce(
      new TemplateServiceError('exists', 409, 'TEMPLATE_NAME_COLLISION', { collisions: ['Sign-in log review'] }),
    );
    const out = await call('manage_deliverables', { action: 'apply_template', orgId: ORG, setId: SET });
    expect(out).toMatchObject({ code: 'TEMPLATE_NAME_COLLISION', details: { collisions: ['Sign-in log review'] } });
  });
});

describe('list_deliverable_templates handler (W05)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('refuses an org-scoped session', async () => {
    expect(await call('list_deliverable_templates', {}, orgAuth)).toMatchObject({ code: 'PARTNER_SCOPE_REQUIRED' });
    expect(tpl.listTemplateSets).not.toHaveBeenCalled();
  });

  it('passes the optional orgId filter and the partner-axis actor through', async () => {
    tpl.listTemplateSets.mockResolvedValueOnce([{ id: SET, ownerScope: 'partner', items: [] }]);
    const out = await call('list_deliverable_templates', { orgId: ORG });
    expect(out).toEqual({ sets: [{ id: SET, ownerScope: 'partner', items: [] }], showing: 1 });
    expect(tpl.listTemplateSets).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'partner', partnerId: 'p1', partnerOrgAccess: 'selected' }),
      { orgId: ORG },
    );
  });
});
