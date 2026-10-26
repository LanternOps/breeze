/**
 * Tool Catalog W05 (#5220), plan Task B1 — save/enable validation of built-in
 * flow steps (moved out of flowValidator.ts; the W03 `wait`/`set` checks are
 * their schema checks and live here too).
 *
 *  - every built-in: rule 2 against its shared Zod schema, template-aware;
 *  - `notify` (Decision 14): `channelId` literal, the channel visible to the
 *    owner (rule 6: a partner-wide flow only a partner-wide channel) and of a
 *    supported type;
 *  - `http_request` (Decision 12): method and origin literal, HTTPS (http only
 *    with the self-hosted private-egress flag), not Breeze's own origin,
 *    literal header names outside the deny-list, no credential-looking literal
 *    header/query value or URL userinfo;
 *  - `ai` (Decision 13): every allowlisted tool is Tier 1 in the owner's live
 *    catalog (never a flow tool, `run_flow` or a built-in); `output` is a
 *    literal object JSON Schema that compiles, ≤ 16 KB and depth ≤ 8.
 *
 * `builtinStepTier` is the tier a built-in step pins and is revalidated
 * against: `tierFor(input)`, and for `ai` the max LIVE tier of its tools
 * (transitive — a tool whose tier rises makes the step drift instead of
 * hiding a higher-tier effect behind a Tier-1 step; quorum top risk 3).
 */
import {
  FLOW_BUILTIN_STEPS,
  FLOW_RUN_LIMITS,
  flowBuiltinTierFor,
  type FlowBuiltinName,
  type FlowDocumentV1,
  type FlowIssue,
} from '@breeze/shared';
import { checkGuardrails } from '../aiGuardrails';
import { isChannelMessageType } from '../notificationSenders/channelMessageTypes';
import { guardrailCheckForTenantTool } from '../toolSources/guardrails';
import { compileTenantInputSchema, type ToolOwnerRef } from '../toolSources/resolver';
import {
  isAllowedHeaderName,
  isAllowedHttpProtocol,
  isBreezeOwnHostname,
  literalOriginOf,
  literalUrlQueryPairs,
  looksLikeCredential,
} from './builtins/httpPolicy';
import type { FlowCatalog } from './catalog';
import { findOwnedNotificationChannel } from './ownedReferences';
import { containsTemplate, escapePointerSegment, issue, utf8Bytes, zodInputIssues } from './validationIssues';

type FlowStep = FlowDocumentV1['steps'][number];

export interface BuiltinValidationContext {
  owner: ToolOwnerRef;
  catalog: FlowCatalog;
}

/** A flow tool (`flow__<slug>`, W5 Decision 7) — never a step, never an `ai` tool. */
export const FLOW_TOOL_PREFIX = 'flow__';
export function isFlowToolName(name: string): boolean {
  return name.startsWith(FLOW_TOOL_PREFIX);
}

/** Tools an `ai` step may never allowlist, whatever their tier. */
const AI_NEVER_TOOLS: ReadonlySet<string> = new Set(['run_flow']);

const AI_OUTPUT_MAX_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonDepth(value: unknown, depth = 0): number {
  if (Array.isArray(value)) return value.reduce<number>((m, v) => Math.max(m, jsonDepth(v, depth + 1)), depth + 1);
  if (isRecord(value)) return Object.values(value).reduce<number>((m, v) => Math.max(m, jsonDepth(v, depth + 1)), depth + 1);
  return depth;
}

/**
 * The live tier of one tool an `ai` step allowlists, or null when it is not
 * allowed at all (missing, a flow tool, `run_flow`, a built-in, blocked).
 */
export function aiAllowlistedToolTier(name: string, catalog: FlowCatalog): 1 | 2 | 3 | null {
  if (name.includes('{{') || isFlowToolName(name) || AI_NEVER_TOOLS.has(name)) return null;
  const entry = catalog.get(name);
  if (!entry || entry.source === 'builtin') return null;
  if (entry.source === 'tenant') return guardrailCheckForTenantTool(entry.descriptor).tier as 1 | 2 | 3;
  // A core tool's base tier (no action): the tier of the tool as a whole. A
  // model call's own input is re-checked against Tier 1 at call time.
  const check = checkGuardrails(name, {});
  if (!check.allowed || check.tier >= 4) return null;
  return check.tier as 1 | 2 | 3;
}

