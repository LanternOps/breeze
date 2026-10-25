/**
 * Tool Catalog W03 (#5218) — catalog-aware flow validation (spec §6.3).
 *
 * Rules run at save in W03 (plan Decision 3): rule 1 (the step tool exists in
 * the OWNER's catalog and is flow-eligible), rule 2 (input vs schema, with
 * template-aware partial validation), rule 3 (structure + whole-document
 * bounds, shared `checkFlowStructure`), rule 5 (effective tier as an upper
 * bound, every tier-deciding input literal), and rule 6 (literal asset ids
 * belong to the owner). Every `approval: 'pre_approved'` is refused — the
 * pre-approval lane (rule 4) and enabler permissions (rule 7) are W04, at
 * enable time.
 *
 * The owner is produced only by `flows/owner.ts` (after authorizing the real
 * caller) or read from a stored row; this module never authorizes anyone. All
 * DB reads run in system context with explicit owner predicates
 * (`flows/ownedReferences.ts`, `resolveTenantToolsForOwner`).
 *
 * Never throws for a bad document: every problem is a `FlowIssue`.
 *
 * W04 (#5219) adds the run-time half: `stepPinsFor` records, at enable, what
 * each step resolved to (source, tier, approval scope, tenant revision), and
 * `revalidateRenderedStep` re-checks one RENDERED step against those pins
 * with nothing masked — schema, live catalog, live tier/scope and ownership
 * of every referenced asset in the run's org.
 */
import type { ErrorObject } from 'ajv';
import { z } from 'zod';
import {
  checkFlowStructure,
  FLOW_BUILTIN_STEPS,
  FLOW_LATER_BUILTINS,
  FLOW_LIMITS,
  FLOW_STEP_ID_RE,
  flowDocumentV1Schema,
  isFlowBuiltin,
  templateLeafKinds,
  type FlowDocumentV1,
  type FlowIssue,
  type FlowStepSummary,
  type FlowValidationResult,
} from '@breeze/shared';
import { eventDispatchMode, eventDispatchQueueSubscribers } from '../config/env';
import { checkGuardrails, tierDecidingInputKeys } from './aiGuardrails';
import { toolInputSchemas } from './aiToolSchemas';
import { EVENT_TYPES } from './eventBus';
import type { SubscriberId } from './eventSubscriberIds';
import { FLOW_OWNED_REFERENCE_FIELDS, isRegisteredCoreTool, loadFlowCatalog, type FlowCatalogEntry } from './flows/catalog';
import {
  findDeviceIdsInSites,
  findOwnedDeviceGroupIds,
  findOwnedDeviceIds,
  findOwnedScriptIds,
} from './flows/ownedReferences';
import { guardrailCheckForTenantTool } from './toolSources/guardrails';
import type { ToolOwnerRef } from './toolSources/resolver';
import type { FlowPreApprovalBinding } from './flows/preApproval';

export interface FlowValidationContext {
  /** Only ever produced by resolveFlowOwnerForCaller or read from a stored flows row. */
  owner: ToolOwnerRef;
}

export type FlowDocumentValidation = FlowValidationResult & { document?: FlowDocumentV1 };

type StepTier = 1 | 2 | 3 | null;

const PRE_APPROVAL_MESSAGE = 'Pre-approval is set on the Flows page when the flow is enabled.';
const TOOL_NOT_FOUND_MESSAGE = (tool: string) => `Tool '${tool}' is not available to this flow's owner.`;

// ── issue helpers ──────────────────────────────────────────────────────────

function issue(
  code: FlowIssue['code'],
  message: string,
  extra: { stepId?: string; pointer?: string; severity?: FlowIssue['severity'] } = {},
): FlowIssue {
  return {
    code,
    severity: extra.severity ?? 'error',
    message,
    ...(extra.stepId !== undefined ? { stepId: extra.stepId } : {}),
    ...(extra.pointer !== undefined ? { pointer: extra.pointer } : {}),
  };
}

function escapePointerSegment(seg: string | number): string {
  return String(seg).replace(/~/g, '~0').replace(/\//g, '~1');
}

function toPointer(path: ReadonlyArray<PropertyKey>): string {
  return path.map((s) => `/${escapePointerSegment(typeof s === 'symbol' ? s.toString() : (s as string | number))}`).join('');
}

type LeafKinds = ReadonlyMap<string, 'exact' | 'partial'>;

/**
 * Which templated leaf, if any, an issue at `pointer` sits under. An exact
 * leaf can render to any JSON type, so it covers its descendants too; a
 * partial leaf always renders to a string, which has none.
 */
function templateKindAt(pointer: string, kinds: LeafKinds): 'exact' | 'partial' | null {
  const own = kinds.get(pointer);
  if (own) return own;
  for (const [t, kind] of kinds) {
    if (kind === 'exact' && pointer.startsWith(`${t}/`)) return 'exact';
  }
  return null;
}

export function containsTemplate(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.includes('{{')) return true;
    } else if (Array.isArray(v)) {
      stack.push(...v);
    } else if (v && typeof v === 'object') {
      stack.push(...Object.values(v));
    }
  }
  return false;
}

