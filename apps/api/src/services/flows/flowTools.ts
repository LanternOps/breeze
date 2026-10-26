/**
 * W5 PR C (#5220), Task C1 — flows as tools: the `flow__<slug>` descriptors a
 * caller may see, and the per-flow INVOCATION TIER (plan Decisions 7 and 8).
 *
 *  - Only an ENABLED flow whose LIVE publication has a `manual` trigger is a
 *    tool. A descriptor is built per caller, never registered: flow tools stay
 *    out of `aiTools`, `TOOL_TIERS`, `TOOL_PERMISSIONS` and the W19 static
 *    index (tenant tools do too, aiToolIndex.ts).
 *  - The read is a SYSTEM read with explicit owner predicates derived from
 *    `auth` (the tenant resolver's pattern, toolSources/resolver.ts
 *    `ownerPredicate`): an org caller sees its org's flows and its LIVE
 *    partner's partner-wide flows; a partner caller sees its partner-wide
 *    flows plus `targetOrgId`'s flows once that org's partner is re-derived
 *    and the caller reaches it. System scope resolves to nothing.
 *  - The invocation tier is `max(recorded effective tier, live recomputed tier
 *    of the publication's steps)` — never lower than recorded (issue #5220
 *    carry-forward). It is resolved at CALL time (`resolveFlowToolForCall`),
 *    so a publication re-enabled with a higher-tier step since a session
 *    listed it is gated at its new tier.
 *  - A flow tool is never a step of another flow (Decision 7, B1's
 *    `flow_step_not_supported`); this module only describes and resolves.
 *
 * Flag off (`FLOWS_ENABLED`) ⇒ no flow tool resolves on any surface.
 */
import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  coerceFlowInputs,
  FLOW_RUN_LIMITS,
  flowDocumentV1Schema,
  type FlowDocumentV1,
  type FlowValue,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { flowRuns, flowVersions } from '../../db/schema/flowRuns';
import { flows } from '../../db/schema/flows';
import { organizations } from '../../db/schema/orgs';
import { flowsEnabled } from '../../config/env';
import type { AuthContext } from '../../middleware/auth';
import { FlowStepPinError, stepPinsFor } from '../flowValidator';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { FLOW_TOOL_PREFIX, flowToolName, flowToolSlug, isFlowToolName } from './toolNames';

export { FLOW_TOOL_PREFIX, flowToolName, isFlowToolName };

export type FlowToolTier = 1 | 2 | 3;

/** What a flow tool call carries once validated: the coerced flow inputs plus the two tool-level arguments. */
export interface FlowToolCallInput {
  inputs: Record<string, FlowValue>;
  /** Run org for a partner-wide flow called by a partner-scoped caller; null otherwise. */
  orgId: string | null;
  idempotencyKey: string | null;
}

export type FlowToolValidation =
  | { ok: true; value: FlowToolCallInput }
  | { ok: false; message: string; issues: Array<{ name: string; message: string }> };

export interface FlowToolDescriptor {
  name: string;
  flowId: string;
  flowName: string;
  publicationId: string;
  publicationSeq: number;
  owner: ToolOwnerRef;
  partnerWide: boolean;
  tier: FlowToolTier;
  /** `flowpub:<publicationId>` — the action-intent `tool_revision` a Tier-3 call binds. */
  revision: string;
  definition: { name: string; description: string; input_schema: Record<string, unknown> };
  validate(input: unknown): FlowToolValidation;
}

/** Tool-level argument names; a flow declaring an input with one of them is not exposed as a tool (run_flow still reaches it). */
const RESERVED_ARGUMENTS: ReadonlySet<string> = new Set(['orgId', 'idempotencyKey']);
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESCRIPTION_MAX = 300;

// ── the read ────────────────────────────────────────────────────────────────

/**
 * The owner predicate over `flows`, derived EXPLICITLY from `auth` (never an
 * ambient read) — the same shape as the tenant resolver's `ownerPredicate`.
 * `null` ⇒ resolve to nothing.
 */
