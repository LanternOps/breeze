/**
 * Full-control W16 PR B (#6786, #11181): which org an intent of the two design tools
 * belongs in, and what its approval card can add to the input-only headline.
 *
 * These tools name their org through a row (a schedule, a report run), so the session
 * org is not the target. The intent has to live in the org the action changes: its
 * approvers, its stored reason and a durable release's rebuilt authority are all keyed
 * on `action_intents.org_id`, so an approver of org A would otherwise be approving a
 * change to org B and a worker release would refuse. A partner baseline has no org:
 * its intent stays in the session org, and a delete's card says how many organizations
 * lose an override. That delete's approvers are the partner-axis holders
 * (`partnerAxisApprover.ts`), not the session org's members.
 *
 * Read as system, because the row may be in an org the session is not bound to. Nothing
 * here is an access check: the callers (`createSessionPreToolUse`, `createMcpActionIntent`)
 * use a target only when the call's reach covers it, so a foreign id reveals nothing, and the handler
 * still answers not found.
 *
 * A design's names were written by a model from device evidence, and they reach a
 * person deciding whether to approve, so they are cleaned and bounded here.
 */
import { and, eq } from 'drizzle-orm';
import { fleetDesignApprovalSchema, type FleetDesignApproval, type FleetDesignOutcome, type FleetDesignReportSummary } from '@breeze/shared';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentSchedules, fleetDesignAppliedItems, reportRuns, reports } from '../../db/schema';
import { PARTNER_LEVEL_APPROVER_NOTE } from './partnerWideEffect';

export const AI_DESIGN_INTENT_TOOLS: ReadonlySet<string> = new Set(['manage_ai_agent_schedules', 'manage_fleet_designs']);

/** `FLEET_DESIGN_REPORT_TYPE`, inlined: this module sits on the chat path and must not take the report graph. */
const FLEET_DESIGN_REPORT_TYPE = 'ai_fleet_design';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AiDesignIntentTarget = {
  orgId: string | null;
  /** The owning partner of an org-less row, so the caller can tell its own from another's. */
  partnerId: string | null;
  /** Appended to the approval headline, once the target is known to be in reach. */
  cardDetail?: string;
  /** The org came from the caller's own `orgId` argument, not a stored row (#11181: out of reach refuses). */
  fromArgument?: true;
};

const asSystem = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Printable, no markup, bounded: this is a model's text on an approval card. */
function cleanName(name: unknown): string {
  return String(name ?? '').replace(/[^\p{L}\p{N} ._:()-]/gu, '').trim().slice(0, 60);
}

function listNames(names: string[]): string {
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown;
}

async function scheduleTarget(input: Record<string, unknown>): Promise<AiDesignIntentTarget | null> {
  const { action } = input;
  if (action === 'create') {
    return input.ownerScope === 'organization' && typeof input.orgId === 'string' ? { orgId: input.orgId, partnerId: null, fromArgument: true } : null;
  }
  if (typeof input.scheduleId !== 'string' || !UUID_RE.test(input.scheduleId)) return null;
  const scheduleId = input.scheduleId;
  return asSystem(async () => {
    const [row] = await db
      .select({ orgId: aiAgentSchedules.orgId, partnerId: aiAgentSchedules.partnerId })
      .from(aiAgentSchedules)
      .where(eq(aiAgentSchedules.id, scheduleId))
      .limit(1);
    if (!row) return null;
    if (row.orgId) return { orgId: row.orgId, partnerId: null };
    if (action !== 'delete') return { orgId: null, partnerId: row.partnerId };
    const overrides = await db
      .select({ id: aiAgentSchedules.id })
      .from(aiAgentSchedules)
      .where(eq(aiAgentSchedules.baselineScheduleId, scheduleId));
    return {
      orgId: null,
      partnerId: row.partnerId,
      cardDetail: overrides.length > 0
        ? `This is a baseline for every organization, and ${plural(overrides.length, 'organization')} lose their own override of it. ${PARTNER_LEVEL_APPROVER_NOTE}`
        : `This is a baseline for every organization. ${PARTNER_LEVEL_APPROVER_NOTE}`,
    };
  });
}

