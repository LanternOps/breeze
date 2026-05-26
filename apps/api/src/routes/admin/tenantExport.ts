/**
 * GET /admin/tenant-export/:orgId  — platform-admin GDPR Right-of-Access dump
 *
 * Returns a `application/zip` body containing one `<table>.json` file
 * per `ORG_CASCADE_DELETE_ORDER` entry that exists in this deployment,
 * plus a `manifest.json` with sha256 + rowCount per file.
 *
 * Auth: platform admin + requireMfa(). Reads the entire tenant's PII —
 * the same blast radius as a 2-party-verified erasure for an attacker
 * with a stolen long-lived platform-admin token. The MFA claim is set at
 * mint and never refreshed, so requireMfa() at least proves the JWT
 * actually carries `mfa:true` rather than being a downgraded API-only
 * token. The fix is paired with the per-step-up flow on the roadmap;
 * until that ships, requireMfa() is the strongest signal we can enforce.
 *
 * Buffers the whole ZIP into memory; see note in tenantExport.ts.
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations } from '../../db/schema';
import { buildOrgExportZip } from '../../services/tenantExport';
import { captureException } from '../../services/sentry';
import { requireMfa } from '../../middleware/auth';

export const tenantExportRoutes = new Hono();

tenantExportRoutes.get('/:orgId', requireMfa(), async (c) => {
  const orgId = c.req.param('orgId');
  // Cheap UUID guard before going to the DB.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    return c.json({ error: 'invalid orgId' }, 400);
  }

  const auth = c.get('auth');
  if (!auth) {
    return c.json({ error: 'unauthenticated' }, 401);
  }

  // Verify the org exists before opening an archive — surface 404 with a
  // JSON body instead of streaming an empty ZIP for typoed IDs.
  const org = await withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    return rows[0] ?? null;
  });
  if (!org) {
    return c.json({ error: 'org not found' }, 404);
  }

  try {
    const { zipBuffer } = await buildOrgExportZip(
      orgId,
      auth.user.id,
      auth.user.email,
    );

    c.header('Content-Type', 'application/zip');
    c.header(
      'Content-Disposition',
      `attachment; filename="breeze-org-${orgId}-export.zip"`,
    );
    c.header('Content-Length', String(zipBuffer.length));
    c.header('Cache-Control', 'no-store');
    return c.body(zipBuffer as unknown as ArrayBuffer);
  } catch (err) {
    captureException(err, c);
    const detail = err instanceof Error ? err.message : 'export failed';
    return c.json({ error: 'export failed', detail }, 500);
  }
});
