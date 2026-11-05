import { describe, it, expect } from 'vitest';
import {
  FLOW_RUN_STATUSES,
  FLOW_RUN_ACTIVE_STATUSES,
  FLOW_STEP_ERROR_CODES,
  FLOW_RUN_ERROR_CODES,
  FLOW_PAUSED_REASONS,
  FLOW_RUN_LIMITS,
  FLOW_TRIGGER_KINDS,
  FLOW_TRIGGERED_VIA,
  flowEnableRequestSchema,
  flowManualRunRequestSchema,
  isTerminalFlowRunStatus,
} from './flowRuns';

describe('isTerminalFlowRunStatus', () => {
  it('is true for exactly completed|failed|cancelled|expired', () => {
    const terminal = FLOW_RUN_STATUSES.filter((s) => isTerminalFlowRunStatus(s));
    expect([...terminal].sort()).toEqual(['cancelled', 'completed', 'expired', 'failed']);
  });

  it('active statuses are never terminal', () => {
    for (const s of FLOW_RUN_ACTIVE_STATUSES) expect(isTerminalFlowRunStatus(s)).toBe(false);
  });
});

describe('error code sets', () => {
  it('step error codes are a subset of run error codes', () => {
    const run = new Set<string>(FLOW_RUN_ERROR_CODES);
    for (const c of FLOW_STEP_ERROR_CODES) expect(run.has(c)).toBe(true);
  });

  it('exposes paused reasons and limits', () => {
    expect(FLOW_PAUSED_REASONS).toContain('event_dispatch_not_durable');
    expect(FLOW_RUN_LIMITS.maxChainDepth).toBe(3);
  });
});

describe('flowEnableRequestSchema', () => {
  it('defaults preApprovedStepIds to []', () => {
    const r = flowEnableRequestSchema.parse({ expectedVersion: 1 });
    expect(r.preApprovedStepIds).toEqual([]);
  });
  it('rejects a bad step id', () => {
    expect(flowEnableRequestSchema.safeParse({ expectedVersion: 1, preApprovedStepIds: ['Bad'] }).success).toBe(false);
  });
  it('rejects 51 ids and accepts 50', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
    expect(flowEnableRequestSchema.safeParse({ expectedVersion: 1, preApprovedStepIds: ids(51) }).success).toBe(false);
    expect(flowEnableRequestSchema.safeParse({ expectedVersion: 1, preApprovedStepIds: ids(50) }).success).toBe(true);
  });
  it('rejects expectedVersion < 1', () => {
    expect(flowEnableRequestSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
  });
});

describe('flowManualRunRequestSchema', () => {
  it('defaults inputs to {}', () => {
    expect(flowManualRunRequestSchema.parse({}).inputs).toEqual({});
  });
  it("rejects idempotencyKey 'a:b'", () => {
    expect(flowManualRunRequestSchema.safeParse({ idempotencyKey: 'a:b' }).success).toBe(false);
  });
  it('accepts a valid key and rejects 65 chars / empty', () => {
    expect(flowManualRunRequestSchema.safeParse({ idempotencyKey: 'abc_DEF-1' }).success).toBe(true);
    expect(flowManualRunRequestSchema.safeParse({ idempotencyKey: 'a'.repeat(65) }).success).toBe(false);
    expect(flowManualRunRequestSchema.safeParse({ idempotencyKey: '' }).success).toBe(false);
  });
  it('rejects a non-uuid orgId', () => {
    expect(flowManualRunRequestSchema.safeParse({ orgId: 'nope' }).success).toBe(false);
  });
});

describe('W5 run contracts (#5220)', () => {
  it('FLOW_TRIGGERED_VIA lists webhook, mcp and ai_agent', () => {
    expect([...FLOW_TRIGGERED_VIA]).toEqual(['ui', 'api', 'ai_tool', 'scheduler', 'event', 'webhook', 'mcp', 'ai_agent']);
    expect([...FLOW_TRIGGER_KINDS]).toEqual(['manual', 'schedule', 'event', 'webhook', 'tool']);
  });
  it('new step error codes are run error codes too', () => {
    const fresh = ['egress_blocked', 'http_status', 'notify_failed', 'ai_budget_exhausted', 'ai_output_invalid', 'ai_token_cap_reached'];
    for (const c of fresh) {
      expect(FLOW_STEP_ERROR_CODES as readonly string[]).toContain(c);
      expect(FLOW_RUN_ERROR_CODES as readonly string[]).toContain(c);
    }
  });
  it('exposes the W5 limits', () => {
    expect(FLOW_RUN_LIMITS.webhookMaxBodyBytes).toBe(FLOW_RUN_LIMITS.maxStoredOutputBytes);
    expect(FLOW_RUN_LIMITS.webhookTimestampWindowMs).toBe(300_000);
    expect(FLOW_RUN_LIMITS.maxParallelUnitsPerProcess).toBe(20);
    expect(FLOW_RUN_LIMITS.flowToolsPerSessionMax).toBe(20);
    expect(FLOW_RUN_LIMITS.httpMaxResponseBytes).toBe(1_048_576);
  });
});

describe('W6 run contracts (#5221)', () => {
  it('W6 error codes are step and run codes', () => {
    const fresh = ['targets_over_cap', 'targets_unresolvable', 'alert_create_failed', 'script_dispatch_failed'];
    for (const c of fresh) {
      expect(FLOW_STEP_ERROR_CODES as readonly string[]).toContain(c);
      expect(FLOW_RUN_ERROR_CODES as readonly string[]).toContain(c);
    }
    // Appended after the W5 codes, so earlier codes keep their positions.
    expect(FLOW_STEP_ERROR_CODES.slice(-4)).toEqual(fresh);
  });
});
