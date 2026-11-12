import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { devices, sites } from '../../db/schema';

const UUID = z.string().guid();

/**
 * The site to record on an `analysis` run (`trigger_ref.siteId`), or null.
 *
 * Site-restricted users see a device-less analysis run's artifacts through
 * this site, so it is recorded only when it belongs to the run's organization
 * and holds every input device. Otherwise the run is still admitted, with no
 * site, and its artifacts stay with unrestricted users.
 */
export async function verifiedAnalysisSiteId(
  orgId: string,
  siteId: string | null,
  deviceIds: readonly string[],
): Promise<string | null> {
  if (!siteId || !UUID.safeParse(siteId).success || !UUID.safeParse(orgId).success) return null;
  const wanted = [...new Set(deviceIds)];
  if (wanted.some((id) => !UUID.safeParse(id).success)) return null;

  const check = async () => {
    const [site] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, siteId), eq(sites.orgId, orgId)))
      .limit(1);
    if (!site) return null;
    if (wanted.length === 0) return siteId;
    const inSite = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(inArray(devices.id, wanted), eq(devices.orgId, orgId), eq(devices.siteId, siteId)));
    return inSite.length === wanted.length ? siteId : null;
  };

  if (getCurrentDbAccessContext()?.scope === 'system') return check();
  return runOutsideDbContext(() => withSystemDbAccessContext(check));
}
