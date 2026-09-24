import { beforeEach, describe, expect, it, vi } from 'vitest';

const TICKET_ID = '00000000-0000-0000-0000-000000000001';
const ITEM_ID = '00000000-0000-0000-0000-000000000002';
const ITEM_ID_2 = '00000000-0000-0000-0000-000000000003';
const TEMPLATE_ID = '00000000-0000-0000-0000-000000000004';
const ORG_ID = '00000000-0000-0000-0000-000000000010';

const { checklistMocks, templateMocks, mockLimit, mockSelect } = vi.hoisted(() => {
  const checklistMocks = {
    addChecklistItem: vi.fn(),
    deleteChecklistItem: vi.fn(),
    getChecklistItemOr404: vi.fn(),
    isChecklistItemTickedForUpdate: vi.fn(),
    listChecklist: vi.fn(),
    patchChecklistItem: vi.fn(),
    reorderChecklist: vi.fn(),
  };
  const templateMocks = {
    applyChecklistTemplateToTicket: vi.fn(),
    getChecklistTemplate: vi.fn(),
    listChecklistTemplates: vi.fn(),
  };
  // findTicketWithAccess ends in .limit(1).
  const mockLimit = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));
  const mockSelect = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({ limit: mockLimit })),
    })),
  }));
  return { checklistMocks, templateMocks, mockLimit, mockSelect };
});

vi.mock('../db', () => ({ db: { select: mockSelect } }));

vi.mock('../middleware/auth', () => ({
  isAiAgentPrincipal: (auth: { principal?: { kind?: string } }) => auth?.principal?.kind === 'ai_agent',
}));

vi.mock('../routes/tickets/siteScope', () => ({
  deviceInSiteScope: vi.fn(async () => true),
  ticketSiteScopeCondition: vi.fn(() => undefined),
}));

vi.mock('./ticketChecklistService', () => checklistMocks);
vi.mock('./ticketChecklistTemplateService', () => templateMocks);

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerTicketingTools } from './aiToolsTicketing';
import { validateToolInput } from './aiToolSchemas';
import { PartnerWideWriteDeniedError } from './partnerWideAccess';

function getTool(): AiTool {
  const tools = new Map<string, AiTool>();
  registerTicketingTools(tools);
  const tool = tools.get('manage_ticket_checklist');
  if (!tool) throw new Error('manage_ticket_checklist not registered');
  return tool;
}

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'api_key' },
    user: { id: 'user-1', email: 'tech@example.com', name: 'Tech User', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: 'partner-1',
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [ORG_ID],
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: vi.fn(() => true),
    ...overrides,
  } as AuthContext;
}

function mockAccessibleTicket() {
  mockLimit.mockResolvedValueOnce([{ id: TICKET_ID, orgId: ORG_ID, deviceId: null }]);
}

async function run(input: Record<string, unknown>, auth = makeAuth()) {
  return JSON.parse(await getTool().handler(input, auth)) as Record<string, unknown>;
}