/** Literal (non-templated) string values of a string or string[] input field. */
function literalStrings(value: unknown): Array<{ value: string; index?: number }> {
  if (typeof value === 'string') return value.includes('{{') ? [] : [{ value }];
  if (Array.isArray(value)) {
    return value.flatMap((v, index) => (typeof v === 'string' && !v.includes('{{') ? [{ value: v, index }] : []));
  }
  return [];
}

function utf8Bytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ── rule 2: template-aware partial validation ──────────────────────────────

/**
 * Zod 4 codes that describe a VALUE (a templated leaf's runtime value can
 * satisfy them). Structural codes — `custom` (refinements such as run_script's
 * exactly-one-of rules), `unrecognized_keys`, a missing required key (an
 * `invalid_type` at a path no template occupies) — are never masked.
 */
const MASKABLE_ZOD_CODES: ReadonlySet<string> = new Set([
  'invalid_type', 'invalid_format', 'invalid_value', 'invalid_union', 'too_small', 'too_big', 'not_multiple_of',
]);

const MASKABLE_AJV_KEYWORDS: ReadonlySet<string> = new Set([
  'type', 'format', 'pattern', 'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'multipleOf', 'anyOf', 'oneOf',
]);

/** Under a PARTIAL template (always a string at run time) only string-level checks are unknown. */
const PARTIAL_MASKABLE_AJV_KEYWORDS: ReadonlySet<string> = new Set(['format', 'pattern', 'enum', 'const', 'minLength', 'maxLength']);

function zodIssueMasked(zi: LooseZodIssue, kind: 'exact' | 'partial' | null): boolean {
  if (kind === 'exact') return MASKABLE_ZOD_CODES.has(zi.code);
  if (kind !== 'partial') return false;
  switch (zi.code) {
    case 'invalid_format': return true;
    case 'invalid_value': return Array.isArray(zi.values) && zi.values.some((v) => typeof v === 'string');
    case 'too_small':
    case 'too_big': return zi.origin === 'string';
    default: return false;
  }
}

const FORMAT_PLACEHOLDERS: Readonly<Record<string, string>> = {
  uuid: '00000000-0000-4000-8000-000000000000',
  guid: '00000000-0000-4000-8000-000000000000',
  email: 'placeholder@example.com',
  url: 'https://example.com/',
  datetime: '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  time: '00:00:00',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
};

type LooseZodIssue = z.core.$ZodIssue & {
  expected?: string;
  format?: string;
  values?: unknown[];
  origin?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  divisor?: number;
  errors?: LooseZodIssue[][];
};

/**
 * A value that satisfies the failing check, used ONLY to re-parse so that
 * refinements Zod skipped after an aborting issue at a templated leaf still
 * run (Zod 4 does not run an object's refinements once a child aborted).
 * Never stored; the masked check itself is re-run on the rendered value at
 * run time (W04).
 */
function placeholderFor(i: LooseZodIssue): { ok: true; value: unknown } | { ok: false } {
  switch (i.code) {
    case 'invalid_type':
      switch (i.expected) {
        case 'string': return { ok: true, value: 'x' };
        case 'number': case 'int': return { ok: true, value: 0 };
        case 'boolean': return { ok: true, value: false };
        case 'array': return { ok: true, value: [] };
        case 'object': case 'record': return { ok: true, value: {} };
        case 'null': return { ok: true, value: null };
        default: return { ok: false };
      }
    case 'invalid_format': {
      const v = i.format ? FORMAT_PLACEHOLDERS[i.format] : undefined;
      return v ? { ok: true, value: v } : { ok: false };
    }
    case 'invalid_value':
      return Array.isArray(i.values) && i.values.length > 0 ? { ok: true, value: i.values[0] } : { ok: false };
    case 'too_small':
      if (i.origin === 'number' && typeof i.minimum === 'number') return { ok: true, value: i.inclusive === false ? i.minimum + 1 : i.minimum };
      if (i.origin === 'string' && typeof i.minimum === 'number') return { ok: true, value: 'x'.repeat(Math.min(i.minimum, 1024)) };
      return { ok: false };
    case 'too_big':
      if (i.origin === 'number' && typeof i.maximum === 'number') return { ok: true, value: i.inclusive === false ? i.maximum - 1 : i.maximum };
      if (i.origin === 'string') return { ok: true, value: '' };
      return { ok: false };
    case 'invalid_union': {
      const first = i.errors?.[0]?.[0];
      return first ? placeholderFor(first) : { ok: false };
    }
    default:
      return { ok: false };
  }
}

