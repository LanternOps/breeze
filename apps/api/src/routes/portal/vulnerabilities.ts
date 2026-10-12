import { Hono } from 'hono';
import { z } from 'zod';
import { VULN_STATUSES } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import {
  vulnerabilityDetailFindings,
  vulnerabilityDetailSummary,
} from '../../services/portal/vulnerabilityDetailReadModel';
import { respondWithPortalPrivateCache } from './helpers';

export const portalVulnerabilityRoutes = new Hono();

// Portal advanced visibility W06 (#7736). Gated by enableVulnerabilityDetail (strict
// 403) in routes/portal/index.ts. The organization always comes from portalAuth.
const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Defaults to open findings, the population the security overview counts.
  status: z.enum(VULN_STATUSES).default('open'),
});
const findingsQuery = paginationQuery.extend({ deviceId: z.string().uuid().optional() });

portalVulnerabilityRoutes.get('/vulnerabilities/summary', zValidator('query', paginationQuery), async (c) => {
  const auth = c.get('portalAuth');
  return respondWithPortalPrivateCache(c, await vulnerabilityDetailSummary(auth.user.orgId, {
    ...c.req.valid('query'), now: new Date(),
  }));
});

portalVulnerabilityRoutes.get('/vulnerabilities/findings', zValidator('query', findingsQuery), async (c) => {
  const auth = c.get('portalAuth');
  const result = await vulnerabilityDetailFindings(auth.user.orgId, {
    ...c.req.valid('query'), now: new Date(),
  });
  if (!result) return c.json({ error: 'Device not found' }, 404);
  return respondWithPortalPrivateCache(c, result);
});