describe('manage_ticket_checklist (#6930)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLimit.mockResolvedValue([]);
    checklistMocks.getChecklistItemOr404.mockResolvedValue({ id: ITEM_ID, ticketId: TICKET_ID });
  });

  describe('schema', () => {
    it('rejects `done` — ticking is never a tool action', () => {
      const res = validateToolInput('manage_ticket_checklist', { action: 'update_item', itemId: ITEM_ID, done: true });
      expect(res.success).toBe(false);
    });

    it('accepts a label/detail edit', () => {
      expect(validateToolInput('manage_ticket_checklist', { action: 'update_item', itemId: ITEM_ID, label: 'x', detail: null }))
        .toEqual({ success: true });
    });

    it('does not advertise `done` in the tool definition', () => {
      const props = getTool().definition.input_schema.properties as Record<string, unknown>;
      expect(props).not.toHaveProperty('done');
    });
  });

  it('refuses an organization-scoped token before any lookup', async () => {
    const out = await run({ action: 'list', ticketId: TICKET_ID }, makeAuth({ scope: 'organization' }));
    expect(out.code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('list returns the checklist for an accessible ticket', async () => {
    mockAccessibleTicket();
    checklistMocks.listChecklist.mockResolvedValue({ items: [], done: 0, total: 0 });
    const out = await run({ action: 'list', ticketId: TICKET_ID });
    expect(out.checklist).toEqual({ items: [], done: 0, total: 0 });
    expect(checklistMocks.listChecklist).toHaveBeenCalledWith(TICKET_ID);
  });

  it('list on an out-of-scope ticket is not found and reads nothing', async () => {
    const out = await run({ action: 'list', ticketId: TICKET_ID });
    expect(out.error).toBe('Ticket not found');
    expect(checklistMocks.listChecklist).not.toHaveBeenCalled();
  });

  it('add_item writes against the TICKET org with the caller as creator', async () => {
    mockAccessibleTicket();
    checklistMocks.addChecklistItem.mockResolvedValue({ id: ITEM_ID });
    await run({ action: 'add_item', ticketId: TICKET_ID, label: 'Install agent', detail: 'MSI' });
    expect(checklistMocks.addChecklistItem).toHaveBeenCalledWith(
      { id: TICKET_ID, orgId: ORG_ID },
      { label: 'Install agent', detail: 'MSI' },
      { userId: 'user-1' },
    );
  });

  it('update_item scopes through the item\'s own ticket', async () => {
    // item lookup succeeds but its ticket is not visible to the caller
    const out = await run({ action: 'update_item', itemId: ITEM_ID, label: 'new' });
    expect(out.error).toBe('Checklist item not found');
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it('update_item edits an unticked step with label/detail only', async () => {
    mockAccessibleTicket();
    checklistMocks.isChecklistItemTickedForUpdate.mockResolvedValueOnce(false);
    checklistMocks.patchChecklistItem.mockResolvedValue({ id: ITEM_ID, label: 'new' });
    await run({ action: 'update_item', itemId: ITEM_ID, label: 'new', detail: null });
    expect(checklistMocks.isChecklistItemTickedForUpdate).toHaveBeenCalledWith(ITEM_ID);
    expect(checklistMocks.patchChecklistItem).toHaveBeenCalledWith(ITEM_ID, { label: 'new', detail: null }, { userId: 'user-1' });
  });

  it('update_item refuses a ticked step (a text edit would clear the attestation)', async () => {
    mockAccessibleTicket();
    checklistMocks.isChecklistItemTickedForUpdate.mockResolvedValueOnce(true);
    const out = await run({ action: 'update_item', itemId: ITEM_ID, label: 'new' });
    expect(out.code).toBe('CHECKLIST_TICKED_ITEM_REQUIRES_USER');
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it('delete_item refuses a ticked step', async () => {
    mockAccessibleTicket();
    checklistMocks.isChecklistItemTickedForUpdate.mockResolvedValueOnce(true);
    const out = await run({ action: 'delete_item', itemId: ITEM_ID });
    expect(out.code).toBe('CHECKLIST_TICKED_ITEM_REQUIRES_USER');
    expect(checklistMocks.deleteChecklistItem).not.toHaveBeenCalled();
  });

  it('delete_item deletes an unticked step', async () => {
    mockAccessibleTicket();
    checklistMocks.isChecklistItemTickedForUpdate.mockResolvedValueOnce(false);
    const out = await run({ action: 'delete_item', itemId: ITEM_ID });
    expect(out.deleted).toBe(true);
    expect(checklistMocks.deleteChecklistItem).toHaveBeenCalledWith(ITEM_ID);
  });

  it('a `done` key that bypassed validation is still refused before any lookup', async () => {
    const out = await run({ action: 'update_item', itemId: ITEM_ID, done: true });
    expect(out.code).toBe('CHECKLIST_TICKED_ITEM_REQUIRES_USER');
    expect(checklistMocks.getChecklistItemOr404).not.toHaveBeenCalled();
    expect(checklistMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it('reorder passes the full id list through', async () => {
    mockAccessibleTicket();
    checklistMocks.reorderChecklist.mockResolvedValue({ items: [], done: 0, total: 2 });
    await run({ action: 'reorder', ticketId: TICKET_ID, itemIds: [ITEM_ID_2, ITEM_ID] });
    expect(checklistMocks.reorderChecklist).toHaveBeenCalledWith(TICKET_ID, [ITEM_ID_2, ITEM_ID]);
  });

  it('service errors come back as { error, code, details }', async () => {
    mockAccessibleTicket();
    const err = Object.assign(new Error('mismatch'), { status: 400, code: 'CHECKLIST_REORDER_MISMATCH', details: { expected: 2, received: 1 } });
    checklistMocks.reorderChecklist.mockRejectedValue(err);
    const out = await run({ action: 'reorder', ticketId: TICKET_ID, itemIds: [ITEM_ID] });
    expect(out).toEqual({ error: 'mismatch', code: 'CHECKLIST_REORDER_MISMATCH', details: { expected: 2, received: 1 } });
  });

  it('apply_template defaults to append and passes the template actor', async () => {
    mockAccessibleTicket();
    templateMocks.applyChecklistTemplateToTicket.mockResolvedValue({ items: [], done: 0, total: 3 });
    await run({ action: 'apply_template', ticketId: TICKET_ID, templateId: TEMPLATE_ID });
    expect(templateMocks.applyChecklistTemplateToTicket).toHaveBeenCalledWith(
      { id: TICKET_ID, orgId: ORG_ID },
      { templateId: TEMPLATE_ID, mode: 'append' },
      expect.objectContaining({ userId: 'user-1', scope: 'partner', partnerId: 'partner-1', accessibleOrgIds: [ORG_ID] }),
    );
  });

  it('list_templates and get_template call the template service with the caller actor', async () => {
    templateMocks.listChecklistTemplates.mockResolvedValue([]);
    templateMocks.getChecklistTemplate.mockResolvedValue({ id: TEMPLATE_ID });
    await run({ action: 'list_templates', orgId: ORG_ID });
    expect(templateMocks.listChecklistTemplates).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'partner-1' }),
      { orgId: ORG_ID, includeInactive: false },
    );
    const out = await run({ action: 'get_template', templateId: TEMPLATE_ID });
    expect(out.template).toEqual({ id: TEMPLATE_ID });
  });

  it('maps PartnerWideWriteDeniedError to PARTNER_WIDE_WRITE_DENIED', async () => {
    templateMocks.getChecklistTemplate.mockRejectedValue(new PartnerWideWriteDeniedError());
    const out = await run({ action: 'get_template', templateId: TEMPLATE_ID });
    expect(out.code).toBe('PARTNER_WIDE_WRITE_DENIED');
  });

  it('refuses writes from an ai_agent principal (its user id is not a users row)', async () => {
    const auth = makeAuth({ principal: { kind: 'ai_agent', runId: 'run-1' } as AuthContext['principal'] });
    const out = await run({ action: 'add_item', ticketId: TICKET_ID, label: 'x' }, auth);
    expect(out.error).toBe('agent_principal_unsupported_action');
    expect(checklistMocks.addChecklistItem).not.toHaveBeenCalled();
  });
});