function flowOwnerPredicate(auth: AuthContext, targetOrgId: string | null): SQL | null {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    const orgsPartnerId = sql<string>`(select ${organizations.partnerId} from ${organizations} where ${organizations.id} = ${auth.orgId})`;
    return or(eq(flows.orgId, auth.orgId), and(isNull(flows.orgId), eq(flows.partnerId, orgsPartnerId))) ?? null;
  }
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return null;
    const partnerWide = and(isNull(flows.orgId), eq(flows.partnerId, auth.partnerId));
    if (!targetOrgId || !auth.canAccessOrg?.(targetOrgId)) return partnerWide ?? null;
    const targetOrgsPartnerId = sql<string>`(select ${organizations.partnerId} from ${organizations} where ${organizations.id} = ${targetOrgId})`;
    return or(and(eq(flows.orgId, targetOrgId), eq(targetOrgsPartnerId, auth.partnerId)), partnerWide) ?? null;
  }
  return null;
}

/** The org whose runs order the list: the org caller's own, or a reachable target of a partner caller. */
function orderingOrgId(auth: AuthContext, targetOrgId: string | null): string | null {
  if (auth.scope === 'organization') return auth.orgId ?? null;
  if (auth.scope === 'partner' && targetOrgId && auth.canAccessOrg?.(targetOrgId)) return targetOrgId;
  return null;
}

/**
 * Builds (without executing) the flow-tool read, so a DB-less test can assert
 * on `.toSQL()`. Enabled flows joined to their LIVE publication, manual
 * trigger only, under the owner predicate; ordered by the most recent run in
 * the target org (only that org's runs, so the order is no signal about other
 * orgs), then slug. `null` when no predicate is derivable.
 */
export function buildFlowToolsQuery(
  auth: AuthContext,
  targetOrgId: string | null,
  opts: { slug?: string; flowId?: string; limit?: number } = {},
) {
  const predicate = flowOwnerPredicate(auth, targetOrgId);
  if (!predicate) return null;
  const runOrg = orderingOrgId(auth, targetOrgId);
  const lastRunAt = runOrg
    ? sql<Date | null>`(select max(${flowRuns.createdAt}) from ${flowRuns} where ${flowRuns.flowId} = ${flows.id} and ${flowRuns.orgId} = ${runOrg})`
    : sql<Date | null>`null::timestamptz`;
  const ownerPartnerId = sql<string | null>`coalesce(${flows.partnerId}, (select ${organizations.partnerId} from ${organizations} where ${organizations.id} = ${flows.orgId}))`;

  const query = db
    .select({
      flowId: flows.id,
      orgId: flows.orgId,
      flowPartnerId: flows.partnerId,
      ownerPartnerId,
      slug: flows.slug,
      name: flows.name,
      description: flows.description,
      publicationId: flowVersions.id,
      publicationSeq: flowVersions.publicationSeq,
      effectiveTier: flowVersions.effectiveTier,
      definition: flowVersions.definition,
      lastRunAt,
    })
    .from(flows)
    .innerJoin(flowVersions, and(eq(flowVersions.flowId, flows.id), sql`${flowVersions.publicationSeq} = ${flows.enabledPublicationSeq}`))
    .where(and(
      eq(flows.status, 'enabled'),
      sql`${flowVersions.definition}->'trigger'->>'type' = ${'manual'}`,
      predicate,
      opts.slug ? eq(flows.slug, opts.slug) : undefined,
      opts.flowId ? eq(flows.id, opts.flowId) : undefined,
    ))
    .orderBy(sql`${lastRunAt} desc nulls last`, asc(flows.slug), asc(flows.id));
  return opts.limit ? query.limit(opts.limit) : query;
}

export interface FlowToolRow {
  flowId: string;
  orgId: string | null;
  flowPartnerId: string | null;
  ownerPartnerId: string | null;
  slug: string;
  name: string;
  description: string | null;
  publicationId: string;
  publicationSeq: number;
  effectiveTier: number;
  definition: unknown;
  lastRunAt: Date | string | null;
}

