import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { resolveScopedOrgId, toDateOrNull } from './helpers';
import { backupSnapshots, snapshotContents, snapshotOrgById } from './store';
import { snapshotListSchema } from './schemas';

export const snapshotsRoutes = new Hono();

snapshotsRoutes.get('/snapshots', zValidator('query', snapshotListSchema), (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const query = c.req.valid('query');
  let results = backupSnapshots.filter((snapshot) => snapshotOrgById.get(snapshot.id) === orgId);

  if (query.deviceId) {
    results = results.filter((snapshot) => snapshot.deviceId === query.deviceId);
  }

  if (query.configId) {
    results = results.filter((snapshot) => snapshot.configId === query.configId);
  }

  results.sort((a, b) => {
    const aTime = toDateOrNull(a.createdAt) ?? 0;
    const bTime = toDateOrNull(b.createdAt) ?? 0;
    return bTime - aTime;
  });

  return c.json({ data: results });
});

snapshotsRoutes.get('/snapshots/:id', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const snapshotId = c.req.param('id');
  if (snapshotOrgById.get(snapshotId) !== orgId) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }
  const snapshot = backupSnapshots.find((item) => item.id === snapshotId);
  if (!snapshot) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }
  return c.json(snapshot);
});

snapshotsRoutes.get('/snapshots/:id/browse', (c) => {
  const auth = c.get('auth');
  const orgId = resolveScopedOrgId(auth);
  if (!orgId) {
    return c.json({ error: 'orgId is required for this scope' }, 400);
  }

  const snapshotId = c.req.param('id');
  if (snapshotOrgById.get(snapshotId) !== orgId) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }
  const snapshot = backupSnapshots.find((item) => item.id === snapshotId);
  if (!snapshot) {
    return c.json({ error: 'Snapshot not found' }, 404);
  }

  return c.json({
    snapshotId: snapshot.id,
    data: snapshotContents[snapshot.id] ?? []
  });
});