/** Devices, automatic restarts and already-applied items: what the input alone cannot say. */
function describeApply(outcome: FleetDesignOutcome, approval: FleetDesignApproval, applied: ReadonlySet<string>): string {
  const devices = new Set(outcome.sections.functions.filter((f) => approval.functions.includes(f.functionKey)).flatMap((f) => f.deviceIds));
  const restarts = [...new Set(approval.monitoring)].flatMap((ref) => {
    const match = /^monitoring:(.+):watch:(\d+)$/.exec(ref);
    const watch = match ? outcome.sections.monitoring.find((m) => m.functionKey === match[1])?.watches[Number(match[2])] : undefined;
    return watch?.autoRestart ? [cleanName(watch.name)] : [];
  });
  const refs = [
    ...approval.functions.map((key) => `functions:${key}`),
    ...approval.monitoring,
    ...approval.retired,
    ...approval.automation,
    ...approval.roleCorrections.map((id) => `roleCorrections:${id}`),
  ];
  const alreadyApplied = new Set(refs.filter((ref) => applied.has(ref))).size;
  return [
    `It covers ${plural(devices.size, 'device')}.`,
    ...(restarts.length > 0 ? [`It installs automatic restart for ${listNames(restarts)}.`] : []),
    ...(alreadyApplied > 0 ? [`${alreadyApplied} of these ${alreadyApplied === 1 ? 'items is' : 'items are'} already applied and will be skipped.`] : []),
  ].join(' ');
}

function describeRollback(rows: ReadonlyArray<{ itemKind: string; status: string }>): string {
  const count = (kind: string) => rows.filter((r) => r.status === 'applied' && r.itemKind === kind).length;
  const parts = [
    ...(count('function') > 0 ? [plural(count('function'), 'group')] : []),
    ...(count('policy') > 0 ? [plural(count('policy'), 'monitoring policy', 'monitoring policies')] : []),
    ...(count('script') > 0 ? [plural(count('script'), 'script')] : []),
    ...(count('role_correction') > 0 ? [`${plural(count('role_correction'), 'device role')} (billing)`] : []),
  ];
  return parts.length > 0 ? `It undoes ${parts.join(', ')}.` : 'Nothing is currently applied from this design.';
}

async function fleetDesignTarget(input: Record<string, unknown>): Promise<AiDesignIntentTarget | null> {
  const { action } = input;
  if (action === 'run') return typeof input.orgId === 'string' ? { orgId: input.orgId, partnerId: null, fromArgument: true } : null;
  // The reads file no intent, so they read nothing here.
  if (action !== 'apply' && action !== 'rollback' && action !== 'document') return null;
  if (typeof input.reportRunId !== 'string' || !UUID_RE.test(input.reportRunId)) return null;
  const reportRunId = input.reportRunId;

  return asSystem(async () => {
    const [report] = await db
      .select({
        orgId: reports.orgId,
        partnerId: reports.partnerId,
        summary: sql<FleetDesignReportSummary | null>`${reportRuns.result}->'summary'`,
      })
      .from(reportRuns)
      .innerJoin(reports, eq(reportRuns.reportId, reports.id))
      .where(and(eq(reportRuns.id, reportRunId), eq(reports.type, FLEET_DESIGN_REPORT_TYPE)))
      .limit(1);
    if (!report?.orgId || report.partnerId) return null;
    const target: AiDesignIntentTarget = { orgId: report.orgId, partnerId: null };
    if (action === 'document') return target;

    const orgId = report.orgId;
    const ledger = async () => db
      .select({ itemRef: fleetDesignAppliedItems.itemRef, itemKind: fleetDesignAppliedItems.itemKind, status: fleetDesignAppliedItems.status })
      .from(fleetDesignAppliedItems)
      .where(and(eq(fleetDesignAppliedItems.reportRunId, reportRunId), eq(fleetDesignAppliedItems.orgId, orgId)));

    if (action === 'rollback') return { ...target, cardDetail: describeRollback(await ledger()) };

    const outcome = report.summary?.fleetDesign?.outcome;
    const approval = fleetDesignApprovalSchema.safeParse(input.approval);
    if (!outcome || !approval.success) return target;
    const applied = new Set((await ledger()).filter((r) => r.status === 'applied').map((r) => r.itemRef));
    return { ...target, cardDetail: describeApply(outcome, approval.data, applied) };
  });
}

export async function resolveAiDesignIntentTarget(toolName: string, input: Record<string, unknown>): Promise<AiDesignIntentTarget | null> {
  if (toolName === 'manage_ai_agent_schedules') return scheduleTarget(input);
  if (toolName === 'manage_fleet_designs') return fleetDesignTarget(input);
  return null;
}
