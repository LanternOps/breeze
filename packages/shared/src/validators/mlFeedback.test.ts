import { describe, expect, it } from 'vitest';
import {
  ML_FEEDBACK_METADATA_MAX_BYTES,
  getJsonByteLength,
  mlFeedbackEventSchema,
} from './mlFeedback';

const validEvent = {
  orgId: '00000000-0000-4000-8000-000000000001',
  sourceType: 'alert',
  sourceId: '00000000-0000-4000-8000-000000000002',
  eventType: 'alert.acknowledged',
  actorUserId: '00000000-0000-4000-8000-000000000003',
  outcome: 'acknowledged',
  confidence: 0.95,
  metadata: { alertSeverity: 'high' },
  occurredAt: '2026-06-18T10:00:00.000Z',
} as const;

describe('mlFeedbackEventSchema', () => {
  it('accepts a canonical feedback event and coerces occurredAt', () => {
    const parsed = mlFeedbackEventSchema.parse(validEvent);
    expect(parsed.eventType).toBe('alert.acknowledged');
    expect(parsed.occurredAt).toBeInstanceOf(Date);
  });

  it('allows system labels without an actor user', () => {
    const parsed = mlFeedbackEventSchema.parse({
      ...validEvent,
      actorUserId: null,
      sourceType: 'anomaly',
      eventType: 'device.false_alarm',
      outcome: 'false_alarm',
    });
    expect(parsed.actorUserId).toBeNull();
  });

  it('accepts anomaly lifecycle feedback events', () => {
    const parsed = mlFeedbackEventSchema.parse({
      ...validEvent,
      sourceType: 'anomaly',
      sourceId: 'metric-anomaly-1',
      eventType: 'anomaly.promoted',
      outcome: 'promoted',
      metadata: { metricName: 'cpu_percent', anomalyType: 'spike' },
    });

    expect(parsed.sourceType).toBe('anomaly');
    expect(parsed.eventType).toBe('anomaly.promoted');
  });

  it('accepts explicit ticket triage rejection feedback', () => {
    const parsed = mlFeedbackEventSchema.parse({
      ...validEvent,
      sourceType: 'ticket',
      sourceId: 'ticket-1',
      eventType: 'ticket.triage_rejected',
      outcome: 'rejected',
      dedupeKey: 'suggestion:ticket-triage-rules-v0:high:hardware',
      metadata: { modelVersion: 'ticket-triage-rules-v0' },
    });

    expect(parsed.sourceType).toBe('ticket');
    expect(parsed.eventType).toBe('ticket.triage_rejected');
    expect(parsed.dedupeKey).toBe('suggestion:ticket-triage-rules-v0:high:hardware');
  });

  it('rejects empty semantic dedupe keys', () => {
    expect(() => mlFeedbackEventSchema.parse({ ...validEvent, dedupeKey: '' })).toThrow();
  });

  it('rejects metadata over the byte cap', () => {
    const oversized = { notes: 'x'.repeat(ML_FEEDBACK_METADATA_MAX_BYTES + 1) };
    expect(getJsonByteLength(oversized)).toBeGreaterThan(ML_FEEDBACK_METADATA_MAX_BYTES);
    expect(() => mlFeedbackEventSchema.parse({ ...validEvent, metadata: oversized })).toThrow();
  });

  it('rejects invalid confidence values', () => {
    expect(() => mlFeedbackEventSchema.parse({ ...validEvent, confidence: 1.1 })).toThrow();
    expect(() => mlFeedbackEventSchema.parse({ ...validEvent, confidence: -0.1 })).toThrow();
  });

  const NIL_UUID = '00000000-0000-0000-0000-000000000000';

  describe('nil-UUID sentinel handling (.guid lenient, not strict-RFC .uuid)', () => {
    it('accepts the nil-UUID sentinel for orgId so system labels are never silently 400-rejected', () => {
      const parsed = mlFeedbackEventSchema.parse({ ...validEvent, orgId: NIL_UUID });
      expect(parsed.orgId).toBe(NIL_UUID);
    });

    it('accepts the nil-UUID sentinel for actorUserId (system actor)', () => {
      const parsed = mlFeedbackEventSchema.parse({ ...validEvent, actorUserId: NIL_UUID });
      expect(parsed.actorUserId).toBe(NIL_UUID);
    });

    it('still rejects a non-UUID-shaped orgId', () => {
      expect(() => mlFeedbackEventSchema.parse({ ...validEvent, orgId: 'not-a-uuid' })).toThrow();
    });

    it('still rejects a non-UUID-shaped actorUserId', () => {
      expect(() => mlFeedbackEventSchema.parse({ ...validEvent, actorUserId: 'nope' })).toThrow();
    });
  });

  describe('enum rejection', () => {
    it('rejects an unknown sourceType', () => {
      expect(() => mlFeedbackEventSchema.parse({ ...validEvent, sourceType: 'spaceship' })).toThrow();
    });

    it('rejects an unknown eventType', () => {
      expect(() => mlFeedbackEventSchema.parse({ ...validEvent, eventType: 'alert.exploded' })).toThrow();
    });

    it('rejects an unknown outcome', () => {
      expect(() => mlFeedbackEventSchema.parse({ ...validEvent, outcome: 'vaporized' })).toThrow();
    });
  });

  describe('sourceId length boundaries', () => {
    it('rejects an empty sourceId', () => {
      expect(() => mlFeedbackEventSchema.parse({ ...validEvent, sourceId: '' })).toThrow();
    });

    it('accepts a sourceId at the 255-char ceiling', () => {
      const parsed = mlFeedbackEventSchema.parse({ ...validEvent, sourceId: 'a'.repeat(255) });
      expect(parsed.sourceId).toHaveLength(255);
    });

    it('rejects a sourceId one char over the ceiling', () => {
      expect(() => mlFeedbackEventSchema.parse({ ...validEvent, sourceId: 'a'.repeat(256) })).toThrow();
    });
  });
});
