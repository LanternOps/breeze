import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import type { AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { suggestionsQuerySchema, confirmSuggestionSchema, suggestionSignalsSchema } from '@breeze/shared';
import {
  listTimeSuggestions, confirmTimeSuggestion, dismissTimeSuggestions, undismissTimeSuggestions,
  type SuggestionActor,
} from '../../services/timeSuggestionService';
import {
  timeActorFrom, timeEntryAuditCollector, writeSimpleTimeEntryAudits, handleServiceError,
} from './timeEntries';

// W06 (#3900). Same gates as every other time-entry route: partner|system scope
// plus TIME_ENTRIES_READ/WRITE. An org-scoped token gets the router's usual 403
// (F18). No auth middleware here — routes/timeEntries/index.ts applies it at the
// hub, and requireScope/requirePermission depend on c.get('auth') already being
// populated.
export const timeSuggestionRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TIME_ENTRIES_READ.resource, PERMISSIONS.TIME_ENTRIES_READ.action);
const writePerm = requirePermission(PERMISSIONS.TIME_ENTRIES_WRITE.resource, PERMISSIONS.TIME_ENTRIES_WRITE.action);

type SuggestionCtx = Parameters<typeof timeActorFrom>[0];

/**
 * Carries the auth scope onto the actor (`timeActorFrom` does not). The scope
 * NARROWING is done here at the router by `requireScope('partner','system')`
 * plus the service's explicit `o.partner_id = $n` / `rs.user_id = $n`
 * predicates — the service does not read `actor.scope`, so this field is
 * descriptive metadata for logs and future callers, not a tenancy gate.
 */
function suggestionActor(
  c: SuggestionCtx,
  record?: Parameters<typeof timeActorFrom>[1],
): SuggestionActor {
  const auth = c.get('auth') as AuthContext;
  return { ...timeActorFrom(c, record), scope: auth.scope as 'partner' | 'system' };
}

timeSuggestionRoutes.get('/', scopes, readPerm, zValidator('query', suggestionsQuerySchema), async (c) => {
  try {
    const q = c.req.valid('query');
    const actor = suggestionActor(c);
    // Identical rule to GET /timesheet: reading someone else's day is an
    // admin action. Passing your OWN id is always allowed.
    if (q.userId && q.userId !== actor.userId && !actor.manageAll) {
      return c.json({ error: 'Viewing other technicians’ suggestions requires an admin role' }, 403);
    }
    return c.json({ data: await listTimeSuggestions(actor, q) });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeSuggestionRoutes.post('/confirm', scopes, writePerm, zValidator('json', confirmSuggestionSchema), async (c) => {
  try {
    const audit = timeEntryAuditCollector(c);
    const actor = suggestionActor(c, (m) => audit.mutations.push(m));
    const { entry, replay } = await confirmTimeSuggestion(c.req.valid('json'), actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    // 200 on replay so an offline queue drain can tell "already logged" from
    // "logged just now" without parsing the body (F4).
    return c.json(replay ? { data: entry, replay: true } : { data: entry }, replay ? 200 : 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeSuggestionRoutes.post('/dismiss', scopes, writePerm, zValidator('json', suggestionSignalsSchema), async (c) => {
  try {
    const audit = timeEntryAuditCollector(c);
    const actor = suggestionActor(c, (m) => audit.mutations.push(m));
    await dismissTimeSuggestions(c.req.valid('json').signals, actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    return c.body(null, 204);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

timeSuggestionRoutes.delete('/dismiss', scopes, writePerm, zValidator('json', suggestionSignalsSchema), async (c) => {
  try {
    const audit = timeEntryAuditCollector(c);
    const actor = suggestionActor(c, (m) => audit.mutations.push(m));
    await undismissTimeSuggestions(c.req.valid('json').signals, actor);
    writeSimpleTimeEntryAudits(c, audit.mutations);
    return c.body(null, 204);
  } catch (err) {
    return handleServiceError(c, err);
  }
});
