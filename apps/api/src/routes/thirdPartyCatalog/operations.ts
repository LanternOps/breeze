import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { thirdPartyPackageCatalog, thirdPartyReleaseTests } from '../../db/schema';
import { upsertCatalogSchema } from './schemas';
import { platformAdminMiddleware } from '../../middleware/platformAdmin';
import { requireMfa } from '../../middleware/auth';
import {
  enqueueWingetReleaseTest,
  executeWingetReleaseTest,
} from '../../jobs/wingetReleaseTestWorker';
import { invalidateCatalogCache } from '../../services/thirdPartyEnrichment';

const triggerTestSchema = z.object({
  version: z.string().min(1).max(64),
});

export const operationsRoutes = new Hono();

operationsRoutes.use('*', platformAdminMiddleware);
// MFA step-up for every mutating catalog op. This router is all-mutating
// (reads live in list.ts), so gate it once at the router level rather than
// per-route — that also preserves Hono's handler typing on the validator-less
// DELETE, which breaks if a bare middleware precedes the handler inline.
operationsRoutes.use('*', requireMfa());

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
    osvEcosystem: data.osvEcosystem ?? null,
  }).returning();
  invalidateCatalogCache();
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
  invalidateCatalogCache();
  return c.json(row);
});

operationsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const result = await db.delete(thirdPartyPackageCatalog)
    .where(eq(thirdPartyPackageCatalog.id, id))
    .returning({ id: thirdPartyPackageCatalog.id });
  if (result.length === 0) return c.json({ error: 'not found' }, 404);
  invalidateCatalogCache();
  return c.json({ deleted: true });
});

operationsRoutes.post('/:id/test', zValidator('json', triggerTestSchema), async (c) => {
  const id = c.req.param('id');
  const { version } = c.req.valid('json');

  // Concurrency guard: if a test for this catalog entry is already queued
  // or running, return 409 with the in-flight test id rather than starting
  // a parallel SSH session. Platform admins could otherwise spam this
  // endpoint and spawn N concurrent runners.
  const inflight = await db
    .select({ id: thirdPartyReleaseTests.id })
    .from(thirdPartyReleaseTests)
    .where(
      and(
        eq(thirdPartyReleaseTests.catalogId, id),
        inArray(thirdPartyReleaseTests.status, ['queued', 'running'])
      )
    )
    .limit(1);
  if (inflight.length > 0 && inflight[0]) {
    return c.json(
      { error: 'test already in progress', testId: inflight[0].id },
      409
    );
  }

  const enqueued = await enqueueWingetReleaseTest({ catalogId: id, version });
  if (!enqueued.testId) {
    return c.json(
      { error: 'cannot enqueue test', reason: 'catalog entry not found or not breeze-tested' },
      400
    );
  }
  // Kick the worker without awaiting; failures are logged inside.
  const testId = enqueued.testId;
  executeWingetReleaseTest({ testId }).catch((err) => {
    console.error('[release-test] execute failed', {
      testId,
      err: err instanceof Error ? err.message : String(err),
    });
  });
  return c.json(
    { testId, alreadyExisted: enqueued.alreadyExisted },
    202
  );
});
