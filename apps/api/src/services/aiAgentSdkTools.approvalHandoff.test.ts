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
import { __test__, wrapExtraToolWithHooks } from './aiAgentSdkTools';
import type { SdkTool } from './aiAgents/outcomeTools';
import {
  APPROVED_COMPLETED_MESSAGE,
  APPROVED_COMPLETED_STATUS,
  APPROVED_EXECUTING_MESSAGE,
  APPROVED_EXECUTING_STATUS,
  APPROVED_FAILED_STATUS,
  describeIntentOutcome,
  handoffDenialForOutcome,
} from './aiToolHandoff';

const { makeHandler, makeSessionAwareHandler } = __test__;

const fakeAuth = {
  scope: 'organization',
  orgId: 'org-1',
  accessibleOrgIds: ['org-1'],
  partnerId: 'partner-1',
  user: { id: 'user-1' },
} as never;
const fakeSession = { breezeSessionId: 'sess-1', auth: fakeAuth } as never;

const handoffDecision = async () => ({
  allowed: false as const,
  error: APPROVED_EXECUTING_MESSAGE,
  handoff: APPROVED_EXECUTING_STATUS,
});

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
      // The TRUSTED channel: postToolUse stamps the audit row and the SSE
      // event from this argument, never by re-reading the output payload.
      'approved_executing',
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
      undefined,
    );
  });

  // `preToolUseDenialResult` is called from THREE near-identical blocks —
  // makeHandler, makeSessionAwareHandler and wrapExtraToolWithHooks. The
  // wrapper above covers only the third, and `manage_services` (the tool in
  // the bug recording) is registered through makeHandler. Without these, a
  // future "simplification" of one block could hard-code `isError: true`
  // again and every other test in this PR would stay green.
  describe.each([
    [
      'makeHandler',
      () =>
        makeHandler('manage_services', () => fakeAuth, handoffDecision, vi.fn()),
    ],
    [
      'makeSessionAwareHandler',
      () =>
        makeSessionAwareHandler(
          'm365_disable_user',
          () => fakeAuth,
          () => fakeSession,
          async () => {
            throw new Error('[test] the tool handler must never run on a handoff');
          },
          handoffDecision,
          vi.fn(),
        ),
    ],
  ])('%s routes a handoff through the same non-error path', (_name, build) => {
    it('returns isError:false with the machine-readable status', async () => {
      const result = (await build()({ serviceName: 'spooler' })) as {
        content?: unknown[];
        isError?: boolean;
      };

      expect(result.isError).toBe(false);
      const payload = JSON.parse(firstText(result));
      expect(payload.status).toBe('approved_executing');
      expect(payload.error).toBeUndefined();
    });
  });
});

/**
 * #6022 — the read-back outcomes ride the SAME channel, so `isError` must be
 * derived from the STATUS, not from "a handoff marker is present".
 *
 * The regression this guards is the issue itself pointing the other way: if
 * `approved_failed` were published with `isError: false` because it carries a
 * handoff marker, the chat would paint a guardrail refusal as "Approved ·
 * running" all over again.
 */
describe('post-approval terminal outcomes (#6022)', () => {
  const guardrail =
    'Arming autoInstall requires a human operator with devices.execute and MFA; the AI agent cannot arm software installation.';

  it('publishes a FAILED outcome as isError:true carrying the refusal', async () => {
    const ran = { called: false };
    const post = vi.fn();
    const denial = handoffDenialForOutcome(
      describeIntentOutcome({ status: 'failed', errorCode: 'tool_returned_error', result: { error: guardrail } }),
    );
    const wrapped = wrapExtraToolWithHooks(toolThatMustNotRun(ran), async () => denial, post);

    const result = await wrapped.handler({ autoInstall: true }, {});

    expect(result.isError).toBe(true);
    const payload = JSON.parse(firstText(result));
    expect(payload.status).toBe(APPROVED_FAILED_STATUS);
    expect(payload.message).toContain(guardrail);
    // Still must not run inline — the worker already ran (and refused) it.
    expect(ran.called).toBe(false);
    expect(post).toHaveBeenCalledWith(
      'manage_services',
      { autoInstall: true },
      expect.stringContaining(APPROVED_FAILED_STATUS),
      true,
      0,
      undefined,
      APPROVED_FAILED_STATUS,
    );
  });

  it('publishes a COMPLETED outcome as isError:false without leaking the stored result', async () => {
    const ran = { called: false };
    const post = vi.fn();
    const denial = handoffDenialForOutcome(
      describeIntentOutcome({ status: 'completed', errorCode: null, result: { tempPassword: 'hunter2' } }),
    );
    const wrapped = wrapExtraToolWithHooks(toolThatMustNotRun(ran), async () => denial, post);

    const result = await wrapped.handler({}, {});

    expect(result.isError).toBe(false);
    const payload = JSON.parse(firstText(result));
    expect(payload.status).toBe(APPROVED_COMPLETED_STATUS);
    expect(payload.message).toBe(APPROVED_COMPLETED_MESSAGE);
    expect(firstText(result)).not.toContain('hunter2');
    expect(ran.called).toBe(false);
  });

  it('keeps the still-running outcome a non-error', async () => {
    const wrapped = wrapExtraToolWithHooks(
      toolThatMustNotRun({ called: false }),
      async () => handoffDenialForOutcome(describeIntentOutcome(null)),
      vi.fn(),
    );

    const result = await wrapped.handler({}, {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(firstText(result)).message).toBe(APPROVED_EXECUTING_MESSAGE);
  });
});