/** The tier a built-in step pins (and is revalidated against at run time). */
export function builtinStepTier(step: Pick<FlowStep, 'tool' | 'input'>, catalog: FlowCatalog): 1 | 2 | 3 {
  const name = step.tool as FlowBuiltinName;
  const own = flowBuiltinTierFor(name, step.input);
  if (name !== 'ai') return own;
  const tools = Array.isArray(step.input.tools) ? step.input.tools : [];
  let tier: 1 | 2 | 3 = own;
  for (const t of tools) {
    // Fail closed: anything that is not a live, allowed tool counts as Tier 3.
    const live = typeof t === 'string' ? aiAllowlistedToolTier(t, catalog) ?? 3 : 3;
    if (live > tier) tier = live;
  }
  return tier;
}

// ── notify ──────────────────────────────────────────────────────────────────

async function channelIssues(channelId: unknown, owner: ToolOwnerRef, at: { stepId?: string; pointer: string }): Promise<FlowIssue[]> {
  if (containsTemplate(channelId)) {
    return [issue('notify_channel_not_literal', 'The channel must be chosen in the flow, not from a template.', at)];
  }
  if (typeof channelId !== 'string') return []; // rule 2 reports the shape
  const channel = await findOwnedNotificationChannel(owner, channelId);
  if (!channel) {
    return [issue('notify_channel_not_owned', owner.orgId
      ? 'This notification channel is not available to the flow\'s organization.'
      : 'A partner-wide flow can only use a partner-wide notification channel.', at)];
  }
  if (!isChannelMessageType(channel.type)) {
    return [issue('channel_type_not_supported', `A flow cannot send notices to a ${channel.type} channel; use email, Slack, Teams, SMS or Pushover.`, at)];
  }
  return [];
}

/** The document's `notices.channelId` (Decision 14), checked like a `notify` channel. */
export function validateNoticesChannel(channelId: string, owner: ToolOwnerRef): Promise<FlowIssue[]> {
  return channelIssues(channelId, owner, { pointer: '/notices/channelId' });
}

// ── http_request ────────────────────────────────────────────────────────────

function httpRequestIssues(input: Record<string, unknown>, stepId: string, base: string): FlowIssue[] {
  const out: FlowIssue[] = [];
  const at = (field: string) => ({ stepId, pointer: `${base}/${escapePointerSegment(field)}` });

  if (containsTemplate(input.method)) {
    out.push(issue('http_method_not_literal', 'The HTTP method must be literal, not a template.', at('method')));
  }

  if (typeof input.url === 'string') {
    const origin = literalOriginOf(input.url);
    if (!origin.ok) {
      out.push(origin.reason === 'userinfo'
        ? issue('secret_in_document', 'Credentials cannot be written into the URL.', at('url'))
        : issue('http_origin_not_literal', 'The URL must start with a literal https:// origin; only the path and query may use templates.', at('url')));
    } else if (!isAllowedHttpProtocol(origin.protocol)) {
      out.push(issue('http_origin_not_literal', 'Only https:// URLs are allowed.', at('url')));
    } else if (isBreezeOwnHostname(origin.hostname)) {
      out.push(issue('http_origin_not_allowed', 'A flow cannot call Breeze itself.', at('url')));
    }
    if (literalUrlQueryPairs(input.url).some(([k, v]) => looksLikeCredential(k, v))) {
      out.push(issue('secret_in_document', 'The URL carries what looks like a credential; requests are anonymous.', at('url')));
    }
  } else if (containsTemplate(input.url)) {
    out.push(issue('http_origin_not_literal', 'The URL must start with a literal https:// origin.', at('url')));
  }

  if (isRecord(input.headers)) {
    for (const [name, value] of Object.entries(input.headers)) {
      const pointer = `${base}/headers/${escapePointerSegment(name)}`;
      if (!isAllowedHeaderName(name)) {
        out.push(issue('http_header_not_allowed', `Header '${name}' cannot be set by a flow.`, { stepId, pointer }));
      } else if (typeof value === 'string' && looksLikeCredential(name, value)) {
        out.push(issue('secret_in_document', `Header '${name}' carries what looks like a credential; requests are anonymous.`, { stepId, pointer }));
      }
    }
  }
  if (isRecord(input.query)) {
    for (const [name, value] of Object.entries(input.query)) {
      if (typeof value === 'string' && looksLikeCredential(name, value)) {
        out.push(issue('secret_in_document', `Query parameter '${name}' carries what looks like a credential; requests are anonymous.`, {
          stepId, pointer: `${base}/query/${escapePointerSegment(name)}`,
        }));
      }
    }
  }
  return out;
}

