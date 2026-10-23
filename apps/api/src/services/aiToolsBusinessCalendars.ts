/**
 * Business-hours calendars AI tool (#8973 W4, spec §5.7).
 *
 *  - list_business_calendars (Tier 1, tickets.read): the calendars the caller
 *    can see — an org's own plus its partner's partner-wide ones — and, for an
 *    org, which one a new ticket would use now (org override → partner
 *    default → none = 24×7).
 *
 * Writes stay human-only in v1. Reads go through the same explicit-owner
 * service read the routes use, on the caller's connection, so an org-scope
 * caller sees its partner's partner-wide calendars through the partner-wide
 * SELECT branch and nothing of another org (Gate B1).
 *
 * The service is imported lazily (it imports the db graph, which the tool hub
 * must not pull in at module load).
 */
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { captureException } from './sentry';

const json = (v: unknown) => JSON.stringify(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function registerBusinessCalendarTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_business_calendars', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'business hours calendars used for ticket SLA deadlines, holidays, which hours apply to an org',
    deviceArgs: [],
    definition: {
      name: 'list_business_calendars',
      description: "List business-hours calendars (weekly hours, time zone, holidays) used for ticket SLA deadlines, including the partner's all-organizations calendars, and which one applies to an organization.",
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: "Only this organization's calendars plus its partner-wide ones (UUID). Org-scoped callers always get their own org." },
          includeArchived: { type: 'boolean', description: 'Include archived calendars (default false).' },
          limit: { type: 'integer', description: 'Max calendars (default 50, max 100)' },
        },
      },
    },
    handler: async (input: Record<string, unknown>, auth: AuthContext): Promise<string> => {
      const { listCalendars, getResolvedCalendarForOrg, BusinessCalendarError } = await import('./businessCalendars/service');
      try {
        const orgId = auth.scope === 'organization' ? (auth.orgId ?? undefined) : str(input.orgId);
        const includeArchived = input.includeArchived === true;
        const limit = typeof input.limit === 'number' ? Math.min(Math.max(1, Math.floor(input.limit)), 100) : 50;
        const calendars = (await listCalendars(auth, { orgId, includeArchived })).slice(0, limit);
        const applies = orgId ? await getResolvedCalendarForOrg(auth, orgId) : null;
        return json(applies ? { calendars, applies } : { calendars });
      } catch (err) {
        if (err instanceof BusinessCalendarError) return json({ error: err.message, code: err.code });
        console.error('[list_business_calendars]', err);
        captureException(err, undefined, { tool: 'list_business_calendars' });
        return json({ error: 'Operation failed. Check server logs for details.' });
      }
    },
  });
}
