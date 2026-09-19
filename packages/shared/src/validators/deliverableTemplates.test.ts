import { describe, expect, it } from 'vitest';
import {
  updateTemplateItemSchema,
  createTemplateSetSchema,
  updateTemplateSetSchema,
  createTemplateItemSchema,
  applyTemplateSetSchema,
  MANAGED_EVIDENCE_REPORT_TYPES,
} from './deliverableTemplates';

const item = { name: 'Sign-in log review', cadence: 'monthly' as const };

describe('deliverableTemplates validators', () => {
  it('defaults ownerScope to organization and item knobs to the deliverable defaults', () => {
    const parsed = createTemplateSetSchema.parse({ name: 'Best plan', items: [item] });
    expect(parsed.ownerScope).toBe('organization');
    expect(parsed.items[0]!.leadDays).toBe(7);
    expect(parsed.items[0]!.graceDays).toBe(14);
    expect(parsed.items[0]!.artifactRequired).toBe(true);
    expect(parsed.items[0]!.completionMode).toBe('on_ticket_resolve');
    expect(parsed.items[0]!.sortOrder).toBe(0);
  });

  it('accepts a partner-wide set with no items', () => {
    expect(createTemplateSetSchema.parse({ name: 'Best plan', ownerScope: 'partner' }).items).toEqual([]);
  });

  it('rejects an unknown cadence and negative day counts', () => {
    expect(createTemplateItemSchema.safeParse({ ...item, cadence: 'continuous' }).success).toBe(false);
    expect(createTemplateItemSchema.safeParse({ ...item, leadDays: -1 }).success).toBe(false);
  });

  it('the update schema cannot change ownership or items (CLAUDE.md step 2)', () => {
    expect(updateTemplateSetSchema.safeParse({ ownerScope: 'partner' }).success).toBe(false);
    expect(updateTemplateSetSchema.safeParse({ orgId: '11111111-1111-4111-8111-111111111111' }).success).toBe(false);
    expect(updateTemplateSetSchema.safeParse({ items: [] }).success).toBe(false);
    expect(updateTemplateSetSchema.parse({ name: 'Best plan v2' })).toEqual({ name: 'Best plan v2' });
  });

  it('an item PATCH never resurrects the create defaults', () => {
    // .partial() does NOT strip .default(), so a defaulted field list reused
    // for the update schema would turn `PATCH { graceDays }` into a silent
    // reset of every other knob.
    expect(updateTemplateItemSchema.parse({ graceDays: 21 })).toEqual({ graceDays: 21 });
  });

  // ── #5808 W03: instructions + checklistTemplateId on the template ITEM ───
  it('createTemplateItemSchema accepts both new fields', () => {
    const parsed = createTemplateItemSchema.parse({ ...item, instructions: 'Runbook prose', checklistTemplateId: '11111111-1111-4111-8111-111111111111' });
    expect(parsed.instructions).toBe('Runbook prose');
    expect(parsed.checklistTemplateId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('updateTemplateItemSchema accepts both, still with no resurrected defaults', () => {
    expect(updateTemplateItemSchema.parse({ instructions: null, checklistTemplateId: null }))
      .toEqual({ instructions: null, checklistTemplateId: null });
    expect(updateTemplateItemSchema.parse({ checklistTemplateId: '11111111-1111-4111-8111-111111111111' }))
      .toEqual({ checklistTemplateId: '11111111-1111-4111-8111-111111111111' });
  });

  it('rejects a non-guid checklistTemplateId on both item schemas', () => {
    expect(createTemplateItemSchema.safeParse({ ...item, checklistTemplateId: 'nope' }).success).toBe(false);
    expect(updateTemplateItemSchema.safeParse({ checklistTemplateId: 'nope' }).success).toBe(false);
  });

  it('a set created with items carries the new fields through', () => {
    const parsed = createTemplateSetSchema.parse({
      name: 'Best plan',
      items: [{ ...item, instructions: 'Prose', checklistTemplateId: '11111111-1111-4111-8111-111111111111' }],
    });
    expect(parsed.items[0]!.instructions).toBe('Prose');
    expect(parsed.items[0]!.checklistTemplateId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('apply requires a setId and an ISO effectiveFrom when present', () => {
    expect(applyTemplateSetSchema.safeParse({ setId: 'nope' }).success).toBe(false);
    expect(applyTemplateSetSchema.safeParse({ setId: '11111111-1111-4111-8111-111111111111', effectiveFrom: '31/10/2026' }).success).toBe(false);
    const ok = applyTemplateSetSchema.parse({ setId: '11111111-1111-4111-8111-111111111111', effectiveFrom: '2026-10-01' });
    expect(ok.contractId).toBeUndefined();
  });
});

describe('autoEvidenceReportType (#5784 W01)', () => {
  it('accepts null and omission (no auto-evidence)', () => {
    expect(createTemplateItemSchema.parse({ name: 'x', cadence: 'monthly' }).autoEvidenceReportType).toBeUndefined();
    expect(createTemplateItemSchema.parse({ name: 'x', cadence: 'monthly', autoEvidenceReportType: null }).autoEvidenceReportType).toBeNull();
    expect(updateTemplateItemSchema.parse({ autoEvidenceReportType: null })).toEqual({ autoEvidenceReportType: null });
  });

  it('rejects a report type that is not a managed evidence type', () => {
    expect(() => createTemplateItemSchema.parse({ name: 'x', cadence: 'monthly', autoEvidenceReportType: 'device_inventory' })).toThrow();
    expect(updateTemplateItemSchema.safeParse({ autoEvidenceReportType: 'ai_org_narrative' }).success).toBe(false);
  });

  it('accepts every managed evidence type the shared list names', () => {
    // Empty in W01; W02+ fill the list and this case becomes load-bearing.
    for (const type of MANAGED_EVIDENCE_REPORT_TYPES) {
      expect(createTemplateItemSchema.parse({ name: 'x', cadence: 'monthly', autoEvidenceReportType: type }).autoEvidenceReportType).toBe(type);
    }
  });
});
