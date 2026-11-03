import { describe, it, expect } from 'vitest';
import {
  CONVERSION_MIN_SHADOW_MS,
  FLEET_MAX_TARGETS,
  FLOW_CONVERSION_FINDING_CODES,
  FLOW_CONVERSION_FINDING_SEVERITY,
  FLOW_CONVERSION_FINDING_SEVERITIES,
  conversionSwitchRequestSchema,
  fidelityOf,
  occurrenceKey,
  OCCURRENCE_KEY_RE,
  type FlowConversionFinding,
} from './flowConversions';
import { FLOW_LIMITS } from './flows';
import { FLOW_RUN_LIMITS } from './flowRuns';

const finding = (code: FlowConversionFinding['code']): FlowConversionFinding => ({
  code,
  severity: FLOW_CONVERSION_FINDING_SEVERITY[code],
  actionIndex: null,
  detail: '',
});

describe('flow conversion contracts (#5221)', () => {
  it('schedule key is UTC minute precision', () => {
    // 03:00:41.123 in UTC regardless of the host timezone
    expect(occurrenceKey.schedule(new Date('2027-01-09T03:00:41.123Z'))).toBe('schedule:2027-01-09T03:00Z');
    expect(occurrenceKey.schedule(new Date('2027-03-28T01:30:00+01:00'))).toBe('schedule:2027-03-28T00:30Z');
    expect(() => occurrenceKey.schedule(new Date('nope'))).toThrow();
  });

  it('event and webhook keys', () => {
    const id = '0f6b3c1e-8a4f-4b8e-9f2a-1d2c3b4a5e6f';
    expect(occurrenceKey.event(id)).toBe(`event:${id}`);
    expect(() => occurrenceKey.event('not-a-uuid')).toThrow();
    const digest = 'a'.repeat(64);
    expect(occurrenceKey.webhookSig(digest)).toBe(`webhook:sig:${digest}`);
    expect(() => occurrenceKey.webhookSig('A'.repeat(64))).toThrow();
    expect(() => occurrenceKey.webhookSig('a'.repeat(63))).toThrow();
  });

  it('delivery key refuses an id failing the delivery-id regex', () => {
    expect(occurrenceKey.webhookDelivery('evt_1')).toBe('webhook:dlv:evt_1');
    expect(() => occurrenceKey.webhookDelivery('evt 1')).toThrow();
    expect(() => occurrenceKey.webhookDelivery('')).toThrow();
    expect(() => occurrenceKey.webhookDelivery('x'.repeat(129))).toThrow();
  });

  it('every built key matches the DB key CHECK pattern', () => {
    const keys = [
      occurrenceKey.event('0f6b3c1e-8a4f-4b8e-9f2a-1d2c3b4a5e6f'),
      occurrenceKey.schedule(new Date('2027-01-09T03:00:00Z')),
      occurrenceKey.webhookSig('0'.repeat(64)),
      occurrenceKey.webhookDelivery('a.b:c-d_e'),
    ];
    for (const k of keys) expect(OCCURRENCE_KEY_RE.test(k)).toBe(true);
    expect(OCCURRENCE_KEY_RE.test('schedule:2027-01-09T03:00:00Z')).toBe(false);
  });

  it('fidelity: any blocker ⇒ unconvertible, any review ⇒ needs_review, else exact', () => {
    expect(fidelityOf([])).toBe('exact');
    expect(fidelityOf([finding('queued_is_success')])).toBe('exact');
    expect(fidelityOf([finding('queued_is_success'), finding('webhook_body_shape')])).toBe('needs_review');
    expect(fidelityOf([finding('webhook_body_shape'), finding('deploy_software_unmapped')])).toBe('unconvertible');
  });

  it('every finding code has a severity', () => {
    const codes = new Set<string>(FLOW_CONVERSION_FINDING_CODES);
    expect(codes.size).toBe(FLOW_CONVERSION_FINDING_CODES.length);
    expect(Object.keys(FLOW_CONVERSION_FINDING_SEVERITY).sort()).toEqual([...codes].sort());
    for (const code of FLOW_CONVERSION_FINDING_CODES) {
      expect(FLOW_CONVERSION_FINDING_SEVERITIES).toContain(FLOW_CONVERSION_FINDING_SEVERITY[code]);
    }
    expect(FLOW_CONVERSION_FINDING_SEVERITY.compliance_remediation_target).toBe('blocker');
    expect(FLOW_CONVERSION_FINDING_SEVERITY.event_filter_string_coercion).toBe('review');
    expect(FLOW_CONVERSION_FINDING_SEVERITY.duration_minutes_ignored).toBe('info');
  });

  it('switch request requires acceptDelegatorLifecycle true', () => {
    const base = { expectedFlowVersion: 1, preApprovals: [] };
    expect(conversionSwitchRequestSchema.safeParse(base).success).toBe(false);
    expect(conversionSwitchRequestSchema.safeParse({ ...base, acceptDelegatorLifecycle: false }).success).toBe(false);
    const ok = conversionSwitchRequestSchema.parse({ ...base, acceptDelegatorLifecycle: true });
    expect(ok).toMatchObject({ acceptScopeWidening: false, acknowledgeDivergence: false });
    expect(conversionSwitchRequestSchema.safeParse({ ...base, acceptDelegatorLifecycle: true, extra: 1 }).success).toBe(false);
  });

  it('maxTargets above 500 is invalid', () => {
    const req = (maxTargets: number) => ({
      expectedFlowVersion: 1,
      acceptDelegatorLifecycle: true,
      preApprovals: [{ stepId: 'a0_run_script', maxTargets }],
    });
    expect(conversionSwitchRequestSchema.safeParse(req(500)).success).toBe(true);
    expect(conversionSwitchRequestSchema.safeParse(req(501)).success).toBe(false);
    expect(conversionSwitchRequestSchema.safeParse(req(0)).success).toBe(false);
    expect(conversionSwitchRequestSchema.safeParse(req(1.5)).success).toBe(false);
  });

  it('constants agree with the flow limits they derive from', () => {
    expect(FLEET_MAX_TARGETS).toBe(FLOW_LIMITS.maxForEachItems);
    expect(CONVERSION_MIN_SHADOW_MS).toBeGreaterThan(FLOW_RUN_LIMITS.webhookTimestampWindowMs);
    expect(CONVERSION_MIN_SHADOW_MS).toBeGreaterThan(5 * 60_000);
  });
});
