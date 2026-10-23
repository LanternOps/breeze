import { beforeEach, describe, expect, it, vi } from 'vitest';

const compact = vi.hoisted(() => vi.fn((_name: string, raw: string) => `COMPACT:${raw}`));
vi.mock('./aiToolOutput', () => ({ compactToolResultForChat: compact }));
const secretBearing = vi.hoisted(() => vi.fn((_n: string) => false));
vi.mock('./actionIntents/secretBearingTools', () => ({ isSecretBearingTool: secretBearing }));
const sealed = vi.hoisted(() => vi.fn((_r: Record<string, unknown>) => false));
vi.mock('./actionIntents/resultSecrets', () => ({ hasSealedTemporaryPassword: sealed }));

import {
  MCP_CANCEL_ACTION_TOOL_LIST_ENTRY,
  MCP_CANCEL_ACTION_TOOL_NAME,
  MCP_GET_ACTION_STATUS_TOOL_LIST_ENTRY,
  MCP_GET_ACTION_STATUS_TOOL_NAME,
  buildPendingApprovalResult,
  isIntentOutcomeUncertain,
  mapIntentStatus,
  mcpApprovalUrl,
  toMcpActionStatus,
} from './mcpActionStatus';

const ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://app.example.com/';
const mk = (over: Record<string, unknown> = {}) =>
  ({
    id: ID,
    status: 'pending_approval',
    actionName: 'manage_quotes',
    approvalScope: 'four_eyes',
    expiresAt: new Date('2026-10-23T00:00:00.000Z'),
    result: null,
    errorCode: null,
    executedAt: null,
    ...over,
  }) as never;

beforeEach(() => {
  compact.mockClear();
  secretBearing.mockReset().mockReturnValue(false);
  sealed.mockReset().mockReturnValue(false);
});

describe('mapIntentStatus', () => {
  it.each([
    ['pending_approval', 'pending_approval'],
    ['approved', 'in_progress'],
    ['executing', 'in_progress'],
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['rejected', 'rejected'],
    ['expired', 'expired'],
    ['cancelled', 'cancelled'],
  ])('maps %s -> %s', (s, e) => expect(mapIntentStatus(s as never)).toBe(e));
});

describe('toMcpActionStatus', () => {
  it('projects identity, scope, ISO expiry and approval URL', () => {
    expect(toMcpActionStatus(mk(), BASE)).toEqual({
      actionId: ID,
      status: 'pending_approval',
      toolName: 'manage_quotes',
      approvalScope: 'four_eyes',
      expiresAt: '2026-10-23T00:00:00.000Z',
      approvalUrl: `https://app.example.com/approvals#intent-${ID}`,
    });
  });

  it('completed carries the result compacted under the ORIGINAL action name', () => {
    const s = toMcpActionStatus(mk({ status: 'completed', result: { ok: 1 } }), BASE);
    expect(compact).toHaveBeenCalledWith('manage_quotes', JSON.stringify({ ok: 1 }));
    expect(s.result).toBe('COMPACT:{"ok":1}');
    expect(s.resultWithheld).toBeUndefined();
  });

  it('withholds a result for a secret-bearing tool (even after the marker is burned)', () => {
    secretBearing.mockReturnValue(true);
    const s = toMcpActionStatus(mk({ status: 'completed', result: { ok: 1 } }), BASE);
    expect(s.result).toBeUndefined();
    expect(s.resultWithheld).toBe('secret_bearing');
    expect(compact).not.toHaveBeenCalled();
  });

  it('withholds for a secret-bearing tool whose stored result was nulled after burn', () => {
    secretBearing.mockReturnValue(true);
    const s = toMcpActionStatus(mk({ status: 'completed', result: null }), BASE);
    expect(s.resultWithheld).toBe('secret_bearing');
    expect(s.result).toBeUndefined();
  });

  it('withholds a result carrying a sealed temporary password', () => {
    sealed.mockReturnValue(true);
    const s = toMcpActionStatus(mk({ status: 'completed', result: { x: 1 } }), BASE);
    expect(s.result).toBeUndefined();
    expect(s.resultWithheld).toBe('secret_bearing');
  });

  it('non-completed statuses never carry a result', () => {
    const s = toMcpActionStatus(mk({ status: 'executing', result: { ok: 1 } }), BASE);
    expect(s.status).toBe('in_progress');
    expect(s.result).toBeUndefined();
  });

  it('failed carries errorCode and flags an uncertain outcome', () => {
    const s = toMcpActionStatus(
      mk({ status: 'failed', errorCode: 'execution_error', executedAt: new Date() }),
      BASE,
    );
    expect(s).toMatchObject({ status: 'failed', errorCode: 'execution_error', outcomeUncertain: true });
    const clean = toMcpActionStatus(mk({ status: 'failed', errorCode: 'x' }), BASE);
    expect(clean.outcomeUncertain).toBeUndefined();
  });
});

describe('isIntentOutcomeUncertain', () => {
  it.each([
    [{ status: 'failed', errorCode: 'e', executedAt: new Date() }, true],
    [{ status: 'failed', errorCode: 'execution_lost', executedAt: null }, true],
    [{ status: 'failed', errorCode: 'e', executedAt: null }, false],
    [{ status: 'completed', errorCode: null, executedAt: new Date() }, false],
  ])('%j -> %s', (i, e) => expect(isIntentOutcomeUncertain(i as never)).toBe(e));
});

describe('buildPendingApprovalResult', () => {
  it('is a normal result: isError absent, structuredContent.next names get_action_status', () => {
    const status = toMcpActionStatus(mk(), BASE);
    const r = buildPendingApprovalResult(status);
    expect('isError' in r).toBe(false);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.text).toContain('get_action_status');
    expect(r.content[0]?.text).toContain(ID);
    expect(r.structuredContent).toEqual({
      ...status,
      next: 'Call get_action_status with this actionId; do not re-issue the call.',
    });
  });
});

describe('mcpApprovalUrl', () => {
  it('carries only the intent id and strips trailing slashes', () => {
    expect(mcpApprovalUrl('https://app.example.com/', ID)).toBe(`https://app.example.com/approvals#intent-${ID}`);
    expect(mcpApprovalUrl('https://app.example.com//', ID)).toBe(`https://app.example.com/approvals#intent-${ID}`);
  });
});

describe('intrinsic tool list entries', () => {
  it('get_action_status is read-only and requires actionId', () => {
    const e = MCP_GET_ACTION_STATUS_TOOL_LIST_ENTRY as any;
    expect(e.name).toBe(MCP_GET_ACTION_STATUS_TOOL_NAME);
    expect(e.annotations.readOnlyHint).toBe(true);
    expect(e.inputSchema).toMatchObject({ required: ['actionId'], additionalProperties: false });
    expect(e.inputSchema.properties.actionId).toMatchObject({ type: 'string', format: 'uuid' });
    expect(e._meta['app.breeze/domain']).toBe('core');
  });
  it('cancel_action is a truthful idempotent non-destructive write', () => {
    const e = MCP_CANCEL_ACTION_TOOL_LIST_ENTRY as any;
    expect(e.name).toBe(MCP_CANCEL_ACTION_TOOL_NAME);
    expect(e.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
  });
});
