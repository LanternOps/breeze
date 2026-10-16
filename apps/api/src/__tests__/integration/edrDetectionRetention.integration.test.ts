/**
 * EDR provider framework W02 (#8164 / #8166) — detection retention against real
 * Postgres. One pass of the prune must delete only terminal (resolved /
 * dismissed / false_positive / mitigated) detections older than 180 days, aged
 * by COALESCE(resolved_at, last_vendor_update_at, updated_at); `open`,
 * `in_progress` and `unknown` survive however old. Tombstones follow the same
 * status/age rule.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { edrConnections, edrDetections } from '../../db/schema';
import { __testOnly } from '../../jobs/edrDetectionRetention';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const admin = () => getTestDb() as typeof db;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

type Spec = {
  key: string;
  status: 'open' | 'in_progress' | 'unknown' | 'resolved' | 'dismissed' | 'false_positive' | 'mitigated';
  resolvedAt?: Date | null;
  lastVendorUpdateAt?: Date | null;
  updatedAt: Date;
  tombstone?: boolean;
  /** Expected to survive one pass. */
  keep: boolean;
};

const SPECS: Spec[] = [
  { key: 'open-400d', status: 'open', updatedAt: ago(400), keep: true },
  { key: 'in_progress-400d', status: 'in_progress', updatedAt: ago(400), keep: true },
  { key: 'unknown-400d', status: 'unknown', updatedAt: ago(400), keep: true },
  { key: 'resolved-181d', status: 'resolved', resolvedAt: ago(181), updatedAt: ago(181), keep: false },
  { key: 'resolved-179d', status: 'resolved', resolvedAt: ago(179), updatedAt: ago(179), keep: true },
  { key: 'mitigated-181d', status: 'mitigated', resolvedAt: ago(181), updatedAt: ago(181), keep: false },
  { key: 'dismissed-181d', status: 'dismissed', resolvedAt: ago(181), updatedAt: ago(181), keep: false },
  { key: 'false_positive-181d', status: 'false_positive', resolvedAt: ago(181), updatedAt: ago(181), keep: false },
  // COALESCE precedence: resolved_at wins over a much older updated_at.
  { key: 'resolved-recent-resolvedAt-old-updatedAt', status: 'resolved', resolvedAt: ago(10), updatedAt: ago(400), keep: true },
  // resolved_at NULL falls through to last_vendor_update_at, then updated_at.
  { key: 'resolved-null-resolvedAt-old-vendorUpdate', status: 'resolved', resolvedAt: null, lastVendorUpdateAt: ago(200), updatedAt: ago(1), keep: false },
  { key: 'resolved-null-both-old-updatedAt', status: 'resolved', resolvedAt: null, lastVendorUpdateAt: null, updatedAt: ago(200), keep: false },
  { key: 'resolved-null-both-recent-updatedAt', status: 'resolved', resolvedAt: null, lastVendorUpdateAt: null, updatedAt: ago(5), keep: true },
  // Tombstones (detached_at NOT NULL) follow the same status/age rule.
  { key: 'tombstone-resolved-181d', status: 'resolved', resolvedAt: ago(181), updatedAt: ago(181), tombstone: true, keep: false },
  { key: 'tombstone-open-400d', status: 'open', updatedAt: ago(400), tombstone: true, keep: true },
];

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [connection] = await db.insert(edrConnections).values({
      partnerId: partner.id,
      provider: 'bitdefender',
      name: `GravityZone ${randomUUID().slice(0, 6)}`,
      credentialsEncrypted: 'enc:test',
      vendorRootId: 'root-1',
      vendorRootType: 'partner',
    }).returning({ id: edrConnections.id });

    const ids = new Map<string, string>();
    for (const spec of SPECS) {
      const [row] = await db.insert(edrDetections).values({
        connectionId: connection!.id,
        partnerId: partner.id,
        orgId: org.id,
        tenantId: null,
        provider: 'bitdefender',
        vendorDetectionId: `${spec.key}-${randomUUID().slice(0, 8)}`,
        vendorKind: 'incident',
        severity: 'high',
        status: spec.status,
        resolvedAt: spec.resolvedAt ?? null,
        lastVendorUpdateAt: spec.lastVendorUpdateAt ?? null,
        updatedAt: spec.updatedAt,
        detachedAt: spec.tombstone ? ago(1) : null,
      }).returning({ id: edrDetections.id });
      ids.set(spec.key, row!.id);
    }
    return { ids };
  });
}

describe('edr detection retention (real Postgres)', () => {
  runDb('one pass deletes only terminal detections older than 180 days', async () => {
    const { ids } = await seed();
    const allIds = [...ids.values()];

    const result = await __testOnly.pruneTerminalEdrDetections({
      cutoff: __testOnly.cutoffIso(),
      batchSize: 100,
      maxBatches: 5,
    });

    const survivors = await admin()
      .select({ id: edrDetections.id })
      .from(edrDetections)
      .where(inArray(edrDetections.id, allIds));
    const surviving = new Set(survivors.map((r) => r.id));

    for (const spec of SPECS) {
      expect(surviving.has(ids.get(spec.key)!), `${spec.key} survives=${spec.keep}`).toBe(spec.keep);
    }
    // Other tests' rows may also be pruned in the same pass, so assert a floor.
    expect(result.deleted).toBeGreaterThanOrEqual(SPECS.filter((s) => !s.keep).length);
    expect(result.hasMore).toBe(false);
  });

  runDb('a batch cap smaller than the eligible set leaves the remainder for the next pass', async () => {
    const { ids } = await seed();
    const doomed = SPECS.filter((s) => !s.keep).map((s) => ids.get(s.key)!);

    const first = await __testOnly.pruneTerminalEdrDetections({
      cutoff: __testOnly.cutoffIso(),
      batchSize: 1,
      maxBatches: 1,
    });
    expect(first.batches).toBe(1);
    expect(first.hasMore).toBe(true);

    await __testOnly.pruneTerminalEdrDetections({
      cutoff: __testOnly.cutoffIso(),
      batchSize: 100,
      maxBatches: 5,
    });
    const left = await admin()
      .select({ id: edrDetections.id })
      .from(edrDetections)
      .where(inArray(edrDetections.id, doomed));
    expect(left).toHaveLength(0);
  });
});
