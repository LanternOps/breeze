/**
 * Tool Catalog W05 (#5220), plan Task B3 / Decision 14 — the `notify` built-in
 * step (Tier 2): a short notice to a notification channel. At most
 * FLOW_RUN_LIMITS.notifyPerRunMax per run (a policy failure, not onFailure's).
 */
import { FLOW_RUN_LIMITS } from '@breeze/shared';
import { sendChannelMessage } from '../../notificationSenders/channelMessage';
import type { StepOutcome } from '../stepExecutor';
import type { BuiltinContext } from './types';

export async function executeNotifyStep(
  input: { channelId: string; title: string; message: string; severity: 'info' | 'warning' | 'critical' },
  ctx: BuiltinContext,
): Promise<StepOutcome> {
  const max = FLOW_RUN_LIMITS.notifyPerRunMax;
  if (ctx.counters.notify > max) {
    return { kind: 'failed', code: 'notify_failed', message: `A flow run may send at most ${max} notices per run.`, policy: true };
  }
  const result = await sendChannelMessage(
    input.channelId,
    { title: input.title, body: input.message, severity: input.severity, link: `/flows/${ctx.run.flowId}` },
    ctx.owner,
  );
  if (!result.ok) return { kind: 'failed', code: 'notify_failed', message: result.message, policy: false };
  return { kind: 'completed', output: { channelId: input.channelId, sent: true }, truncated: false };
}
