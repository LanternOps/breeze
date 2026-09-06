/**
 * #5107 — a pre-tool-use decision that HANDS THE ACTION OFF to the durable
 * approval worker is not a tool failure.
 *
 * The gate (`createSessionPreToolUse`) returns `allowed: false` for it because
 * this session must not run the tool — but the action IS approved and IS
 * executing. Publishing that as `isError: true` is what painted
 * `MANAGE_SERVICES · FAILED` in deny-red on the phone right after the user
 * approved.
 *
 * These tests pin the conversion in `aiAgentSdkTools.ts`: a denial carrying
 * `handoff` becomes an `isError: false` result whose payload carries the
 * machine-readable `status`, while an ordinary denial is untouched.
 */
import { describe, expect, it, vi } from 'vitest';
import { wrapExtraToolWithHooks } from './aiAgentSdkTools';
import type { SdkTool } from './aiAgents/outcomeTools';
import { APPROVED_EXECUTING_MESSAGE, APPROVED_EXECUTING_STATUS } from './aiToolHandoff';

function toolThatMustNotRun(ran: { called: boolean }): SdkTool {
  return {
    name: 'manage_services',
    description: 'restart a service',
    inputSchema: {},
    handler: async () => {
      ran.called = true;
      return { content: [{ type: 'text' as const, text: '{}' }] };
    },
  } as unknown as SdkTool;
}

function firstText(result: { content?: unknown[] }): string {
  const block = (result.content ?? [])[0] as { text?: string } | undefined;
  return block?.text ?? '';
}

describe('pre-tool-use approval handoff (#5107)', () => {
  it('publishes an approved-executing handoff as a NON-error result', async () => {
    const ran = { called: false };
    const post = vi.fn();
    const wrapped = wrapExtraToolWithHooks(
      toolThatMustNotRun(ran),
      async () => ({
        allowed: false as const,
        error: APPROVED_EXECUTING_MESSAGE,
        handoff: APPROVED_EXECUTING_STATUS,
      }),
      post,
    );

    const result = await wrapped.handler({ serviceName: 'spooler' }, {});

    // The user approved: this is not a failure.
    expect(result.isError).toBe(false);
    // ...and the client gets a machine-readable status, not a string to sniff.
    const payload = JSON.parse(firstText(result));
    expect(payload.status).toBe('approved_executing');
    expect(payload.error).toBeUndefined();
    expect(payload.message).toBe(APPROVED_EXECUTING_MESSAGE);
    // The tool itself still must not run inline — the worker owns it.
    expect(ran.called).toBe(false);
    // postToolUse (which drives the SSE tool_result, the ledger row and the
    // audit event) must be told it is NOT an error.
    expect(post).toHaveBeenCalledWith(
      'manage_services',
      { serviceName: 'spooler' },
      expect.stringContaining('approved_executing'),
      false,
      0,
      undefined,
    );
  });

  it('leaves an ordinary denial as a failure', async () => {
    const ran = { called: false };
    const post = vi.fn();
    const wrapped = wrapExtraToolWithHooks(
      toolThatMustNotRun(ran),
      async () => ({ allowed: false as const, error: 'Tool execution was rejected, cancelled, or expired' }),
      post,
    );

    const result = await wrapped.handler({ serviceName: 'spooler' }, {});

    expect(result.isError).toBe(true);
    const payload = JSON.parse(firstText(result));
    expect(payload.error).toBe('Tool execution was rejected, cancelled, or expired');
    expect(payload.status).toBeUndefined();
    expect(ran.called).toBe(false);
    expect(post).toHaveBeenCalledWith(
      'manage_services',
      { serviceName: 'spooler' },
      expect.any(String),
      true,
      0,
      undefined,
    );
  });
});