async function readFlowToolRows(
  auth: AuthContext,
  targetOrgId: string | null,
  opts: { slug?: string; flowId?: string; limit?: number },
): Promise<FlowToolRow[]> {
  if (!flowOwnerPredicate(auth, targetOrgId)) return [];
  // Built INSIDE the system context: the `db` proxy binds a query to the
  // context it is built in (toolSources/resolver.ts has the same rule), so a
  // query built outside would run contextless and, under forced RLS, read
  // nothing.
  return runOutsideDbContext(() => withSystemDbAccessContext(
    async () => ((await buildFlowToolsQuery(auth, targetOrgId, opts)) ?? []) as unknown as FlowToolRow[],
    'flows.flowTools.read',
  ));
}

// ── the tier ────────────────────────────────────────────────────────────────

function clampTier(t: number): FlowToolTier {
  return t <= 1 ? 1 : t >= 3 ? 3 : 2;
}

/**
 * `max(publication.effective_tier, the live tier of every step of its
 * document)`, the live tier recomputed exactly as enable pins it
 * (`stepPinsFor`: the owner's live catalog, the literal-input guardrail call,
 * the tenant tool's current tier, the built-in's tier for its input). A step
 * that no longer resolves (a vanished or blocked tool) and a document that no
 * longer parses are Tier 3. Any other failure propagates: the caller fails
 * closed.
 */
export async function flowInvocationTier(
  publication: { effectiveTier: number; definition: unknown },
  owner: ToolOwnerRef,
): Promise<FlowToolTier> {
  const recorded = clampTier(publication.effectiveTier);
  const parsed = flowDocumentV1Schema.safeParse(publication.definition);
  if (!parsed.success) return 3;
  let live = 1;
  try {
    for (const pin of await stepPinsFor(parsed.data, { owner })) live = Math.max(live, pin.tier);
  } catch (err) {
    if (err instanceof FlowStepPinError) return 3;
    throw err;
  }
  return clampTier(Math.max(recorded, live));
}

// ── the descriptor ──────────────────────────────────────────────────────────

function proseLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function describeFlowTool(name: string, description: string | null): string {
  const head = `Flow: ${proseLine(name)}`;
  const body = description ? proseLine(description) : '';
  const full = body ? `${head} — ${body}` : head;
  return full.length <= DESCRIPTION_MAX ? full : `${full.slice(0, DESCRIPTION_MAX - 1)}…`;
}

function inputSchemaFor(doc: FlowDocumentV1, withOrgId: boolean): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const decl of doc.inputs) {
    const prop: Record<string, unknown> = decl.type === 'uuid'
      ? { type: 'string', format: 'uuid' }
      : { type: decl.type };
    if (decl.description) prop.description = decl.description;
    properties[decl.name] = prop;
  }
  if (withOrgId) {
    properties.orgId = { type: 'string', format: 'uuid', description: 'Organization to run the flow in (UUID). Defaults to the organization of this conversation.' };
  }
  properties.idempotencyKey = { type: 'string', description: 'Optional key (letters, digits, - and _); the same key returns the same run.' };
  const required = doc.inputs.filter((d) => d.required).map((d) => d.name);
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

function validatorFor(doc: FlowDocumentV1, withOrgId: boolean): (input: unknown) => FlowToolValidation {
  return (input: unknown): FlowToolValidation => {
    const fail = (issues: Array<{ name: string; message: string }>): FlowToolValidation => ({
      ok: false,
      issues,
      message: issues.map((i) => `${i.name}: ${i.message}`).join('; '),
    });
    if (!input || typeof input !== 'object' || Array.isArray(input)) return fail([{ name: '(input)', message: 'Expected an object' }]);
    const { orgId, idempotencyKey, ...rest } = input as Record<string, unknown>;
    const issues: Array<{ name: string; message: string }> = [];
    let org: string | null = null;
    if (orgId !== undefined && orgId !== null) {
      if (!withOrgId) issues.push({ name: 'orgId', message: 'Unknown input' });
      else if (typeof orgId !== 'string' || !UUID_RE.test(orgId)) issues.push({ name: 'orgId', message: 'Expected a UUID' });
      else org = orgId.toLowerCase();
    }
    let key: string | null = null;
    if (idempotencyKey !== undefined && idempotencyKey !== null) {
      if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
        issues.push({ name: 'idempotencyKey', message: 'Expected 1-64 letters, digits, - or _' });
      } else key = idempotencyKey;
    }
    const coerced = coerceFlowInputs(doc.inputs, rest);
    if (!coerced.ok) issues.push(...coerced.issues);
    if (issues.length > 0 || !coerced.ok) return fail(issues);
    return { ok: true, value: { inputs: coerced.inputs, orgId: org, idempotencyKey: key } };
  };
}

