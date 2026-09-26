import { Hono, type Context } from 'hono';
import { topologyInterfaceHistoryQuerySchema } from '@breeze/shared';
import { GraphReadError } from '../../services/topology/graphCursor';
import { getTopologyLinkHealth, getTopologyReadEtag } from '../../services/topology/graph';
import { getTopologyInterfaceHistory } from '../../services/topology/interfaceHistory';
import { recordTopologyHistoryRead } from '../../services/topology/metrics';
import { requireTopologySiteCapability } from './middleware';
import { siteScopedQuery } from './query';

/**
 * M3 Task 6 reads: bounded interface history and current link health.
 * Both are passive — they read stored measurements only and never poll, probe
 * or queue a command. History is evidence (`private, no-store`, no ETag);
 * link health carries a permission-scoped, content-derived ETag so a freshness
 * expiry changes the validator without a revision write.
 */
export const topologyHistoryRoutes = new Hono();
const invalid = (message = 'Invalid topology query') => new GraphReadError('invalid_topology_query', 400, message);
function read(handler: (c: Context) => Promise<object>, sensitive: boolean) {
  return async (c: Context) => {
    c.header('Cache-Control', sensitive ? 'private, no-store' : 'private, no-cache, max-age=0');
    c.header('Vary', 'Authorization, Cookie');
    try {
      const body = await handler(c);
      const etag = sensitive ? undefined : getTopologyReadEtag(body);
      if (etag) {
        c.header('ETag', etag);
        if (c.req.header('If-None-Match')?.split(',').map((value) => value.trim()).includes(etag)) return c.body(null, 304);
      }
      return c.json(body);
    } catch (error) {
      if (error instanceof GraphReadError) return c.json({ error: error.message, code: error.code }, error.status);
      throw error;
    }
  };
}
const HISTORY_KEYS = new Set(['series', 'from', 'to', 'resolution', 'maxBuckets']);
const base = '/sites/:siteId';
const authorized = requireTopologySiteCapability('read');

topologyHistoryRoutes.get(`${base}/interfaces/:interfaceId/history`, authorized, read(async (c) => {
  const query = siteScopedQuery(c, (message) => invalid(message));
  if (Object.keys(query).some((key) => !HISTORY_KEYS.has(key))) throw invalid();
  const parsed = topologyInterfaceHistoryQuerySchema.safeParse({
    series: query.series ? query.series.split(',') : undefined, from: query.from, to: query.to,
    ...(query.resolution === undefined ? {} : { resolution: query.resolution }),
    ...(query.maxBuckets === undefined ? {} : { maxBuckets: /^\d{1,5}$/.test(query.maxBuckets) ? Number(query.maxBuckets) : query.maxBuckets }),
  });
  if (!parsed.success) throw invalid('Invalid interface history query');
  const history = await getTopologyInterfaceHistory(c.get('topologyContext'), c.req.param('interfaceId') ?? '', parsed.data);
  if (history.interval) {
    const buckets = (Date.parse(history.interval.to) - Date.parse(history.interval.from)) / (history.interval.bucketSeconds * 1000);
    recordTopologyHistoryRead(history.resolution, Math.round(buckets));
  }
  return history;
}, true));

topologyHistoryRoutes.get(`${base}/relationships/:relationshipId/health`, authorized, read((c) => {
  if (Object.keys(siteScopedQuery(c, (message) => invalid(message))).length) throw invalid();
  return getTopologyLinkHealth(c.get('topologyContext'), c.req.param('relationshipId') ?? '');
}, false));
