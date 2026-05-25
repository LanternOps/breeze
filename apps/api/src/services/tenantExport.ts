/**
 * Tenant Export Service (Task 30 — GDPR Right-of-Access export)
 *
 * Streams a single ZIP containing one JSON file per `ORG_CASCADE_DELETE_ORDER`
 * table for the requested org, plus a `manifest.json` with sha256 checksums.
 *
 * Reuses the cascade list as the source of truth — every table that holds
 * org-scoped rows in the cascade is exported, so erasure ⇔ export are
 * symmetric. Adding a new org-scoped table to the cascade list also adds
 * it to the export.
 *
 * Memory note: the export is materialised into a `Buffer` (archiver's
 * default in-memory finalize). For the cohort of orgs we target at launch
 * this is fine; once we have multi-GB tenants we'll swap to a
 * Response-stream pipe. Marked TODO inline.
 *
 * Auth: gated at the route layer (platformAdmin). No tenant-scope checks
 * are performed here.
 */

import { createHash } from 'node:crypto';
import archiver from 'archiver';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { ORG_CASCADE_DELETE_ORDER } from './tenantCascade';
import { createAuditLog } from './auditService';

export interface ExportManifestEntry {
  name: string;
  sha256: string;
  rowCount: number;
}

export interface ExportManifest {
  exportedAt: string;
  orgId: string;
  actor: string;
  actorEmail?: string;
  breezeApiVersion?: string;
  files: ExportManifestEntry[];
}

export interface TenantExportResult {
  manifest: ExportManifest;
  zipBuffer: Buffer;
}

/**
 * Build a ZIP buffer containing the org's data export.
 *
 * Reads every table in `ORG_CASCADE_DELETE_ORDER` (skipping tables that
 * don't exist in this deployment) and emits each as `<table>.json`.
 * Adds a `manifest.json` with sha256 per file at the end.
 */
export async function buildOrgExportZip(
  orgId: string,
  performedBy: string,
  performedByEmail?: string,
): Promise<TenantExportResult> {
  const exportedAt = new Date().toISOString();
  const archive = archiver('zip', { zlib: { level: 6 } });
  const chunks: Buffer[] = [];
  const files: ExportManifestEntry[] = [];

  // Wire output collection BEFORE appending anything so we don't drop frames.
  archive.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('error', reject);
  });

  // Fetch + append each table sequentially. Sequential keeps memory bounded
  // and gives a deterministic file ordering inside the ZIP.
  for (const table of ORG_CASCADE_DELETE_ORDER) {
    let rows: unknown[];
    try {
      rows = await dbModule.withSystemDbAccessContext(async () => {
        return readOrgRows(table, orgId);
      });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '42P01') {
        // Table doesn't exist in this deployment — skip it. The cascade
        // list is canonical across deployments but optional features
        // (e.g. TimescaleDB hypertables) might be absent.
        continue;
      }
      throw err;
    }

    const json = JSON.stringify(rows, null, 2);
    const sha256 = createHash('sha256').update(json).digest('hex');
    const fileName = `${table}.json`;
    archive.append(json, { name: fileName });
    files.push({ name: fileName, sha256, rowCount: rows.length });
  }

  const manifest: ExportManifest = {
    exportedAt,
    orgId,
    actor: performedBy,
    actorEmail: performedByEmail,
    breezeApiVersion: process.env.BREEZE_VERSION,
    files,
  };
  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

  await archive.finalize();
  await finished;

  // Best-effort audit (DON'T fail the export if audit write fails — the
  // platform-admin middleware already audited the request, this is an
  // additional structured row capturing the row counts).
  try {
    await createAuditLog({
      orgId: null,
      actorType: 'user',
      actorId: performedBy,
      actorEmail: performedByEmail,
      action: 'tenant.export',
      resourceType: 'organization',
      resourceId: orgId,
      details: {
        exportedAt,
        fileCount: files.length,
        totalRows: files.reduce((sum, f) => sum + f.rowCount, 0),
      },
      result: 'success',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[tenantExport] audit write failed', err);
  }

  return { manifest, zipBuffer: Buffer.concat(chunks) };
}

async function readOrgRows(table: string, orgId: string): Promise<unknown[]> {
  // SELECT * is fine here — the export is meant to mirror raw schema for
  // forensic / portability use. `organizations` is id-keyed; everything
  // else is org_id-keyed.
  if (table === 'organizations') {
    const rows = (await dbModule.db.execute(
      sql`SELECT * FROM organizations WHERE id = ${orgId}`,
    )) as unknown as unknown[];
    return Array.isArray(rows) ? rows : [];
  }
  const rows = (await dbModule.db.execute(
    sql`SELECT * FROM ${sql.raw(quoteIdent(table))} WHERE org_id = ${orgId}`,
  )) as unknown as unknown[];
  return Array.isArray(rows) ? rows : [];
}

function quoteIdent(table: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`[tenantExport] refusing to quote unsafe identifier: ${table}`);
  }
  return `"${table}"`;
}
