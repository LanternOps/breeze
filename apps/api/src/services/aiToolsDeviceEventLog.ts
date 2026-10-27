/**
 * `browse_device_event_log` (full-control W13, #6783, PR B): the AI twin of the
 * live event-log browse routes (routes/systemTools/eventLogs.ts) — it runs
 * EVENT_LOGS_LIST / EVENT_LOGS_QUERY / EVENT_LOG_GET on the device's agent and
 * returns what the agent reads. It complements `search_logs` (the ingested
 * copy), which never reaches the device.
 *
 * Classes (W13 plan, quorum QW1):
 *  - `list_logs` is TIER2_READONLY (channel names and sizes only; the
 *    `execute_command event_logs_list` precedent);
 *  - `query` / `get_event` are tier-3 supervised: event CONTENT from any channel
 *    (Security / Application logs can carry credentials and PII), the
 *    `execute_command event_logs_query` base class. There is deliberately no
 *    chat-only System/Setup exemption here (#7906 lives on execute_command).
 *
 * Device scope is the central `deviceArgs` gate plus `verifyDeviceAccess`
 * (online required: the call waits on the agent). `aiExecuteCommand` applies
 * the AI remote-tools policy and stamps the AI origin. The REST router carries
 * devices:execute + requireMfa() for every action, so all three are
 * MFA-gated here (agents exempt by design). Agent-reported text is fenced via
 * RAW_TEXT_FIELDS_BY_TOOL; the raw event XML is never returned.
 */
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { aiExecuteCommand } from './aiDispatch';
import { CommandTypes } from './commandTypes';
import { mfaGatedToolError } from './aiToolMfaGate';
import { EVENT_LOG_ACTIONS, EVENT_LOG_LEVELS, MAX_EVENT_LOG_PAGE } from './aiToolSchemasDeviceOps';
import { bounded, clampLimit, clip, jsonError, notFound, thrown } from './aiToolsSoftwareShared';

type Action = (typeof EVENT_LOG_ACTIONS)[number];

/** One event's message is cut here; the model asks for `get_event` when it needs more. */
export const EVENT_MESSAGE_MAX_CHARS = 2000;

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // The route's asOptionalNumber also accepts a numeric string.
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Same mapping as the route's normalizeEventLevel (unknown and localized names become information). */
const KNOWN_LEVELS = new Set(['critical', 'error', 'warning', 'verbose']);
export function normalizeLevel(value: unknown): string {
  const v = (typeof value === 'string' ? value : '').toLowerCase();
  return KNOWN_LEVELS.has(v) ? v : 'information';
}

/** Same field picks as the route's mapEventLogFromAgent. */
export function projectEventLog(entry: unknown): Record<string, unknown> | null {
  const r = rec(entry);
  const name = r ? text(r.name) : undefined;
  if (!r || !name) return null;
  return {
    name,
    displayName: text(r.displayName) ?? name,
    recordCount: num(r.recordCount) ?? 0,
    lastWriteTime: text(r.lastWriteTime) ?? '',
  };
}

/** Same field picks as the route's mapEventEntryFromAgent, minus `rawXml`, with the message clipped. */
export function projectEvent(entry: unknown, maxMessage = EVENT_MESSAGE_MAX_CHARS): Record<string, unknown> | null {
  const r = rec(entry);
  const recordId = r ? num(r.recordId) : undefined;
  if (!r || recordId === undefined) return null;
  const message = text(r.message) ?? '';
  return {
    recordId,
    timeCreated: text(r.timeCreated) ?? '',
    level: normalizeLevel(r.level),
    source: text(r.source) ?? '',
    eventId: num(r.eventId) ?? 0,
    message: clip(message, maxMessage),
    ...(message.length > maxMessage ? { messageTruncated: true } : {}),
    category: text(r.category) ?? '',
    user: text(r.userId) ?? text(r.user) ?? null,
    computer: text(r.computer) ?? text(r.machineName) ?? '',
  };
}

/** A completed command whose payload is not the expected shape is an error, never an empty success. */
function agentShapeError(payload: Record<string, unknown> | null, what: string): string {
  const reported = payload && typeof payload.error === 'string' ? payload.error : null;
  return jsonError(reported ? `The agent reported: ${reported}` : `The agent returned an unreadable ${what}`, 'INVALID_AGENT_RESPONSE');
}

function parseStdout(stdout: string | undefined): Record<string, unknown> | null {
  try {
    return rec(JSON.parse(stdout || '{}'));
  } catch {
    return null;
  }
}

