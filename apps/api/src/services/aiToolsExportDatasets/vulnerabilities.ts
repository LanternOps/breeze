/**
 * `vulnerabilities` for `export_dataset`, set-based (Wisp analysis sessions
 * W05 carry-over). Replaces the per-device adapter that ran four queries per
 * device (access check, findings, catalog, affected software).
 *
 * One `exportDeviceSet` call, then per page: one keyset query over the frame's
 * findings (`device_vulnerabilities`, org + device set + status), and the two
 * lookups the chat tool uses for the page's rows, `readCatalog` (the global CVE
 * catalog) and `readFindingSoftware` (the affected software, site- and
 * device-scoped). That is three queries per 500 findings, whatever the frame
 * size.
 *
 * The filter (`filters.status`, default `open`, `all` for every status) is
 * unchanged, and so are the columns, plus `hostname`. A finding whose CVE is
 * not in the catalog is skipped, as before. The agent-reported software name,
 * vendor and version are now redacted before export.
 */
import { and, asc, eq, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { deviceVulnerabilities } from '../../db/schema';
import { normStatus, readCatalog, readFindingSoftware, type CatalogRow } from '../aiToolsVulnerability';
import {
  deviceIdIn,
  emptyExportPager,
  exportDeviceSet,
  exportText,
  keysetPager,
  runExportQuery,
} from '../aiToolsExportShared';
import type { DatasetAdapter, DatasetRequest } from '../aiToolsExportDatasets';
import { withRequestedDevicesAsFrame } from './legacyFrame';

/** `(device, id) > (d, i)`: the next page after the last emitted finding. */
function afterDeviceFinding(deviceCol: AnyColumn, idCol: AnyColumn, after: string[] | null): SQL | undefined {
  if (!after) return undefined;
  const [d, i] = after;
  return sql`(${deviceCol}, ${idCol}) > (${d}::uuid, ${i}::uuid)`;
}

async function createVulnerabilitiesPager(req: DatasetRequest) {
  const status = normStatus(req.filters.status);
  const scope = await exportDeviceSet(withRequestedDevicesAsFrame(req));
  if (scope.deviceIds.length === 0) return emptyExportPager;

  return keysetPager({
    pageSize: req.pageSize,
    shape: ['uuid', 'uuid'],
    fetch: async (after, limit) => {
      const v = deviceVulnerabilities;
      const findings = await runExportQuery(
        db
          .select({
            id: v.id,
            deviceId: v.deviceId,
            vulnerabilityId: v.vulnerabilityId,
            status: v.status,
            riskScore: v.riskScore,
          })
          .from(deviceVulnerabilities)
          .where(and(
            eq(v.orgId, req.orgId),
            deviceIdIn(v.deviceId, scope.deviceIds),
            status === 'all' ? undefined : eq(v.status, status),
            afterDeviceFinding(v.deviceId, v.id, after),
          ))
          .orderBy(asc(v.deviceId), asc(v.id))
          .limit(limit),
      );
      if (findings.length === 0) return [];
      const catalog = await readCatalog([...new Set(findings.map((f) => f.vulnerabilityId))]);
      const byId = new Map<string, CatalogRow>(catalog.map((c) => [c.id, c]));
      const softwareById = await readFindingSoftware(req.orgId, findings.map((f) => f.id), req.auth);
      return findings.map((finding) => ({
        ...finding,
        cve: byId.get(finding.vulnerabilityId) ?? null,
        software: softwareById.get(finding.id)?.software ?? null,
      }));
    },
    keyOf: (row) => [row.deviceId, row.id],
    toRows: (rows) => rows.flatMap((row) => {
      // Not in the catalog: skipped, as the per-device adapter did. The row
      // still advances the cursor (keyOf reads the page, not this output).
      if (!row.cve) return [];
      const cve = row.cve;
      return [{
        id: row.id,
        deviceId: row.deviceId,
        hostname: scope.hostnames.get(row.deviceId) ?? null,
        cveId: cve.cveId,
        severity: cve.severity,
        cvssScore: cve.cvssScore,
        epssScore: cve.epssScore,
        riskScore: row.riskScore,
        status: row.status,
        knownExploited: cve.knownExploited ?? false,
        patchAvailable: cve.patchAvailable ?? false,
        softwareName: exportText(row.software?.name ?? null, { paths: true }),
        softwareVersion: exportText(row.software?.version ?? null),
        softwareVendor: exportText(row.software?.vendor ?? null, { paths: true }),
      }];
    }),
  });
}

export const vulnerabilitiesAdapter: DatasetAdapter = {
  tier: 1,
  deviceScoped: false,
  createPager: createVulnerabilitiesPager,
};
