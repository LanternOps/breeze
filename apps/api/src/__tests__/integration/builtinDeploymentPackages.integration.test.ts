/**
 * Integration test for built-in EDR deployment packages (Task 4).
 *
 * ensureBuiltinPackage upserts a PARTNER-scoped software_catalog row (org_id
 * NULL, partner_id set, integration_provider set) and — for providers whose
 * installer URL is derivable (Huntress) — a templated software_versions row.
 * It runs in a system DB context so the partner-axis write passes RLS even
 * though the connection is the unprivileged breeze_app role.
 *
 * Runs as breeze_app so RLS + the dual-axis policy are genuinely exercised.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { softwareCatalog, softwareVersions } from '../../db/schema';
import { ensureBuiltinPackage } from '../../services/builtinDeploymentPackages';
import { createPartner } from './db-utils';

describe('ensureBuiltinPackage (db)', () => {
  it('is idempotent for huntress: one catalog row + one templated version', async () => {
    const partner = await createPartner();

    const first = await ensureBuiltinPackage({ provider: 'huntress', partnerId: partner.id });
    const second = await ensureBuiltinPackage({ provider: 'huntress', partnerId: partner.id });
    expect(second.catalogId).toBe(first.catalogId);

    const { rows, versions } = await withSystemDbAccessContext(async () => {
      const rows = await db
        .select()
        .from(softwareCatalog)
        .where(and(
          eq(softwareCatalog.partnerId, partner.id),
          eq(softwareCatalog.integrationProvider, 'huntress'),
        ));
      const versions = await db
        .select()
        .from(softwareVersions)
        .where(eq(softwareVersions.catalogId, first.catalogId));
      return { rows, versions };
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).toBeNull();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.downloadUrl).toContain('{huntress_acct_key}');
    expect(versions[0]!.silentInstallArgs).toContain('{huntress_org_key}');
  });

  it('creates a catalog row but NO version for sentinelone (needs upload)', async () => {
    const partner = await createPartner();

    const { catalogId } = await ensureBuiltinPackage({ provider: 'sentinelone', partnerId: partner.id });

    const versions = await withSystemDbAccessContext(() =>
      db.select().from(softwareVersions).where(eq(softwareVersions.catalogId, catalogId)),
    );
    expect(versions).toHaveLength(0);
  });
});