/** A row's descriptor without its tier, or null when the row is not a tool (bad document, non-manual, reserved input names, no owner partner). */
function descriptorBase(auth: AuthContext, r: FlowToolRow): Omit<FlowToolDescriptor, 'tier'> & { doc: FlowDocumentV1; effectiveTier: number } | null {
  const parsed = flowDocumentV1Schema.safeParse(r.definition);
  if (!parsed.success) return null;
  const doc = parsed.data;
  if (doc.trigger.type !== 'manual') return null;
  if (doc.inputs.some((d) => RESERVED_ARGUMENTS.has(d.name))) return null;
  if (!isFlowToolName(flowToolName(r.slug))) return null;
  const partnerId = r.ownerPartnerId ?? r.flowPartnerId;
  if (!partnerId) return null;
  const partnerWide = r.orgId === null;
  const withOrgId = partnerWide && auth.scope === 'partner';
  const name = flowToolName(r.slug);
  return {
    name,
    flowId: r.flowId,
    flowName: r.name,
    publicationId: r.publicationId,
    publicationSeq: r.publicationSeq,
    owner: partnerWide ? { orgId: null, partnerId } : { orgId: r.orgId, partnerId },
    partnerWide,
    revision: `flowpub:${r.publicationId}`,
    definition: { name, description: describeFlowTool(r.name, r.description), input_schema: inputSchemaFor(doc, withOrgId) },
    validate: validatorFor(doc, withOrgId),
    doc,
    effectiveTier: r.effectiveTier,
  };
}

function lastRunMs(r: FlowToolRow): number {
  if (!r.lastRunAt) return -Infinity;
  const t = r.lastRunAt instanceof Date ? r.lastRunAt.getTime() : Date.parse(r.lastRunAt);
  return Number.isFinite(t) ? t : -Infinity;
}

async function withTier(base: NonNullable<ReturnType<typeof descriptorBase>>): Promise<FlowToolDescriptor> {
  const { doc, effectiveTier, ...rest } = base;
  const tier = await flowInvocationTier({ effectiveTier, definition: doc }, base.owner);
  return { ...rest, tier };
}

/**
 * The flow tools a caller may see, at most `FLOW_RUN_LIMITS.flowToolsPerSessionMax`
 * (most recently run in the target org first, then slug); beyond that the
 * model uses `list_flows` + `run_flow`. `[]` when the flag is off or for a
 * system-scope caller. A tier that cannot be computed is Tier 3 here (a list
 * is advisory; every call re-resolves).
 */
export async function resolveFlowTools(auth: AuthContext, targetOrgId?: string | null): Promise<FlowToolDescriptor[]> {
  if (!flowsEnabled() || auth.scope === 'system') return [];
  const cap = FLOW_RUN_LIMITS.flowToolsPerSessionMax;
  const rows = await readFlowToolRows(auth, targetOrgId ?? null, { limit: cap });
  const ordered = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (lastRunMs(b.r) - lastRunMs(a.r)) || (a.r.slug < b.r.slug ? -1 : a.r.slug > b.r.slug ? 1 : a.i - b.i))
    .map(({ r }) => r);
  const out: FlowToolDescriptor[] = [];
  for (const r of ordered) {
    if (out.length >= cap) break;
    const base = descriptorBase(auth, r);
    if (!base) continue;
    try {
      out.push(await withTier(base));
    } catch (err) {
      console.warn(`[flows] flow tool tier could not be computed (flow=${r.flowId}); listed as tier 3`, err);
      const { doc: _doc, effectiveTier: _t, ...rest } = base;
      out.push({ ...rest, tier: 3 });
    }
  }
  return out;
}