// ── ai ──────────────────────────────────────────────────────────────────────

function aiIssues(input: Record<string, unknown>, stepId: string, base: string, catalog: FlowCatalog): FlowIssue[] {
  const out: FlowIssue[] = [];
  if (Array.isArray(input.tools)) {
    input.tools.forEach((t, idx) => {
      if (typeof t !== 'string') return; // rule 2 reports the shape
      if (aiAllowlistedToolTier(t, catalog) !== 1) {
        out.push(issue('ai_tool_not_tier1', `'${t}' cannot be given to an AI step; only Tier-1 read tools available to this flow can.`, {
          stepId, pointer: `${base}/tools/${idx}`,
        }));
      }
    });
  }
  if (input.output !== undefined) {
    const output = input.output;
    const at = { stepId, pointer: `${base}/output` };
    if (!isRecord(output) || output.type !== 'object') {
      out.push(issue('ai_output_schema_invalid', 'The result must be described by a JSON Schema of type "object".', at));
    } else if (containsTemplate(output)) {
      out.push(issue('ai_output_schema_invalid', 'The result schema must be literal.', at));
    } else if (utf8Bytes(output) > FLOW_RUN_LIMITS.aiOutputSchemaMaxBytes) {
      out.push(issue('ai_output_schema_invalid', `The result schema is larger than ${FLOW_RUN_LIMITS.aiOutputSchemaMaxBytes} bytes.`, at));
    } else if (jsonDepth(output) > AI_OUTPUT_MAX_DEPTH) {
      out.push(issue('ai_output_schema_invalid', `The result schema is nested deeper than ${AI_OUTPUT_MAX_DEPTH} levels.`, at));
    } else if (!compileTenantInputSchema(output)) {
      out.push(issue('ai_output_schema_invalid', 'The result schema is not a valid JSON Schema.', at));
    }
  }
  return out;
}

// ── entry point ─────────────────────────────────────────────────────────────

/** Every save/enable issue of one built-in step (`index` is its position in `steps`). */
export async function validateBuiltinStep(step: FlowStep, index: number, ctx: BuiltinValidationContext): Promise<FlowIssue[]> {
  const name = step.tool as FlowBuiltinName;
  const base = `/steps/${index}/input`;
  const input = step.input;
  const issues: FlowIssue[] = [...zodInputIssues(FLOW_BUILTIN_STEPS[name].inputSchema, input, step.id, base)];
  switch (name) {
    case 'notify':
      issues.push(...await channelIssues(input.channelId, ctx.owner, { stepId: step.id, pointer: `${base}/channelId` }));
      break;
    case 'http_request':
      issues.push(...httpRequestIssues(input, step.id, base));
      break;
    case 'ai':
      issues.push(...aiIssues(input, step.id, base, ctx.catalog));
      break;
    case 'wait':
    case 'set':
      break;
    default: {
      const exhaustive: never = name;
      throw new Error(`unhandled built-in ${String(exhaustive)}`);
    }
  }
  return issues;
}
