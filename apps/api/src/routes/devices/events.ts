import { Hono } from 'hono';
import { AUDIT_RESULTS } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { authMiddleware, requirePermission, requireScope } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { queryDeviceEventFeed } from '../../services/deviceEventFeed';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

// The feed logic lives in services/deviceEventFeed.ts (shared with the AI tool);
// re-exported so existing importers/tests of this route keep working.
export {
  likePrefixPattern,
  buildActionConditions,
  NON_AGENT_ACTOR,
  DETAILS_HAS_DEVICE_ID,
  FEED_SORT_KEY,
  FEED_TOTAL_CAP,
  mergeFeedPage,
  resolveActorLabel,
  formatActionMessage,
} from '../../services/deviceEventFeed';

export const eventsRoutes = new Hono();

eventsRoutes.use('*', authMiddleware);

// Bounded enum for event categories — kept intentionally small; new actions
// fall back to the prefix-derived category but cannot be filtered through the
// query API unless added here.
const eventCategoryEnum = z.enum([
  'device',
  'agent',
  'script',
  'patch',
  'alert',
  'policy',
  'deployment',
  'backup',
  'discovery',
  'automation',
  'maintenance',
  'monitoring',
  'ai',
  'software',
  'system',
]);

const eventsParamSchema = z.object({
  id: z.string().guid(),
});

const eventsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  category: eventCategoryEnum.optional(),
  result: z.enum(AUDIT_RESULTS).optional(),
  initiatedBy: z
    .enum(['manual', 'ai', 'automation', 'policy', 'schedule', 'agent', 'integration'])
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // Server-side "deliberate action" filter for the device-overview Activity
  // pane (issue #1726). Comma-separated list of action prefixes; a row matches
  // if its action starts with any of them. Lets the overview feed request only
  // the rows it renders instead of over-fetching and filtering client-side.
  actions: z
    .string()
    .max(500)
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
    ),
  // Opt-in to also surface automated agent.command.* commands.
  includeAutomated: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  // Whether to run the parallel unbounded count(*) over the same predicate.
  // Defaults to false so the common "last N" feed read does not pay for a full
  // history count on every load (issue #1726). When false, pagination.total is
  // null. Set true only when a total is actually rendered.
  withTotal: z
    .enum(['true', 'false'])
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
});

// GET /devices/:id/events - Get activity feed for a device from audit logs
eventsRoutes.get(
  '/:id/events',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', eventsParamSchema),
  zValidator('query', eventsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const { search, category, result, initiatedBy, from, to, page, limit, actions, withTotal, includeAutomated } =
      c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }


    return c.json(await queryDeviceEventFeed(device, { search, category, result, initiatedBy, from, to, page, limit, actions, withTotal, includeAutomated }));
  }
);
