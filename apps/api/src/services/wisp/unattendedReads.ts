import { z } from 'zod';
import {
  MAX_READONLY_EVENT_LOG_LIMIT,
  MAX_READONLY_EVENT_LOG_PAGE,
} from '../aiChatEventLogsReadOnly';

/**
 * #10973 / Wisp delegation W3 — the exact calls the grant-level "unattended
 * reads" switch lets run without a card (plan Decisions 1 and 8):
 *
 *   - `registry_operations` `read_key` / `get_value`;
 *   - `execute_command` `event_logs_query` on the Security channel, optionally
 *     with an XPath from the restricted grammar below;
 *   - `set_device_context`, an explicitly authorized WRITE exception: a note on
 *     the device, never an effect on it.
 *
 * Nothing here decides whether the switch is on. A non-null answer only means
 * "the switch would cover this call"; both gates (aiAgentSdk.ts, runLoop.ts)
 * still read the grant first.
 *
 * Why a grammar rather than a denylist: `query` reaches the agent's
 * `-FilterXPath` verbatim, and a QueryList selector can read another channel
 * whatever `logName` says (aiChatEventLogsReadOnly.ts). The parser accepts a
 * closed set of System-element predicates and refuses everything else, so
 * `QueryList`, `Path`, `Select`, `Suppress`, `EventData`, `UserData` and any
 * other attribute cannot parse rather than having to be listed.
 *
 * CLASSIFY == DISPATCH. `pinned` is a detached, deep-frozen copy of the parsed
 * call. The tool handler receives it instead of the model's arguments
 * (aiAgentSdkTools.ts), so the call that runs is the call that was classified.
 *
 * Pure and DB-free: aiGuardrails.ts imports this module, and its import surface
 * is pinned (aiGuardrails.imports.contract.test.ts). So the bounds below repeat
 * the tool schemas instead of importing aiToolSchemas.ts; a test asserts every
 * accepted call also passes the tool's own schema.
 */

export type WispUnattendedRead =
  | { kind: 'registry_read'; tool: 'registry_operations'; pinned: Readonly<Record<string, unknown>> }
  | { kind: 'security_event_query'; tool: 'execute_command'; pinned: Readonly<Record<string, unknown>> }
  | { kind: 'device_context'; tool: 'set_device_context'; pinned: Readonly<Record<string, unknown>> };

const MAX_SECURITY_XPATH_LENGTH = 500;
const MAX_XPATH_GROUP_DEPTH = 8;
const NO_CONTROL_CHARACTERS = /^[^\u0000-\u001f\u007f]*$/;
// Event provider names, as in aiChatEventLogsReadOnly.ts.
const SOURCE_PATTERN = /^[A-Za-z0-9 ._-]{1,255}$/;

const deviceId = z.string().uuid();

const registryReadShape = {
  action: z.enum(['read_key', 'get_value']),
  deviceId,
  keyPath: z.string().min(1).max(1024).regex(NO_CONTROL_CHARACTERS),
  valueName: z.string().max(256).regex(NO_CONTROL_CHARACTERS).optional(),
};
const registryReadSchema = z.strictObject(registryReadShape)
  .refine((d) => d.action !== 'get_value' || !!d.valueName);

const securityEventPayloadSchema = z.strictObject({
  logName: z.string().refine((v) => v.toLowerCase() === 'security').transform(() => 'Security'),
  query: z.string().max(MAX_SECURITY_XPATH_LENGTH).refine((v) => isAllowedSecurityXPath(v)).optional(),
  source: z.string().regex(SOURCE_PATTERN).optional(),
  level: z.union([
    z.enum(['critical', 'error', 'warning', 'information', 'info', 'verbose']),
    z.number().int().min(1).max(5),
  ]).optional(),
  eventId: z.number().int().min(0).max(0xffff).optional(),
  page: z.number().int().min(1).max(MAX_READONLY_EVENT_LOG_PAGE).optional(),
  limit: z.number().int().min(1).max(MAX_READONLY_EVENT_LOG_LIMIT).optional(),
}).refine((d) => d.query === undefined || (d.source === undefined && d.level === undefined && d.eventId === undefined));

