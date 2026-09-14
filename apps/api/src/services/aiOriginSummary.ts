import { and, desc, eq, sql } from 'drizzle-orm';
import type { AiOriginSummaryDto } from '@breeze/shared';
import { isAiInitiatorKind } from '@breeze/shared';
import { db } from '../db';
import { auditLogs, aiAgentRuns, aiAgents, deviceCommands, devices, scriptExecutions } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { getSession } from './aiAgent';
import { runSiteScopeCondition } from './aiAgentRunSiteScope';

const KIND_LABEL: Record<'ai_assistant' | 'ai_agent', string> = {
  ai_assistant: 'AI assistant',
  ai_agent: 'AI agent',
};

/**
 * The source row either doesn't exist, or doesn't belong to the given
 * device, or is outside the caller's tenant visibility (RLS). Distinguished
 * from a row that legitimately carries no AI marker (which resolves to
 * `null`, a normal 200) so the route can 404 instead of leaking "an origin
 * exists here but resolves to nothing" for an id the caller can't reach.
 */
export class AiOriginSourceNotFoundError extends Error {
  constructor() {
    super('AI origin source row not found on this device');
    this.name = 'AiOriginSourceNotFoundError';
  }
}

/**
 * Resolve one execution's or command's AI origin into a summary the CALLER is
 * allowed to see (#5022 W02, spec OD-9 A).
 *
 * The headline risk this closes: treating a provenance pointer as permission
 * to disclose its target. Device history can move tenants while agent-run
 * history stays behind, and transcripts are owner-private (`aiAgent.ts:229`).
 * So the id is authorized against the ORIGIN OBJECT'S OWN rules — `getSession`
 * for a session, the run's own org/site visibility for a run — and OMITTED
 * from the DTO when that check fails. Never returned-and-hidden client-side.
 *
 * The KIND is always disclosed when a marker exists: knowing "an AI did this"
 * is exactly what the device page is for, and it reveals nothing about whose
 * conversation it was.
 */
export async function resolveAiOriginSummary(
  auth: AuthContext,
  source: { kind: 'execution' | 'command'; id: string; deviceId: string },
): Promise<AiOriginSummaryDto | null> {
  const row = await loadSourceRow(source);
  if (!row) throw new AiOriginSourceNotFoundError();
  if (!isAiInitiatorKind(row.aiInitiatorKind)) return null;

  const kind = row.aiInitiatorKind;
  let label: string = KIND_LABEL[kind];
  let resolvable = false;
  let session: { id: string } | undefined;
  let agentRun: { id: string } | undefined;

  // `kind` is the discriminator (same convention as `deserializeAiOrigin` in
  // packages/shared/src/types/aiOrigin.ts): an `ai_assistant` origin resolves
  // its session, an `ai_agent` origin resolves its run. Nothing in the schema
  // stops both aiSessionId and aiAgentRunId being non-null on the same row
  // (#5022 W02 code review finding), and checking both independently would
  // let a dual-marker row silently mix an agent-run label with a
  // session-open link (or vice versa) depending on which branch ran last —
  // an inconsistency nobody decided on. Branching on `kind` instead makes the
  // resolved id always match the disclosed kind.
  if (kind === 'ai_assistant' && row.aiSessionId) {
    // Owner-bound by default (SR5-09 / OD-9 A) — NEVER allowAnyOwnerInOrg
    // here. A technician with devices:read does not thereby get transcript
    // access; only the session's own owner does.
    const sessionRow = await getSession(row.aiSessionId, auth);
    if (sessionRow) {
      session = { id: sessionRow.id };
      resolvable = true;
      if (sessionRow.title) label = sessionRow.title;
    }
  } else if (kind === 'ai_agent' && row.aiAgentRunId) {
    const runRow = await loadAgentRunRow(row.aiAgentRunId, auth);
    if (runRow) {
      agentRun = { id: runRow.id };
      resolvable = true;
      if (runRow.agentName) label = runRow.agentName;
    }
  }

  return {
    kind,
    label,
    occurredAt: row.createdAt.toISOString(),
    toolName: await loadToolName(source),
    resolvable,
    ...(session ? { session } : {}),
    ...(agentRun ? { agentRun } : {}),
  };
}