function setAtPath(root: Record<string, unknown>, path: ReadonlyArray<PropertyKey>, value: unknown): boolean {
  if (path.length === 0) return false;
  let cur: unknown = root;
  for (let k = 0; k < path.length - 1; k++) {
    if (!cur || typeof cur !== 'object') return false;
    cur = (cur as Record<PropertyKey, unknown>)[path[k]!];
  }
  if (!cur || typeof cur !== 'object') return false;
  (cur as Record<PropertyKey, unknown>)[path[path.length - 1]!] = value;
  return true;
}

function zodInputIssues(schema: z.ZodType, input: Record<string, unknown>, stepId: string, base: string): FlowIssue[] {
  const kinds = templateLeafKinds(input);
  const seen = new Set<string>();
  const out: FlowIssue[] = [];
  const collect = (issues: LooseZodIssue[]): LooseZodIssue[] => {
    const masked: LooseZodIssue[] = [];
    for (const zi of issues) {
      const pointer = toPointer(zi.path);
      if (zodIssueMasked(zi, templateKindAt(pointer, kinds))) {
        masked.push(zi);
        continue;
      }
      const key = `${zi.code}|${pointer}|${zi.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(issue('input_invalid', `${pointer || '/'}: ${zi.message}`, { stepId, pointer: `${base}${pointer}` }));
    }
    return masked;
  };

  // A deep copy, so placeholders never leak into the caller's document. The
  // input is parsed JSON, so structuredClone cannot fail on it.
  const working: Record<string, unknown> = structuredClone(input);
  let parsed = schema.safeParse(working);
  let masked = parsed.success ? [] : collect(parsed.error.issues as LooseZodIssue[]);
  for (let round = 0; round < 5 && masked.length > 0; round++) {
    let changed = false;
    for (const zi of masked) {
      const p = placeholderFor(zi);
      if (p.ok && setAtPath(working, zi.path, p.value)) changed = true;
    }
    if (!changed) break;
    parsed = schema.safeParse(working);
    masked = parsed.success ? [] : collect(parsed.error.issues as LooseZodIssue[]);
  }
  return out;
}

function ajvInputIssues(entry: Extract<FlowCatalogEntry, { source: 'tenant' }>, input: Record<string, unknown>, stepId: string, base: string): FlowIssue[] {
  const kinds = templateLeafKinds(input);
  if (entry.validate(input)) return [];
  const errors: ErrorObject[] = entry.validate.errors ?? [];
  const out: FlowIssue[] = [];
  for (const e of errors) {
    const kind = templateKindAt(e.instancePath, kinds);
    if (kind === 'exact' && MASKABLE_AJV_KEYWORDS.has(e.keyword)) continue;
    if (kind === 'partial' && PARTIAL_MASKABLE_AJV_KEYWORDS.has(e.keyword)) continue;
    const detail = e.keyword === 'additionalProperties' && e.params && 'additionalProperty' in e.params
      ? ` ('${String((e.params as { additionalProperty: unknown }).additionalProperty)}')`
      : '';
    out.push(issue('input_invalid', `${e.instancePath || '/'}: ${e.message ?? e.keyword}${detail}`, {
      stepId, pointer: `${base}${e.instancePath}`,
    }));
  }
  return out;
}

// ── rule 5: tiers ──────────────────────────────────────────────────────────

/**
 * The literal part of a step input, as the guardrails see it at save and
 * enable. Tier-deciding keys are required to be literal (rule 5), so dropping
 * templated top-level fields cannot change the tier. proposalId is refused
 * separately (input_not_supported).
 */
export function literalGuardInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const guardInput: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'proposalId' && name === 'run_script') continue;
    if (!containsTemplate(v)) guardInput[k] = v;
  }
  return guardInput;
}

function coreStepTier(name: string, input: Record<string, unknown>, stepId: string, base: string): { tier: StepTier; issues: FlowIssue[] } {
  const issues: FlowIssue[] = [];
  const keys = tierDecidingInputKeys(name);
  keys.forEach((key, idx) => {
    if (!Object.hasOwn(input, key) || !containsTemplate(input[key])) return;
    issues.push(idx === 0
      ? issue('action_not_literal', `'${key}' selects what this step does and must be a literal value, not a template.`, { stepId, pointer: `${base}/${escapePointerSegment(key)}` })
      : issue('tier_input_not_literal', `'${key}' decides this step's approval tier and must be literal (no templates anywhere inside it).`, { stepId, pointer: `${base}/${escapePointerSegment(key)}` }));
  });
  if (issues.length > 0) return { tier: null, issues };

  const check = checkGuardrails(name, literalGuardInput(name, input));
  if (!check.allowed || check.tier === 4) {
    return { tier: null, issues: [issue('tool_blocked', `Tool '${name}' cannot run in a flow with this input.`, { stepId })] };
  }
  return { tier: check.tier as 1 | 2 | 3, issues };
}

