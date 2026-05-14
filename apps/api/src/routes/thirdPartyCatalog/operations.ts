import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { thirdPartyPackageCatalog } from '../../db/schema';
import { upsertCatalogSchema } from './schemas';
import { platformAdminMiddleware } from '../../middleware/platformAdmin';
import {
  enqueueWingetReleaseTest,
  executeWingetReleaseTest,
} from '../../jobs/wingetReleaseTestWorker';

const triggerTestSchema = z.object({
  version: z.string().min(1).max(64),
});

export const operationsRoutes = new Hono();

operationsRoutes.use('*', platformAdminMiddleware);

operationsRoutes.post('/', zValidator('json', upsertCatalogSchema), async (c) => {
  const data = c.req.valid('json');
  const [row] = await db.insert(thirdPartyPackageCatalog).values({
    source: data.source,
    packageId: data.packageId,
    vendor: data.vendor,
    friendlyName: data.friendlyName,
    category: data.category ?? 'application',
    defaultSeverity: data.defaultSeverity ?? 'unknown',
    breezeTested: data.breezeTested ?? false,
    notes: data.notes ?? null,
    homepageUrl: data.homepageUrl ?? null,
  }).returning();
  return c.json(row, 201);
});

operationsRoutes.patch('/:id', zValidator('json', upsertCatalogSchema.partial()), async (c) => {
  const id = c.req.param('id');
  const data = c.req.valid('json');
  const [row] = await db.update(thirdPartyPackageCatalog)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(thirdPartyPackageCatalog.id, id))
    .returning();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(row);
});

operationsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const result = await db.delete(thirdPartyPackageCatalog)
    .where(eq(thirdPartyPackageCatalog.id, id))
    .returning({ id: thirdPartyPackageCatalog.id });
  if (result.length === 0) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: true });
});

// POST /third-party-catalog/:id/test — manually trigger an AI smoke test
// for the catalog entry at a specific version. Fire-and-forget: returns
// 202 with the queued test row id.
operationsRoutes.post('/:id/test', zValidator('json', triggerTestSchema), async (c) => {
  const id = c.req.param('id');
  const { version } = c.req.valid('json');
  const enqueued = await enqueueWingetReleaseTest({ catalogId: id, version });
  if (!enqueued.testId) {
    return c.json(
      { error: 'cannot enqueue test', reason: 'catalog entry not found or not breeze-tested' },
      400
    );
  }
  // Kick the worker without awaiting; failures are logged inside.
  executeWingetReleaseTest({ testId: enqueued.testId }).catch((err) => {
    console.error('[ReleaseTest] execute failed', err);
  });
  return c.json(
    { testId: enqueued.testId, alreadyExisted: enqueued.alreadyExisted },
    202
  );
});
