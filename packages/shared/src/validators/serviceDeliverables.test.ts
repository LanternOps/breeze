import { describe, expect, it } from 'vitest';
import {
  addEvidenceSchema,
  createDeliverableSchema,
  deliverOccurrenceSchema,
  rescheduleOccurrenceSchema,
  updateDeliverableSchema,
} from './serviceDeliverables';

const base = { name: 'Sign-in log review', cadence: 'monthly', anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01' };

describe('serviceDeliverables validators', () => {
  it('accepts a minimal create payload with defaults', () => {
    const r = createDeliverableSchema.parse(base);
    expect(r.leadDays).toBe(7);
    expect(r.graceDays).toBe(14);
    expect(r.artifactRequired).toBe(true);
    expect(r.completionMode).toBe('on_ticket_resolve');
    expect(r.portalVisible).toBe(true);
  });
  it('rejects effectiveUntil before effectiveFrom', () =>
    expect(createDeliverableSchema.safeParse({ ...base, effectiveUntil: '2026-09-01' }).success).toBe(false));
  it('rejects unknown cadence and negative days', () => {
    expect(createDeliverableSchema.safeParse({ ...base, cadence: 'continuous' }).success).toBe(false);
    expect(createDeliverableSchema.safeParse({ ...base, leadDays: -1 }).success).toBe(false);
  });
  it('update forbids changing cadence (spec §16: history is not rewritten)', () =>
    expect(updateDeliverableSchema.safeParse({ cadence: 'annual' }).success).toBe(false));
  it('update forbids changing anchorDueDate and accepts active', () => {
    expect(updateDeliverableSchema.safeParse({ anchorDueDate: '2026-11-30' }).success).toBe(false);
    expect(updateDeliverableSchema.parse({ active: false })).toEqual({ active: false });
  });
  it('update still enforces the effective range', () =>
    expect(
      updateDeliverableSchema.safeParse({ effectiveFrom: '2026-10-01', effectiveUntil: '2026-09-01' }).success,
    ).toBe(false));
  it('deliver accepts note and report-run evidence refs only in W01', () => {
    expect(
      deliverOccurrenceSchema.parse({
        note: 'done',
        evidence: [{ kind: 'report_run', reportRunId: '11111111-1111-4111-8111-111111111111' }],
      }).evidence,
    ).toHaveLength(1);
    expect(
      deliverOccurrenceSchema.safeParse({
        evidence: [{ kind: 'document', documentId: '11111111-1111-4111-8111-111111111111' }],
      }).success,
    ).toBe(false);
  });
  it('addEvidence requires a guid', () =>
    expect(addEvidenceSchema.safeParse({ kind: 'report_run', reportRunId: 'nope' }).success).toBe(false));
  it('reschedule requires an ISO date', () =>
    expect(rescheduleOccurrenceSchema.safeParse({ dueAt: '31/10/2026' }).success).toBe(false));
});
