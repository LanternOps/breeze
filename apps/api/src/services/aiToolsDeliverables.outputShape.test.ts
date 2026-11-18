// #6734 (A-W05 D12b follow-up): list_org_documents and list_deliverable_templates
// page their rows and keep the long text fields behind includeDetails.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const docs = vi.hoisted(() => ({ listDocuments: vi.fn(), updateDocument: vi.fn(), supersedeDocument: vi.fn() }));
vi.mock('./orgDocumentService', () => docs);
const tpl = vi.hoisted(() => ({ listTemplateSets: vi.fn() }));
vi.mock('./deliverableTemplateService', async (orig) => ({
  ...(await orig<typeof import('./deliverableTemplateService')>()),
  listTemplateSets: tpl.listTemplateSets,
}));
vi.mock('./serviceDeliverableService', async (orig) => ({ ...(await orig<typeof import('./serviceDeliverableService')>()) }));

import { registerDeliverableTools } from './aiToolsDeliverables';
import { toolInputSchemas } from './aiToolSchemas';
import { expectDefaultPageFits } from './aiToolOutputBudget.testkit';
import type { AiTool } from './aiTools';

const ORG = '11111111-1111-4111-8111-111111111111';
const partnerAuth = {
  user: { id: 'u1', email: 'u1@example.com' }, scope: 'partner', partnerId: 'p1',
  partnerOrgAccess: 'selected', accessibleOrgIds: [ORG],
} as never;
const tools = new Map<string, AiTool>();
registerDeliverableTools(tools);
const raw = (name: string, input: Record<string, unknown>) => tools.get(name)!.handler(input, partnerAuth);
const call = async (name: string, input: Record<string, unknown>) => JSON.parse(await raw(name, input));
const uuid = (i: number, tag = '1111') => `${String(i).padStart(8, '0')}-${tag}-4111-8111-111111111111`;
const propsOf = (name: string) =>
  (tools.get(name)!.definition.input_schema as { properties: Record<string, { description?: string }> }).properties;

async function walk(name: string, input: Record<string, unknown>, key: string): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const out = await call(name, { ...input, ...(cursor ? { cursor } : {}) });
    seen.push(...(out[key] as Array<{ id: string }>).map((r) => r.id));
    if (!out.hasMore) { expect(out.nextCursor).toBeNull(); return seen; }
    cursor = out.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

// ── list_org_documents ───────────────────────────────────────────────────────

function documentRow(i: number) {
  return {
    id: uuid(i), orgId: ORG, title: `Quarterly firewall configuration baseline export ${i}`,
    description: 'Exported from the edge firewall after the change window; covers NAT, ACLs and VPN tunnels. '.repeat(3),
    category: 'baseline', contentType: 'application/pdf', byteSize: 248_112 + i,
    sha256: 'a'.repeat(64), originalFilename: `fw-baseline-2026-q${(i % 4) + 1}-${i}.pdf`,
    uploadedByUserId: uuid(i, '2222'), portalVisible: i % 2 === 0,
    supersedesDocumentId: i > 0 ? uuid(i - 1) : null, supersededByDocumentId: null,
    createdAt: '2026-09-20T10:00:00.000Z',
  };
}

describe('list_org_documents output shape (#6734)', () => {
  const all = Array.from({ length: 80 }, (_, i) => documentRow(i));
  beforeEach(() => { vi.clearAllMocks(); docs.listDocuments.mockResolvedValue(all); });

  it('declares limit/offset/cursor with the shared text on the registry and Zod surfaces', () => {
    expect(propsOf('list_org_documents').limit!.description).toBe('Max results (default 15, max 100)');
    expect(propsOf('list_org_documents').cursor).toBeDefined();
    expect(Object.keys((toolInputSchemas.list_org_documents as unknown as { shape: Record<string, unknown> }).shape)).toEqual(expect.arrayContaining(['limit', 'offset', 'cursor', 'includeDetails']));
  });

  it('a default page fits the chat budget uncompacted, carries the envelope, and omits the long fields', async () => {
    const r = await raw('list_org_documents', { orgId: ORG });
    expectDefaultPageFits('list_org_documents', r);
    const out = JSON.parse(r);
    expect(out).toMatchObject({ showing: 15, limit: 15, offset: 0, total: 80, hasMore: true });
    expect(out.documents[0]).toMatchObject({ id: all[0]!.id, title: all[0]!.title, category: 'baseline', byteSize: all[0]!.byteSize, portalVisible: true });
    expect(out.documents[0]).not.toHaveProperty('description');
    expect(out.documents[0]).not.toHaveProperty('sha256');
  });

  it('includeDetails adds description, sha256 and uploader', async () => {
    const out = await call('list_org_documents', { orgId: ORG, includeDetails: true, limit: 1 });
    expect(out.documents[0]).toMatchObject({ description: all[0]!.description, sha256: all[0]!.sha256, uploadedByUserId: all[0]!.uploadedByUserId });
  });

  it('following nextCursor returns every document exactly once', async () => {
    expect(await walk('list_org_documents', { orgId: ORG }, 'documents')).toEqual(all.map((d) => d.id));
  });

  it('passes includeSuperseded through to the service after the fingerprint rename', async () => {
    await call('list_org_documents', { orgId: ORG, includeSuperseded: true, category: 'runbook' });
    expect(docs.listDocuments).toHaveBeenLastCalledWith(ORG, { category: 'runbook', includeSuperseded: true }, expect.anything());
  });

  it('an offset past the end returns an empty final page', async () => {
    expect(await call('list_org_documents', { orgId: ORG, offset: 500 })).toMatchObject({ documents: [], showing: 0, total: 80, hasMore: false, nextCursor: null });
  });

  it('refuses a cursor replayed across includeSuperseded or category (both change which rows are listed)', async () => {
    const first = await call('list_org_documents', { orgId: ORG });
    expect(await call('list_org_documents', { orgId: ORG, includeSuperseded: true, cursor: first.nextCursor })).toMatchObject({ code: 'CURSOR_MISMATCH' });
    expect(await call('list_org_documents', { orgId: ORG, category: 'runbook', cursor: first.nextCursor })).toMatchObject({ code: 'CURSOR_MISMATCH' });
    expect(await call('list_org_documents', { orgId: ORG, includeDetails: true, cursor: first.nextCursor })).toHaveProperty('documents');
  });
});

