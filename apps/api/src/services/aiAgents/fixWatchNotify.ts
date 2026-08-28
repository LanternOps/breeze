/**
 * Wave 6.2a (#3828) — telling someone the fix did not hold.
 *
 * This is a SEPARATE notification, not an amendment to the run-finished one.
 * That one was already sent (and deduped on `agent-run:<runId>`) at the moment
 * the run ended, and it reported the remediation as verified. Hours later we
 * have learned it did not last; the operator needs a new thing in their inbox,
 * not a silently-edited old one.
 *
 * Best-effort throughout: a failure here must never turn a resolved watch back
 * into an unresolved one — the sweeper has already committed the verdict by the
 * time this runs.
 */
import { eq } from 'drizzle-orm';
import { alerts } from '../../db/schema/alerts';
import { aiAgents } from '../../db/schema/aiAgents';
import type { AiAgentFixWatchRow } from '../../db/schema/aiAgentFixWatches';
import { createNotification } from '../userNotifications';
import { resolveRecipientUserIds } from './recipients';
import { resolveEffectiveAgentSystem } from './effectivePolicy';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../../db';

function inSystemDbContext<T>(fn: () => Promise<T>): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

export interface NotifyFixRegressedArgs {
  watch: Pick<
    AiAgentFixWatchRow,
    'id' | 'orgId' | 'deviceId' | 'agentId' | 'runId' | 'opKey' | 'watchKind' | 'targetFingerprint'
  >;
  /** Short, human-readable — never a raw tool input/output blob. */
  detail: string;
  /** True only on the open TRANSITION, so this escalates exactly once. */
  circuitOpened: boolean;
}

/**
 * Rule-less alert for a regression, mirroring `recordActVerifyFailureAlert`'s
 * direct-insert pattern (`ruleId: null`, `status: 'active'`).
 *
 * Distinct `configItemName` from the immediate-verify alert
 * (`ai_agent_act_verify_*`) on purpose: "it never worked" and "it worked and
 * then came undone" are different operational stories and should not collapse
 * into one alert stream.
 */
async function recordRegressionAlert(args: NotifyFixRegressedArgs): Promise<void> {
  const { watch, detail, circuitOpened } = args;
  try {
    await inSystemDbContext(async () => {
      await db.insert(alerts).values({
        ruleId: null,
        deviceId: watch.deviceId,
        orgId: watch.orgId,
        configPolicyId: null,
        configItemName: `ai_agent_fix_regressed_${watch.opKey}`,
        severity: circuitOpened ? 'high' : 'medium',
        title: `Agent fix did not hold: ${watch.opKey}`,
        message: circuitOpened
          ? `A remediation this agent verified has come undone: ${detail}. Repeated failures on this target have stopped the agent from retrying it unattended.`
          : `A remediation this agent verified has come undone: ${detail}.`,
        context: {
          source: 'ai_agent_fix_watch',
          watchId: watch.id,
          runId: watch.runId,
          agentId: watch.agentId,
          opKey: watch.opKey,
          watchKind: watch.watchKind,
          targetFingerprint: watch.targetFingerprint,
          circuitOpened,
        },
        status: 'active',
        triggeredAt: new Date(),
      });
    });
  } catch (error) {
    console.error('[fixWatchNotify] failed to record the regression alert (non-fatal)', {
      watchId: watch.id, error,
    });
  }
}

/**
 * Notifies the agent's configured recipients and raises the rule-less alert.
 *
 * Recipients are resolved the same way `runFinishedNotify` resolves them — via
 * the MERGED effective policy for the run's org, never the agent row's raw
 * `recipients` column, which for a partner-wide agent is the partner baseline
 * and silently drops anyone an organization added in its own override.
 */
export async function notifyFixRegressed(args: NotifyFixRegressedArgs): Promise<void> {
  const { watch, detail, circuitOpened } = args;

  await recordRegressionAlert(args);

  try {
    const [agent] = await inSystemDbContext(() => db
      .select({
        id: aiAgents.id,
        name: aiAgents.name,
        kind: aiAgents.kind,
        orgId: aiAgents.orgId,
        partnerId: aiAgents.partnerId,
      })
      .from(aiAgents)
      .where(eq(aiAgents.id, watch.agentId))
      .limit(1));
    if (!agent) return;

    // The MERGED effective policy for the WATCH's org — not the agent row's
    // raw `recipients` column. For a partner-wide agent that column is the
    // partner baseline and silently drops anyone the organization added in its
    // own override (the same trap runFinishedNotify documents).
    const resolved = await resolveEffectiveAgentSystem(watch.orgId, agent.kind);
    if (!resolved) return;

    const userIds = await resolveRecipientUserIds(
      {
        orgId: agent.orgId,
        partnerId: agent.partnerId,
        recipients: resolved.effective.recipients,
      },
      watch.orgId,
    );
    if (userIds.length === 0) {
      console.warn('[fixWatchNotify] no recipients resolved for a regressed fix', {
        watchId: watch.id,
      });
      return;
    }

    await inSystemDbContext(async () => {
      for (const userId of userIds) {
        await createNotification({
          userId,
          orgId: watch.orgId,
          type: 'ai',
          title: circuitOpened
            ? `${agent.name} stopped retrying a fix that keeps failing`
            : `${agent.name}: a fix did not hold`,
          message: detail,
          // The run-detail page (wave 6.1) is where the original remediation and
          // now its watch outcome both live.
          link: `/ai-agents/runs/${watch.runId}`,
          ...(circuitOpened ? { priority: 'high' as const } : {}),
          metadata: {
            watchId: watch.id,
            runId: watch.runId,
            agentId: watch.agentId,
            opKey: watch.opKey,
            watchKind: watch.watchKind,
            circuitOpened,
          },
          // Per WATCH, not per run: a run's own finished notification already
          // used `agent-run:<runId>`, and two watches from one run (a service
          // postcondition and an alert recurrence) are two separate findings.
          dedupeKey: `agent-fix-watch:${watch.id}`,
        });
      }
    });
  } catch (error) {
    console.error('[fixWatchNotify] failed to notify recipients of a regressed fix (non-fatal)', {
      watchId: watch.id, error,
    });
  }
}