type SourceRow = {
  aiInitiatorKind: string | null;
  aiSessionId: string | null;
  aiAgentRunId: string | null;
  createdAt: Date;
};

async function loadSourceRow(source: {
  kind: 'execution' | 'command';
  id: string;
  deviceId: string;
}): Promise<SourceRow | null> {
  if (source.kind === 'execution') {
    // script_executions carries its own org_id and is RLS-enforced under the
    // caller's request-scoped db context — no explicit org condition needed.
    const [row] = await db
      .select({
        aiInitiatorKind: scriptExecutions.aiInitiatorKind,
        aiSessionId: scriptExecutions.aiSessionId,
        aiAgentRunId: scriptExecutions.aiAgentRunId,
        createdAt: scriptExecutions.createdAt,
      })
      .from(scriptExecutions)
      .where(and(eq(scriptExecutions.id, source.id), eq(scriptExecutions.deviceId, source.deviceId)))
      .limit(1);
    return row ?? null;
  }

  // device_commands is deliberately system-scoped (no org_id of its own — see
  // its schema comment), so the org check happens via the join to devices.
  const [row] = await db
    .select({
      aiInitiatorKind: deviceCommands.aiInitiatorKind,
      aiSessionId: deviceCommands.aiSessionId,
      aiAgentRunId: deviceCommands.aiAgentRunId,
      createdAt: deviceCommands.createdAt,
    })
    .from(deviceCommands)
    .innerJoin(devices, eq(deviceCommands.deviceId, devices.id))
    .where(and(eq(deviceCommands.id, source.id), eq(deviceCommands.deviceId, source.deviceId)))
    .limit(1);
  return row ?? null;
}

async function loadAgentRunRow(
  agentRunId: string,
  auth: AuthContext,
): Promise<{ id: string; agentName: string | null } | null> {
  const conditions = [eq(aiAgentRuns.id, agentRunId)];
  const orgCondition = auth.orgCondition(aiAgentRuns.orgId);
  if (orgCondition) conditions.push(orgCondition);
  const siteCondition = runSiteScopeCondition(auth);
  if (siteCondition) conditions.push(siteCondition);

  const [row] = await db
    .select({ id: aiAgentRuns.id, agentName: aiAgents.name })
    .from(aiAgentRuns)
    .innerJoin(aiAgents, eq(aiAgentRuns.agentId, aiAgents.id))
    .where(and(...conditions))
    .limit(1);
  return row ?? null;
}

/**
 * Best-effort lookup of the `ai.script.executed` / `ai.command.executed`
 * audit row's `details.toolName`, when one was recorded. Audit emission is
 * fire-and-forget (OD-10 A) — a missing or failing lookup must never fail the
 * summary, it just leaves `toolName: null`.
 */
async function loadToolName(source: { kind: 'execution' | 'command'; id: string; deviceId: string }): Promise<string | null> {
  try {
    const detailsKey = source.kind === 'execution' ? 'executionId' : 'commandId';
    const [row] = await db
      .select({ details: auditLogs.details })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceType, 'device'),
          eq(auditLogs.resourceId, source.deviceId),
          sql`${auditLogs.details} ->> ${detailsKey} = ${source.id}`,
        ),
      )
      .orderBy(desc(auditLogs.timestamp))
      .limit(1);
    const details = row?.details as { toolName?: unknown } | null | undefined;
    return typeof details?.toolName === 'string' ? details.toolName : null;
  } catch (err) {
    // Best-effort per OD-10 A — never fail the summary over this. But a BARE
    // swallow here would make a real regression (RLS permission-denied on
    // audit_logs, a malformed query after a future edit, a DB outage)
    // observationally identical to "no audit row was ever written," forever,
    // with nothing in logs or Sentry (#5022 W02 code review finding). Log it;
    // still return null.
    console.error('[aiOriginSummary] audit toolName lookup failed', {
      deviceId: source.deviceId,
      sourceKind: source.kind,
      sourceId: source.id,
      err,
    });
    return null;
  }
}