// ── main ───────────────────────────────────────────────────────────────────

function inferredSource(tool: string): FlowStepSummary['source'] {
  if (isFlowBuiltin(tool) || (FLOW_LATER_BUILTINS as readonly string[]).includes(tool)) return 'builtin';
  return tool.includes('__') ? 'tenant' : 'core';
}

function result(issues: FlowIssue[], steps: FlowStepSummary[], document?: FlowDocumentV1): FlowDocumentValidation {
  const tiers = steps.map((s) => s.tier);
  const effectiveTier = steps.length > 0 && tiers.every((t) => t !== null)
    ? (Math.max(...(tiers as number[])) as 1 | 2 | 3)
    : null;
  return {
    valid: issues.every((i) => i.severity !== 'error'),
    effectiveTier,
    steps,
    issues,
    ...(document ? { document } : {}),
  };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const KNOWN_EVENTS: ReadonlySet<string> = new Set(Object.values(EVENT_TYPES) as string[]);

/**
 * The durable event subscriber that admits event-triggered flow runs
 * (services/flows/eventTrigger.ts, registered in eventSubscribers.ts).
 */
export const FLOW_EVENT_TRIGGER_SUBSCRIBER_ID = 'flow-event-trigger' satisfies SubscriberId;

const EVENT_NOT_DURABLE_MESSAGE =
  'Events are not delivered durably on this deployment, so an event-triggered flow could silently miss events. '
  + 'Enabling it will be refused until event dispatch runs in enforce mode with the flow event subscriber on the durable queue.';

/**
 * Open Decision 10: event flows need durable, at-least-once delivery. In
 * `off` and `shadow`, and in `enforce` without membership, delivery is
 * in-process and at-most-once and handler failures are swallowed
 * (`eventBus.ts` `invokeLocalHandlers`). Enable refuses on false; the
 * reconciler (A8) re-checks and pauses enabled event flows.
 */
export function isFlowEventDeliveryDurable(): boolean {
  return eventDispatchMode() === 'enforce'
    && eventDispatchQueueSubscribers().has(FLOW_EVENT_TRIGGER_SUBSCRIBER_ID);
}

export async function validateFlowDocument(doc: unknown, ctx: FlowValidationContext): Promise<FlowDocumentValidation> {
  // 0. Raw bound — the tool inputs are open records, so this runs before any schema.
  const bytes = utf8Bytes(doc);
  if (bytes > FLOW_LIMITS.maxDocumentBytes) {
    return result([issue('document_too_large', `Flow document is larger than ${FLOW_LIMITS.maxDocumentBytes} bytes.`)], []);
  }

  // 1. Document schema.
  const parsed = flowDocumentV1Schema.safeParse(doc);
  if (!parsed.success) {
    return result(parsed.error.issues.map((zi) => issue('schema', zi.message, { pointer: toPointer(zi.path) })), []);
  }
  const document = parsed.data;
  const unresolved = (): FlowStepSummary[] => document.steps.map((s) => ({
    id: s.id, tool: s.tool, source: inferredSource(s.tool), tier: null, approval: s.approval,
  }));

  // 2. Structure (rule 3).
  const issues: FlowIssue[] = [...checkFlowStructure(document)];
  const structureFailed = issues.some((i) => i.severity === 'error');

  // 3. Trigger.
  const trigger = document.trigger;
  if (trigger.type === 'webhook') {
    issues.push(issue('trigger_not_available', 'Webhook triggers are not available yet.', { pointer: '/trigger/type' }));
  } else if (trigger.type === 'event') {
    if (!KNOWN_EVENTS.has(trigger.event)) {
      issues.push(issue('event_unknown', `Event '${trigger.event}' is not a known event type.`, { pointer: '/trigger/event' }));
    } else if (!isFlowEventDeliveryDurable()) {
      issues.push(issue('event_dispatch_not_durable', EVENT_NOT_DURABLE_MESSAGE, { pointer: '/trigger/event', severity: 'warning' }));
    }
  } else if (trigger.type === 'schedule' && !isValidTimeZone(trigger.timezone)) {
    issues.push(issue('schema', `Unknown time zone '${trigger.timezone}'.`, { pointer: '/trigger/timezone' }));
  }

  if (structureFailed) return result(issues, unresolved(), document);

  // 4–8. Per step, against the owner's catalog.
  const { owner } = ctx;
  const catalog = await loadFlowCatalog(owner);
  const summaries: FlowStepSummary[] = [];
  const scriptRefs: Array<{ id: string; stepId: string; pointer: string }> = [];
  const groupRefs: Array<{ id: string; stepId: string; pointer: string }> = [];
  const deviceRefs: Array<{ id: string; stepId: string; pointer: string }> = [];

  document.steps.forEach((step, i) => {
    const base = `/steps/${i}/input`;
    const input = step.input;
    const entry = catalog.get(step.tool);
    let tier: StepTier = null;
    let source: FlowStepSummary['source'] = inferredSource(step.tool);

    if (!entry) {
      if ((FLOW_LATER_BUILTINS as readonly string[]).includes(step.tool)) {
        issues.push(issue('builtin_not_available', `Built-in step '${step.tool}' is not available yet.`, { stepId: step.id, pointer: `/steps/${i}/tool` }));
      } else if (!step.tool.includes('__') && isRegisteredCoreTool(step.tool)) {
        issues.push(issue('tool_not_allowed', `Tool '${step.tool}' cannot be used in a flow.`, { stepId: step.id, pointer: `/steps/${i}/tool` }));
      } else {
        // Same text for "not enabled", "another tenant's" and "nonexistent".
        issues.push(issue('tool_not_found', TOOL_NOT_FOUND_MESSAGE(step.tool), { stepId: step.id, pointer: `/steps/${i}/tool` }));
      }
    } else if (entry.source === 'builtin') {
      source = 'builtin';
      issues.push(...zodInputIssues(FLOW_BUILTIN_STEPS[entry.name].inputSchema, input, step.id, base));
      tier = FLOW_BUILTIN_STEPS[entry.name].tier;
    } else if (entry.source === 'tenant') {
      source = 'tenant';
      issues.push(...ajvInputIssues(entry, input, step.id, base));
      const check = guardrailCheckForTenantTool(entry.descriptor);
      tier = check.tier as 1 | 2 | 3;
    } else {
      source = 'core';
      if (step.tool === 'run_script' && Object.hasOwn(input, 'proposalId')) {
        issues.push(issue('input_not_supported', 'Flows run library scripts only; use scriptId, not proposalId.', { stepId: step.id, pointer: `${base}/proposalId` }));
      }
      // Fail closed: without a schema neither rule 2 nor the reference-field
      // contract (referenceFields.contract.test.ts) covers the tool's inputs.
      const schema = toolInputSchemas[step.tool];
      if (!schema) {
        issues.push(issue('tool_not_allowed', `Tool '${step.tool}' cannot be used in a flow.`, { stepId: step.id, pointer: `/steps/${i}/tool` }));
        summaries.push({ id: step.id, tool: step.tool, source: 'core', tier: null, approval: step.approval });
        return;
      }
      issues.push(...zodInputIssues(schema, input, step.id, base));
      const t = coreStepTier(step.tool, input, step.id, base);
      issues.push(...t.issues);
      tier = t.tier;

      // Rule 6 — collect literal owned references.
      const owned = FLOW_OWNED_REFERENCE_FIELDS[step.tool] ?? {};
      for (const [field, kind] of Object.entries(owned)) {
        for (const lit of literalStrings(input[field])) {
          const pointer = `${base}/${escapePointerSegment(field)}${lit.index !== undefined ? `/${lit.index}` : ''}`;
          (kind === 'script' ? scriptRefs : groupRefs).push({ id: lit.value, stepId: step.id, pointer });
        }
      }
      for (const field of entry.deviceArgs) {
        for (const lit of literalStrings(input[field])) {
          const pointer = `${base}/${escapePointerSegment(field)}${lit.index !== undefined ? `/${lit.index}` : ''}`;
          deviceRefs.push({ id: lit.value, stepId: step.id, pointer });
        }
      }
    }

    // 7. Rule 4 (Decision 3): no pre-approval in a W03 draft.
    if (step.approval === 'pre_approved') {
      issues.push(issue('pre_approval_not_available', PRE_APPROVAL_MESSAGE, { stepId: step.id, pointer: `/steps/${i}/approval` }));
    }

    summaries.push({ id: step.id, tool: step.tool, source, tier, approval: step.approval });
  });

  // 8. Rule 6 — ownership, independent of approval mode. One message for
  // foreign and nonexistent alike.
  if (scriptRefs.length > 0) {
    const ok = await findOwnedScriptIds(owner, scriptRefs.map((r) => r.id));
    for (const r of scriptRefs) {
      if (!ok.has(r.id)) issues.push(issue('reference_not_owned', 'This script is not available to the flow\'s owner.', { stepId: r.stepId, pointer: r.pointer }));
    }
  }
  if (groupRefs.length > 0) {
    if (!owner.orgId) {
      for (const r of groupRefs) {
        issues.push(issue('group_in_partner_flow', 'A partner-wide flow cannot name one organization\'s device group; use a template.', { stepId: r.stepId, pointer: r.pointer }));
      }
    } else {
      const ok = await findOwnedDeviceGroupIds(owner.orgId, groupRefs.map((r) => r.id));
      for (const r of groupRefs) {
        if (!ok.has(r.id)) issues.push(issue('reference_not_owned', 'This device group is not available to the flow\'s owner.', { stepId: r.stepId, pointer: r.pointer }));
      }
    }
  }
  if (deviceRefs.length > 0) {
    if (!owner.orgId) {
      for (const r of deviceRefs) {
        issues.push(issue('device_in_partner_flow', 'A partner-wide flow cannot name a specific device; use a template such as {{trigger.device.id}}.', { stepId: r.stepId, pointer: r.pointer }));
      }
    } else {
      const ok = await findOwnedDeviceIds(owner.orgId, deviceRefs.map((r) => r.id));
      for (const r of deviceRefs) {
        if (!ok.has(r.id)) issues.push(issue('device_not_owned', 'This device is not in the flow\'s organization.', { stepId: r.stepId, pointer: r.pointer }));
      }
    }
  }

  return result(issues, summaries, document);
}

// ── W04: enable-time pins and run-time revalidation ────────────────────────

/**
 * What one step resolved to when its flow was enabled. Stored on the
 * publication (`flow_versions.step_pins`); drift is measured against it.
 */
export type FlowStepPin =
  | { stepId: string; tool: string; source: 'tenant'; tier: 1 | 2 | 3; approvalScope: 'supervised' | null; tenantToolId: string; tenantRevision: string }
  | { stepId: string; tool: string; source: 'core' | 'builtin'; tier: 1 | 2 | 3; approvalScope: 'supervised' | 'four_eyes' | null };

const pinTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const pinStepIdSchema = z.string().regex(FLOW_STEP_ID_RE);
const pinToolSchema = z.string().min(1).max(64);

/**
 * step_pins and pre_approvals come back from jsonb and decide unattended
 * Tier-3 execution, so the runner and the dispatch claim parse them on every
 * load; a parse failure fails the run 'drift' and pauses the flow.
 */
export const flowStepPinSchema: z.ZodType<FlowStepPin> = z.union([
  z.object({
    stepId: pinStepIdSchema,
    tool: pinToolSchema,
    source: z.literal('tenant'),
    tier: pinTierSchema,
    approvalScope: z.literal('supervised').nullable(),
    tenantToolId: z.string().min(1),
    tenantRevision: z.string().min(1),
  }).strict(),
  z.object({
    stepId: pinStepIdSchema,
    tool: pinToolSchema,
    source: z.enum(['core', 'builtin']),
    tier: pinTierSchema,
    approvalScope: z.enum(['supervised', 'four_eyes']).nullable(),
  }).strict(),
]);

export const flowPreApprovalBindingSchema: z.ZodType<FlowPreApprovalBinding> = z.object({
  stepId: pinStepIdSchema,
  lane: z.literal('act_asset'),
  assetKind: z.literal('script'),
  scriptId: z.string().uuid(),
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

/** Thrown by `stepPinsFor` for a step that does not resolve — only reachable for a document that is not valid. */
export class FlowStepPinError extends Error {
  constructor(readonly stepId: string) {
    super(`Flow step '${stepId}' cannot be pinned: it does not resolve against the owner's catalog.`);
    this.name = 'FlowStepPinError';
  }
}

function pinForEntry(step: FlowDocumentV1['steps'][number], entry: FlowCatalogEntry | undefined): FlowStepPin {
  if (!entry) throw new FlowStepPinError(step.id);
  if (entry.source === 'builtin') {
    return { stepId: step.id, tool: step.tool, source: 'builtin', tier: FLOW_BUILTIN_STEPS[entry.name].tier, approvalScope: null };
  }
  if (entry.source === 'tenant') {
    const tier = guardrailCheckForTenantTool(entry.descriptor).tier as 1 | 2 | 3;
    return {
      stepId: step.id, tool: step.tool, source: 'tenant', tier, approvalScope: tier === 3 ? 'supervised' : null,
      tenantToolId: entry.descriptor.id, tenantRevision: entry.descriptor.revision,
    };
  }
  const check = checkGuardrails(step.tool, literalGuardInput(step.tool, step.input));
  if (!check.allowed || check.tier === 4) throw new FlowStepPinError(step.id);
  return {
    stepId: step.id, tool: step.tool, source: 'core', tier: check.tier,
    approvalScope: check.tier === 3 ? check.approvalScope : null,
  };
}

/**
 * The enable-time pin of every step, resolved against the owner's catalog the
 * same way `validateFlowDocument` resolves it (same catalog loader, same
 * literal-input guardrail call). Call it only for a document that validated
 * with zero errors; a step that no longer resolves throws `FlowStepPinError`.
 */
export async function stepPinsFor(doc: FlowDocumentV1, ctx: FlowValidationContext): Promise<FlowStepPin[]> {
  const catalog = await loadFlowCatalog(ctx.owner);
  return doc.steps.map((step) => pinForEntry(step, catalog.get(step.tool)));
}

export type RenderedStepCheck =
  | { ok: true; tier: 1 | 2 | 3; approvalScope: 'supervised' | 'four_eyes' | null }
  | { ok: false; code: 'input_invalid' | 'tool_unavailable' | 'tool_blocked' | 'drift' | 'reference_not_owned'; message: string };

/** One text for foreign and nonexistent alike — the run's output must not be an existence oracle. */
const REFERENCE_NOT_OWNED_MESSAGE = 'A script, device group or device this step names is not available to this flow run.';
const TOOL_UNAVAILABLE_MESSAGE = 'This step\'s tool is no longer available to the flow\'s owner.';

/** Every string in a string or string[] field — rendered, so nothing is templated any more. */
function renderedStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function zodMessage(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Rendered input is invalid.';
  return `${toPointer(first.path) || '/'}: ${first.message}`;
}

/**
 * Re-check ONE rendered step before it executes (spec §6.5, plan Task A6):
 *  - the step's tool must still be in the owner's live catalog with the same
 *    source (else tool_unavailable / drift) and, for a tenant tool, the same
 *    tool id and revision (else drift);
 *  - the rendered input is validated UNMASKED (Zod / the tenant Ajv schema);
 *  - the live tier and approval scope are recomputed on the rendered input:
 *    tier 4 / not allowed ⇒ tool_blocked, a tier above the pin or a scope
 *    different from the pin ⇒ drift;
 *  - every owned reference (FLOW_OWNED_REFERENCE_FIELDS and the tool's
 *    deviceArgs) must belong to the owner (scripts) or to the RUN's org
 *    (groups, devices) — a partner-wide flow included, since a run has one
 *    org. Foreign and missing share one message.
 *  - with `siteIds` (Task A9: a site-limited manual-run triggerer's live
 *    ceiling, services/flows/triggererAccess.ts) the step's whole reach must
 *    be provably inside those sites (`reachConfinedToSites`); an empty set
 *    admits no non-builtin step at all.
 */
export async function revalidateRenderedStep(
  pin: FlowStepPin,
  rendered: Record<string, unknown>,
  ctx: { owner: ToolOwnerRef; runOrgId: string; siteIds?: ReadonlySet<string> | null },
): Promise<RenderedStepCheck> {
  const catalog = await loadFlowCatalog(ctx.owner);
  const entry = catalog.get(pin.tool);
  if (!entry) return { ok: false, code: 'tool_unavailable', message: TOOL_UNAVAILABLE_MESSAGE };
  if (entry.source !== pin.source) {
    return { ok: false, code: 'drift', message: 'This step\'s tool now resolves to a different source than when the flow was enabled.' };
  }

  let tier: 1 | 2 | 3;
  let approvalScope: 'supervised' | 'four_eyes' | null;

  if (entry.source === 'builtin') {
    const parsed = FLOW_BUILTIN_STEPS[entry.name].inputSchema.safeParse(rendered);
    if (!parsed.success) return { ok: false, code: 'input_invalid', message: zodMessage(parsed.error) };
    tier = FLOW_BUILTIN_STEPS[entry.name].tier;
    approvalScope = null;
  } else if (entry.source === 'tenant') {
    if (pin.source !== 'tenant' || entry.descriptor.id !== pin.tenantToolId || entry.descriptor.revision !== pin.tenantRevision) {
      return { ok: false, code: 'drift', message: 'This step\'s external tool changed since the flow was enabled.' };
    }
    if (!entry.validate(rendered)) {
      const e = entry.validate.errors?.[0];
      return { ok: false, code: 'input_invalid', message: e ? `${e.instancePath || '/'}: ${e.message ?? e.keyword}` : 'Rendered input is invalid.' };
    }
    tier = guardrailCheckForTenantTool(entry.descriptor).tier as 1 | 2 | 3;
    approvalScope = tier === 3 ? 'supervised' : null;
  } else {
    const schema = toolInputSchemas[pin.tool];
    if (!schema) return { ok: false, code: 'tool_unavailable', message: TOOL_UNAVAILABLE_MESSAGE };
    if (pin.tool === 'run_script' && Object.hasOwn(rendered, 'proposalId')) {
      return { ok: false, code: 'input_invalid', message: 'Flows run library scripts only; use scriptId, not proposalId.' };
    }
    const parsed = schema.safeParse(rendered);
    if (!parsed.success) return { ok: false, code: 'input_invalid', message: zodMessage(parsed.error) };
    const check = checkGuardrails(pin.tool, rendered);
    if (!check.allowed || check.tier === 4) {
      return { ok: false, code: 'tool_blocked', message: `Tool '${pin.tool}' cannot run in a flow with this input.` };
    }
    tier = check.tier;
    approvalScope = check.tier === 3 ? check.approvalScope : null;
  }

  if (tier > pin.tier || approvalScope !== pin.approvalScope) {
    return { ok: false, code: 'drift', message: 'This step\'s approval requirement changed since the flow was enabled.' };
  }

  if (entry.source === 'core') {
    const scriptIds: string[] = [];
    const groupIds: string[] = [];
    const deviceIds: string[] = [];
    for (const [field, kind] of Object.entries(FLOW_OWNED_REFERENCE_FIELDS[pin.tool] ?? {})) {
      (kind === 'script' ? scriptIds : groupIds).push(...renderedStrings(rendered[field]));
    }
    for (const field of entry.deviceArgs) deviceIds.push(...renderedStrings(rendered[field]));

    const anyNotOwned = async (ids: string[], find: (ids: string[]) => Promise<Set<string>>): Promise<boolean> => {
      if (ids.length === 0) return false;
      const owned = await find(ids);
      return ids.some((id) => !owned.has(id));
    };
    if (
      await anyNotOwned(scriptIds, (ids) => findOwnedScriptIds(ctx.owner, ids))
      || await anyNotOwned(groupIds, (ids) => findOwnedDeviceGroupIds(ctx.runOrgId, ids))
      || await anyNotOwned(deviceIds, (ids) => findOwnedDeviceIds(ctx.runOrgId, ids))
    ) {
      return { ok: false, code: 'reference_not_owned', message: REFERENCE_NOT_OWNED_MESSAGE };
    }
  }

  if (ctx.siteIds && !(await reachConfinedToSites(entry, pin, rendered, ctx.runOrgId, [...ctx.siteIds]))) {
    return { ok: false, code: 'reference_not_owned', message: SITE_REACH_MESSAGE };
  }

  return { ok: true, tier, approvalScope };
}

const SITE_REACH_MESSAGE =
  'The person who started this run is limited to specific sites, and this step could act outside them.';

/** Input keys that widen a call past the devices it names (org/site/partner/tenant ids). */
const SCOPE_WIDENING_KEY = /^(?:org|organization|site|partner|tenant|customer)_?ids?$/i;

/**
 * Task A9 security review — under a site-limited manual-run triggerer's
 * ceiling a step may execute (or park) ONLY when its reach is provably inside
 * those sites. Fail closed:
 *  - builtins (`set`, `wait`) act on no tenant data ⇒ allowed;
 *  - tenant (external) tools have no site model ⇒ refused;
 *  - a core tool is allowed only when ALL of:
 *      · no org/site/partner/tenant-id-style input key is present
 *        (`SCOPE_WIDENING_KEY`), whatever its value;
 *      · no device-group reference is present (a group's membership is not
 *        site-confined, and resolves at execution time);
 *      · the tool declares `deviceArgs` (the aiTools metadata that names the
 *        inputs carrying device ids — the platform has no separate site-arg
 *        metadata) and EVERY declared device arg is present and non-empty
 *        (an omitted optional device arg means org-wide behaviour);
 *      · every rendered device id is a device of the run org in one of the
 *        sites.
 * A refusal is `reference_not_owned` (policy: the run fails whatever
 * onFailure says); the executor is never called.
 */
async function reachConfinedToSites(
  entry: FlowCatalogEntry,
  pin: FlowStepPin,
  rendered: Record<string, unknown>,
  runOrgId: string,
  sites: string[],
): Promise<boolean> {
  if (entry.source === 'builtin') return true;
  if (entry.source !== 'core') return false;
  if (Object.keys(rendered).some((key) => SCOPE_WIDENING_KEY.test(key))) return false;
  for (const [field, kind] of Object.entries(FLOW_OWNED_REFERENCE_FIELDS[pin.tool] ?? {})) {
    if (kind !== 'script' && rendered[field] !== undefined && rendered[field] !== null) return false;
  }
  if (entry.deviceArgs.length === 0) return false;
  const deviceIds: string[] = [];
  for (const field of entry.deviceArgs) {
    const value = rendered[field];
    const ids = renderedStrings(value);
    const count = Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1;
    if (ids.length === 0 || ids.length !== count) return false;
    deviceIds.push(...ids);
  }
  const inSites = await findDeviceIdsInSites(runOrgId, deviceIds, sites);
  return deviceIds.every((id) => inSites.has(id));
}