export function registerDeviceEventLogTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('browse_device_event_log', {
    tier: 1,
    domain: 'devices',
    searchHint: 'live Windows Event Viewer on one device: list logs, query events, read one event',
    deviceArgs: ['deviceId'],
    definition: {
      name: 'browse_device_event_log',
      description: 'Actions: list_logs, query, get_event on one online Windows device, read live from its agent (search_logs has the ingested copy). query and get_event return event text and need approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...EVENT_LOG_ACTIONS], description: 'The action to perform' },
          deviceId: { type: 'string', description: 'Device UUID (online, Windows)' },
          logName: { type: 'string', description: 'query / get_event: log name from list_logs (e.g. System, Application)' },
          level: { type: 'string', enum: [...EVENT_LOG_LEVELS], description: 'query: event level' },
          source: { type: 'string', description: 'query: event provider name' },
          eventId: { type: 'number', description: 'query: event id' },
          page: { type: 'number', description: `query: page (default 1, max ${MAX_EVENT_LOG_PAGE})` },
          limit: { type: 'number', description: 'Max events per page, query only (default 25, max 100)' },
          recordId: { type: 'number', description: 'get_event: record id from query' },
        },
        required: ['action', 'deviceId'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!EVENT_LOG_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const mfa = mfaGatedToolError('browse_device_event_log', action, auth);
      if (mfa) return mfa;
      if (action !== 'list_logs' && (typeof input.logName !== 'string' || input.logName.trim() === '')) {
        return jsonError('logName is required (see list_logs)', 'VALIDATION_ERROR');
      }
      if (action === 'get_event' && typeof input.recordId !== 'number') {
        return jsonError('recordId is required', 'VALIDATION_ERROR');
      }
      try {
        const access = await verifyDeviceAccess(String(input.deviceId), auth, true);
        if ('error' in access) {
          return access.error.includes('not online') ? jsonError(access.error, 'DEVICE_OFFLINE') : notFound('Device');
        }
        const device = access.device;
        if (device.osType !== 'windows') {
          return jsonError(`Event logs are a Windows feature; this device runs ${device.osType}. Use search_logs for its ingested logs.`, 'NOT_SUPPORTED');
        }
        const options = { userId: auth.user.id, timeoutMs: 30000 };

        if (action === 'list_logs') {
          const result = await aiExecuteCommand(auth, 'browse_device_event_log', device.id, CommandTypes.EVENT_LOGS_LIST, {}, options);
          if (result.status !== 'completed') return jsonError(result.error ?? 'Failed to list event logs', 'COMMAND_FAILED');
          const payload = parseStdout(result.stdout);
          if (!payload || !Array.isArray(payload.logs)) return agentShapeError(payload, 'event-log list');
          const logs = payload.logs.map(projectEventLog).filter(Boolean);
          return bounded({ device: { id: device.id, hostname: device.hostname }, logs });
        }

        if (action === 'query') {
          const page = clampLimit(input.page, 1, MAX_EVENT_LOG_PAGE);
          const limit = clampLimit(input.limit, 25, 100);
          const result = await aiExecuteCommand(auth, 'browse_device_event_log', device.id, CommandTypes.EVENT_LOGS_QUERY, {
            logName: String(input.logName),
            level: typeof input.level === 'string' ? input.level : '',
            source: typeof input.source === 'string' ? input.source : '',
            eventId: typeof input.eventId === 'number' ? input.eventId : 0,
            page,
            limit,
          }, options);
          if (result.status !== 'completed') return jsonError(result.error ?? 'Failed to query event logs', 'COMMAND_FAILED');
          const payload = parseStdout(result.stdout);
          if (!payload || !Array.isArray(payload.events)) return agentShapeError(payload, 'event query result');
          const events = payload.events.map((e) => projectEvent(e)).filter(Boolean);
          const dropped = payload.events.length - events.length;
          return bounded({
            device: { id: device.id, hostname: device.hostname },
            logName: String(input.logName),
            events,
            total: num(payload.total) ?? events.length,
            page: num(payload.page) ?? page,
            totalPages: num(payload.totalPages) ?? 1,
            ...(dropped > 0 ? { droppedMalformed: dropped } : {}),
          });
        }

        const result = await aiExecuteCommand(auth, 'browse_device_event_log', device.id, CommandTypes.EVENT_LOG_GET, {
          logName: String(input.logName),
          recordId: input.recordId as number,
        }, options);
        if (result.status !== 'completed') return jsonError(result.error ?? 'Failed to get the event', 'COMMAND_FAILED');
        const event = projectEvent(parseStdout(result.stdout), 8000);
        if (!event) return jsonError('The agent returned an unreadable event', 'INVALID_AGENT_RESPONSE');
        return bounded({ device: { id: device.id, hostname: device.hostname }, logName: String(input.logName), event });
      } catch (error) {
        return thrown('browse_device_event_log', error);
      }
    },
  });
}
