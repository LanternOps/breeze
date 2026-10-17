import { Hono } from 'hono';
import { GraphReadError } from '../../services/topology/graphCursor';
import { readSitePresence } from '../../services/topology/presenceRead';
import { requireTopologySiteCapability } from './middleware';

/**
 * Site location W2 (#7886, spec S§8 R1, R7, S§9): observed presence for one site, separate from the graph so the
 * graph ETag, AI allowlists and schemaVersion stay untouched. Same entry gate as the graph reads
 * (`topology:read` + `devices:read` on the viewed site; unknown/hidden site → 404). The ETag binds the
 * authority digest (allowed sites and grants), so two viewers with different site access never share a 304.
 */
export const topologyPresenceRoutes = new Hono();

topologyPresenceRoutes.get('/sites/:siteId/presence', requireTopologySiteCapability('read'), async (c) => {
  c.header('Cache-Control', 'private, no-cache, max-age=0');
  c.header('Vary', 'Authorization, Cookie');
  try {
    const { body, etag } = await readSitePresence(c.get('topologyContext'));
    c.header('ETag', etag);
    if (c.req.header('If-None-Match')?.split(',').map((value) => value.trim()).includes(etag)) return c.body(null, 304);
    return c.json(body);
  } catch (error) {
    if (error instanceof GraphReadError) return c.json({ error: error.message, code: error.code }, error.status);
    throw error;
  }
});