/**
 * The LIVE descriptor for one flow tool name (no cap), with the live
 * invocation tier. `null` when the name is not a flow tool, the flag is off,
 * or no enabled manual flow of that slug is visible to the caller. Tier
 * failures propagate (the caller denies the call).
 */
export async function resolveFlowToolForCall(
  auth: AuthContext,
  name: string,
  targetOrgId?: string | null,
): Promise<FlowToolDescriptor | null> {
  const slug = flowToolSlug(name);
  if (!slug || !flowsEnabled() || auth.scope === 'system') return null;
  const rows = await readFlowToolRows(auth, targetOrgId ?? null, { slug });
  // An org flow and a partner-wide flow of its partner never share a slug
  // (services/flows/repository.ts), so at most one row matches; prefer the
  // org's own flow if a stale row ever says otherwise.
  const row = rows.find((r) => r.orgId !== null) ?? rows[0];
  if (!row) return null;
  const base = descriptorBase(auth, row);
  return base ? withTier(base) : null;
}

/**
 * `run_flow`'s dynamic gate (Decision 8): the target flow's live invocation
 * tier, PINNED to the publication it was computed for — the chat gate hands
 * `{ flowId, publicationSeq }` to the run_flow handler, which starts the run
 * on exactly that publication (`startManualRun`'s `expectedPublicationSeq`),
 * so a re-enable between the gate and the start can never run a
 * higher-tier publication at the lowered tier. Never above 3; ANY failure —
 * flag off, a missing or invisible flow, a flow that is not manual, a read or
 * tier error — is `{ tier: 3 }`, the static tier, with no pin.
 */
export type RunFlowGate = { tier: 1 | 2; flowId: string; publicationSeq: number } | { tier: 3 };

export async function resolveRunFlowGate(
  auth: AuthContext,
  input: unknown,
  defaultOrgId?: string | null,
): Promise<RunFlowGate> {
  try {
    if (!flowsEnabled() || auth.scope === 'system') return { tier: 3 };
    const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    const flowId = typeof rec.flowId === 'string' && UUID_RE.test(rec.flowId) ? rec.flowId.toLowerCase() : null;
    if (!flowId) return { tier: 3 };
    const orgId = typeof rec.orgId === 'string' && UUID_RE.test(rec.orgId) ? rec.orgId.toLowerCase() : defaultOrgId ?? null;
    const rows = await readFlowToolRows(auth, orgId, { flowId });
    const row = rows[0];
    if (!row) return { tier: 3 };
    const parsed = flowDocumentV1Schema.safeParse(row.definition);
    if (!parsed.success || parsed.data.trigger.type !== 'manual') return { tier: 3 };
    const partnerId = row.ownerPartnerId ?? row.flowPartnerId;
    if (!partnerId) return { tier: 3 };
    const owner: ToolOwnerRef = row.orgId ? { orgId: row.orgId, partnerId } : { orgId: null, partnerId };
    const tier = await flowInvocationTier({ effectiveTier: row.effectiveTier, definition: parsed.data }, owner);
    return tier === 3 ? { tier: 3 } : { tier, flowId: row.flowId, publicationSeq: row.publicationSeq };
  } catch (err) {
    console.warn('[flows] run_flow tier could not be resolved; keeping tier 3', err);
    return { tier: 3 };
  }
}

/** The tier alone (see `resolveRunFlowGate`); any failure is 3. */
export async function resolveRunFlowTier(
  auth: AuthContext,
  input: unknown,
  defaultOrgId?: string | null,
): Promise<FlowToolTier> {
  return (await resolveRunFlowGate(auth, input, defaultOrgId)).tier;
}