const securityEventShape = {
  deviceId,
  commandType: z.literal('event_logs_query'),
  payload: securityEventPayloadSchema,
};
const securityEventSchema = z.strictObject(securityEventShape);

const deviceContextShape = {
  deviceId,
  contextType: z.enum(['issue', 'quirk', 'followup', 'preference']),
  summary: z.string().min(1).max(255),
  details: z.record(z.string(), z.unknown()).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
};
const deviceContextSchema = z.strictObject(deviceContextShape);

/** Every input key the classification reads, per tool. */
export const WISP_UNATTENDED_READ_DECIDING_KEYS: Readonly<Record<string, readonly string[]>> = {
  registry_operations: Object.keys(registryReadShape),
  execute_command: Object.keys(securityEventShape),
  set_device_context: Object.keys(deviceContextShape),
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A detached, frozen copy: mutating the model's input afterwards cannot reach it. */
function pin(parsed: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return deepFreeze(structuredClone(parsed));
}

/**
 * The restricted XPath grammar, by recursive descent over the raw string:
 *
 *   query := '*[System[' expr ']]'
 *   expr  := term ( ('and' | 'or') term )*
 *   term  := '(' expr ')'
 *          | 'EventID=' digits
 *          | 'Level=' [1-5]
 *          | "Provider[@Name='" [A-Za-z0-9 ._-]{1,128} "']"
 *          | 'TimeCreated[timediff(@SystemTime) <= ' digits ']'
 *
 * Only the space character separates tokens.
 */
function isAllowedSecurityXPath(query: string): boolean {
  const prefix = '*[System[';
  const suffix = ']]';
  if (!query.startsWith(prefix) || !query.endsWith(suffix)) return false;
  const body = query.slice(prefix.length, query.length - suffix.length);
  let at = 0;

  const skipSpaces = () => { while (body[at] === ' ') at += 1; };
  const take = (pattern: RegExp): boolean => {
    pattern.lastIndex = at;
    const match = pattern.exec(body);
    if (!match) return false;
    at += match[0].length;
    return true;
  };

  const term = (depth: number): boolean => {
    skipSpaces();
    if (body[at] === '(') {
      if (depth >= MAX_XPATH_GROUP_DEPTH) return false;
      at += 1;
      if (!expr(depth + 1)) return false;
      skipSpaces();
      if (body[at] !== ')') return false;
      at += 1;
      return true;
    }
    return take(/EventID=\d{1,5}(?![A-Za-z0-9_])/y)
      || take(/Level=[1-5](?![A-Za-z0-9_])/y)
      || take(/Provider\[@Name='[A-Za-z0-9 ._-]{1,128}'\]/y)
      || take(/TimeCreated\[timediff\(@SystemTime\) <= \d{1,12}\]/y);
  };

  const expr = (depth: number): boolean => {
    if (!term(depth)) return false;
    for (;;) {
      const before = at;
      skipSpaces();
      if (!take(/(?:and|or) /y)) {
        at = before;
        return true;
      }
      if (!term(depth)) return false;
    }
  };

  if (!expr(0)) return false;
  skipSpaces();
  return at === body.length;
}

/**
 * The pinned call when `toolName` + `input` is one of the four reads, or `null`
 * (the call keeps whatever tier and card it already has) otherwise.
 */
export function classifyWispUnattendedRead(toolName: string, input: unknown): WispUnattendedRead | null {
  if (toolName === 'registry_operations') {
    const parsed = registryReadSchema.safeParse(input);
    return parsed.success ? Object.freeze({ kind: 'registry_read', tool: toolName, pinned: pin(parsed.data) }) : null;
  }
  if (toolName === 'execute_command') {
    const parsed = securityEventSchema.safeParse(input);
    return parsed.success ? Object.freeze({ kind: 'security_event_query', tool: toolName, pinned: pin(parsed.data) }) : null;
  }
  if (toolName === 'set_device_context') {
    const parsed = deviceContextSchema.safeParse(input);
    return parsed.success ? Object.freeze({ kind: 'device_context', tool: toolName, pinned: pin(parsed.data) }) : null;
  }
  return null;
}
