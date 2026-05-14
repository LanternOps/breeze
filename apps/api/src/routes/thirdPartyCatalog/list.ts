import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import { thirdPartyPackageCatalog } from '../../db/schema';
import { listCatalogQuerySchema } from './schemas';
import { platformAdminMiddleware } from '../../middleware/platformAdmin';

export const listRoutes = new Hono();

listRoutes.use('*', platformAdminMiddleware);

listRoutes.get('/', zValidator('query', listCatalogQuerySchema), async (c) => {
  const q = c.req.valid('query');
  const filters = [];

  if (q.vendor) filters.push(eq(thirdPartyPackageCatalog.vendor, q.vendor));
  if (q.breezeTested) {
    filters.push(eq(thirdPartyPackageCatalog.breezeTested, q.breezeTested === 'true'));
  }
  if (q.search) {
    const searchExpr = or(
      ilike(thirdPartyPackageCatalog.friendlyName, `%${q.search}%`),
      ilike(thirdPartyPackageCatalog.packageId, `%${q.search}%`),
      ilike(thirdPartyPackageCatalog.vendor, `%${q.search}%`),
    );
    if (searchExpr) filters.push(searchExpr);
  }

  const where = filters.length ? and(...filters) : undefined;

  const [rows, totalRows] = await Promise.all([
    db.select().from(thirdPartyPackageCatalog)
      .where(where)
      .orderBy(thirdPartyPackageCatalog.vendor, thirdPartyPackageCatalog.friendlyName)
      .limit(q.limit)
      .offset(q.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(thirdPartyPackageCatalog).where(where),
  ]);

  return c.json({
    items: rows,
    total: totalRows[0]?.count ?? 0,
    limit: q.limit,
    offset: q.offset,
  });
});
