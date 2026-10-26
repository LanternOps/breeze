/**
 * `manage_time_suggestions` (full-control W06, #6776): the AI twin of
 * routes/timeEntries/suggestions.ts — the technician's remote-session time
 * suggestions: list, confirm (logs a time entry), dismiss, undo (restore).
 *
 * Own suggestions only: the route lets an admin read another technician's day;
 * the AI actor is never `manageAll`, so `userId` is not an input at all.
 * Confirming logs a time entry as the caller, the same bookkeeping class as
 * `manage_tickets:log_time_entry` (tier 2). All four actions refuse an
 * `ai_agent` principal on writes: the entry is the signed-in person's, and a
 * users-FK actor is required (same posture as `log_time_entry`).
 *
 * Suggestion rows carry a ticket subject (requester-authored) and a device
 * hostname (self-reported): both are fenced in `RAW_TEXT_FIELDS_BY_TOOL`.
 */
import { confirmSuggestionSchema, suggestionSignalsSchema, suggestionsQuerySchema } from '@breeze/shared';
import type { AiTool } from './aiTools';
import { TIME_SUGGESTION_ACTIONS } from './aiToolSchemasTicketOps';
import { timeEntryActorFrom } from './aiToolsTicketing';
import {
  agentRefusal,
  isAgentPrincipal,
  isPartnerOrSystem,
  json,
  jsonError,
  parseData,
  partnerScopeRequiredError,
  serviceErrorJson,
} from './aiToolsTicketOpsShared';
import {
  confirmTimeSuggestion,
  dismissTimeSuggestions,
  listTimeSuggestions,
  undismissTimeSuggestions,
  type SuggestionActor,
} from './timeSuggestionService';

type SuggestionAction = (typeof TIME_SUGGESTION_ACTIONS)[number];

export function registerTimeSuggestionTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_time_suggestions', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'time entry suggestions from remote sessions: see unlogged work for a day, log it, dismiss it, restore a dismissed one',
    deviceArgs: [],
    definition: {
      name: 'manage_time_suggestions',
      description:
        'Your time-entry suggestions from remote sessions. Actions: list (a day),confirm (logs a time entry),dismiss,undo (restores a dismissed one).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TIME_SUGGESTION_ACTIONS], description: 'The action to perform' },
          date: { type: 'string', description: 'list: the day, YYYY-MM-DD' },
          tz: { type: 'string', description: 'list: IANA time zone (default: the partner time zone)' },
          signals: {
            type: 'array',
            items: { type: 'object' },
            description: 'dismiss/undo: the suggestion signals [{kind:"remote_session",id}] from list',
          },
          data: {
            type: 'object',
            description: 'confirm: signals, startedAt, endedAt, ticketId, description, isBillable (same as the UI sheet)',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as SuggestionAction;
      if (!TIME_SUGGESTION_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      // routes/timeEntries/suggestions.ts: requireScope('partner','system') + time_entries:read|write.
      if (!isPartnerOrSystem(auth)) return partnerScopeRequiredError();
      if (isAgentPrincipal(auth)) return agentRefusal(action);

      const actor: SuggestionActor = { ...(await timeEntryActorFrom(auth)), scope: auth.scope as 'partner' | 'system' };
      try {
        if (action === 'list') {
          const parsed = parseData(suggestionsQuerySchema, { date: input.date, ...(input.tz !== undefined ? { tz: input.tz } : {}) });
          if ('error' in parsed) return parsed.error;
          return json(await listTimeSuggestions(actor, parsed.value));
        }
        if (action === 'confirm') {
          const parsed = parseData(confirmSuggestionSchema, input.data);
          if ('error' in parsed) return parsed.error;
          const { entry, replay } = await confirmTimeSuggestion(parsed.value, actor);
          return json(replay ? { entry, replay: true } : { entry });
        }
        const parsed = parseData(suggestionSignalsSchema, { signals: input.signals });
        if ('error' in parsed) return parsed.error;
        if (action === 'dismiss') await dismissTimeSuggestions(parsed.value.signals, actor);
        else await undismissTimeSuggestions(parsed.value.signals, actor);
        return json({ ok: true, action, signals: parsed.value.signals.length });
      } catch (err) {
        const mapped = serviceErrorJson(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  });
}