// ── list_deliverable_templates ───────────────────────────────────────────────

function templateSet(i: number, itemCount = 8) {
  return {
    id: uuid(i), orgId: null, partnerId: 'p1', ownerScope: 'partner',
    name: `Managed security services — tier ${i}`, description: 'Standard recurring obligations for the managed security tier. '.repeat(2),
    createdBy: uuid(i, '3333'), createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
    items: Array.from({ length: itemCount }, (_, j) => ({
      id: uuid(i * 100 + j, '4444'), setId: uuid(i), orgId: null, partnerId: 'p1',
      name: `Quarterly vulnerability scan review ${j}`, description: 'Review the quarterly scan with the customer. '.repeat(3),
      cadence: 'quarterly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve',
      instructions: 'Export the scan, annotate every critical finding, attach the remediation ticket list. '.repeat(5),
      checklistTemplateId: uuid(j, '5555'), sortOrder: j, autoEvidenceReportType: 'vulnerability_summary', portalVisible: true,
      createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z',
    })),
  };
}

describe('list_deliverable_templates output shape (#6734)', () => {
  const all = Array.from({ length: 30 }, (_, i) => templateSet(i));
  beforeEach(() => { vi.clearAllMocks(); tpl.listTemplateSets.mockResolvedValue(all); });

  it('declares limit/offset/cursor with the shared text on the registry and Zod surfaces', () => {
    expect(propsOf('list_deliverable_templates').limit!.description).toBe('Max results (default 4, max 50)');
    expect(Object.keys((toolInputSchemas.list_deliverable_templates as unknown as { shape: Record<string, unknown> }).shape)).toEqual(expect.arrayContaining(['limit', 'offset', 'cursor', 'includeDetails']));
  });

  it('a default page of realistic sets fits the chat budget uncompacted and keeps item instructions opt-in', async () => {
    const r = await raw('list_deliverable_templates', {});
    expectDefaultPageFits('list_deliverable_templates', r);
    const out = JSON.parse(r);
    expect(out).toMatchObject({ showing: 4, total: 30, hasMore: true });
    const set = out.sets[0];
    expect(set).toMatchObject({ id: all[0]!.id, name: all[0]!.name, ownerScope: 'partner', itemCount: 8 });
    expect(set.items[0]).toEqual({ name: all[0]!.items[0]!.name, cadence: 'quarterly', leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve' });
    expect(set.items[0]).not.toHaveProperty('instructions');
    expect(set.items[0]).not.toHaveProperty('description');
  });

  it('includeDetails returns item instructions and descriptions', async () => {
    const out = await call('list_deliverable_templates', { includeDetails: true, limit: 1 });
    expect(out.sets[0].items[0]).toMatchObject({ id: all[0]!.items[0]!.id, instructions: all[0]!.items[0]!.instructions, description: all[0]!.items[0]!.description, checklistTemplateId: all[0]!.items[0]!.checklistTemplateId });
  });

  it('following nextCursor returns every set exactly once', async () => {
    expect(await walk('list_deliverable_templates', {}, 'sets')).toEqual(all.map((s) => s.id));
  });

  it('refuses a cursor replayed against a different orgId filter', async () => {
    const first = await call('list_deliverable_templates', {});
    expect(await call('list_deliverable_templates', { orgId: ORG, cursor: first.nextCursor })).toMatchObject({ code: 'CURSOR_MISMATCH' });
  });
});
