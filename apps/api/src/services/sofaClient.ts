import { and, eq, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { osVulnerabilities, vulnerabilities, vulnerabilitySources } from '../db/schema';
import { assertSomeValidCveIds, isValidCveId, warnHighSkipRatio, warnMalformedCveIds } from './cveId';

const SOFA_MACOS_FEED_URL = 'https://sofafeed.macadmins.io/v2/macos_data_feed.json';

type JsonObject = Record<string, unknown>;

export interface SofaRecord {
  osLine: string;
  fixedVersion: string;
  cveId: string;
  activelyExploited: boolean;
}

export interface SofaSyncDependencies {
  fetchSofa?: () => Promise<unknown>;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export interface SofaParseResult {
  records: SofaRecord[];
  /** Distinct malformed CVE ids dropped at the parse boundary (#2427). */
  skippedCveIds: ReadonlySet<string>;
}

export function parseSofa(doc: unknown): SofaParseResult {
  const root = asObject(doc);
  const records: SofaRecord[] = [];
  const malformedCveIds = new Set<string>();
  let cveKeyCount = 0;
  let validCveIdCount = 0;

  for (const osVersion of asArray(root?.OSVersions)) {
    const osNode = asObject(osVersion);
    const osLine = asString(osNode?.OSVersion);
    if (!osLine) continue;

    for (const release of asArray(osNode?.SecurityReleases)) {
      const releaseNode = asObject(release);
      const fixedVersion = asString(releaseNode?.ProductVersion);
      const cves = asObject(releaseNode?.CVEs);
      if (!fixedVersion || !cves) continue;

      const exploited = new Set(
        asArray(releaseNode?.ActivelyExploitedCVEs).filter((item): item is string => typeof item === 'string')
      );

      for (const cveId of Object.keys(cves)) {
        cveKeyCount += 1;
        if (!cveId) continue;
        // Upstream garbage guard (#2261): drop records whose CVE id doesn't
        // match the canonical shape (would overflow varchar(32) and abort the sync).
        if (!isValidCveId(cveId)) {
          malformedCveIds.add(cveId);
          continue;
        }
        validCveIdCount += 1;
        records.push({
          osLine,
          fixedVersion,
          cveId,
          activelyExploited: exploited.has(cveId),
        });
      }
    }
  }

  assertSomeValidCveIds({
    tag: 'SofaClient',
    entryCount: cveKeyCount,
    validCount: validCveIdCount,
    malformedIds: malformedCveIds,
  });
  warnMalformedCveIds('SofaClient', malformedCveIds);
  return { records, skippedCveIds: malformedCveIds };
}

export async function fetchSofa(): Promise<unknown> {
  const response = await fetch(SOFA_MACOS_FEED_URL, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`SOFA macOS feed fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function distinctCves(records: SofaRecord[]): Array<{
  cveId: string;
  activelyExploited: boolean;
  records: SofaRecord[];
}> {
  const grouped = new Map<string, SofaRecord[]>();
  for (const record of records) {
    const current = grouped.get(record.cveId) ?? [];
    current.push(record);
    grouped.set(record.cveId, current);
  }

  return Array.from(grouped, ([cveId, cveRecords]) => ({
    cveId,
    activelyExploited: cveRecords.some((record) => record.activelyExploited),
    records: cveRecords,
  }));
}

async function upsertSofaSourceSuccess(now: Date, skippedCount: number): Promise<void> {
  const updated = await db
    .update(vulnerabilitySources)
    .set({
      lastSuccessfulSyncAt: now,
      lastSyncStatus: 'ok',
      lastSyncError: null,
      lastSyncSkippedCount: skippedCount,
      cursor: now.toISOString(),
      updatedAt: now,
    })
    .where(eq(vulnerabilitySources.source, 'sofa'))
    .returning({ id: vulnerabilitySources.id });

  if (updated.length > 0) return;

  await db.insert(vulnerabilitySources).values({
    source: 'sofa',
    lastSuccessfulSyncAt: now,
    lastSyncStatus: 'ok',
    lastSyncError: null,
    lastSyncSkippedCount: skippedCount,
    cursor: now.toISOString(),
    updatedAt: now,
  });
}

async function upsertSofaSourceError(message: string): Promise<void> {
  const now = new Date();
  const updated = await db
    .update(vulnerabilitySources)
    .set({
      lastSyncStatus: 'error',
      lastSyncError: message.slice(0, 4000),
      updatedAt: now,
    })
    .where(eq(vulnerabilitySources.source, 'sofa'))
    .returning({ id: vulnerabilitySources.id });

  if (updated.length > 0) return;

  await db.insert(vulnerabilitySources).values({
    source: 'sofa',
    lastSyncStatus: 'error',
    lastSyncError: message.slice(0, 4000),
    updatedAt: now,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function upsertSofaVulnerability(params: {
  cveId: string;
  activelyExploited: boolean;
  records: SofaRecord[];
  now: Date;
}): Promise<string> {
  const [row] = await db
    .insert(vulnerabilities)
    .values({
      cveId: params.cveId,
      source: 'sofa',
      description: `Apple SOFA advisory for ${params.cveId}`,
      knownExploited: params.activelyExploited,
      patchAvailable: true,
      rawPayload: {
        source: 'sofa',
        records: params.records,
      },
      modifiedAt: params.now,
    })
    .onConflictDoUpdate({
      target: vulnerabilities.cveId,
      set: {
        knownExploited: params.activelyExploited
          ? true
          : sql`${vulnerabilities.knownExploited}`,
        patchAvailable: true,
        modifiedAt: params.now,
      },
    })
    .returning({ id: vulnerabilities.id });

  if (!row) {
    throw new Error(`Failed to upsert vulnerability ${params.cveId}`);
  }
  return row.id;
}

async function insertOsVulnerability(params: {
  osLine: string;
  fixedVersion: string;
  vulnerabilityId: string;
}): Promise<boolean> {
  const existing = await db
    .select({ id: osVulnerabilities.id })
    .from(osVulnerabilities)
    .where(and(
      eq(osVulnerabilities.platform, 'macos'),
      eq(osVulnerabilities.osLine, params.osLine),
      eq(osVulnerabilities.fixedVersion, params.fixedVersion),
      eq(osVulnerabilities.vulnerabilityId, params.vulnerabilityId),
    ))
    .limit(1);

  if (existing.length > 0) return false;

  await db.insert(osVulnerabilities).values({
    platform: 'macos',
    osLine: params.osLine,
    fixedVersion: params.fixedVersion,
    vulnerabilityId: params.vulnerabilityId,
  });
  return true;
}

export async function syncSofa(
  deps: SofaSyncDependencies = {}
): Promise<{ vulns: number; osFacts: number; skipped: number }> {
  try {
    const fetchFeed = deps.fetchSofa ?? fetchSofa;
    const { records: recs, skippedCveIds: parseSkippedCveIds } = parseSofa(await fetchFeed());

    return await withSystemDbAccessContext(async () => {
      const now = new Date();
      const vulnerabilityIds = new Map<string, string>();
      const skippedCveIds = new Set<string>();
      for (const vuln of distinctCves(recs)) {
        // Defense-in-depth re-check of the parse-boundary validation (#2261).
        // Everything here runs in one transaction, so letting a malformed id
        // reach the INSERT would poison the whole run — skip it instead.
        if (!isValidCveId(vuln.cveId)) {
          skippedCveIds.add(vuln.cveId);
          continue;
        }
        vulnerabilityIds.set(vuln.cveId, await upsertSofaVulnerability({
          cveId: vuln.cveId,
          activelyExploited: vuln.activelyExploited,
          records: vuln.records,
          now,
        }));
      }

      let osFacts = 0;
      const seenFacts = new Set<string>();
      for (const record of recs) {
        const vulnerabilityId = vulnerabilityIds.get(record.cveId);
        if (!vulnerabilityId) continue;

        const factKey = ['macos', record.osLine, record.fixedVersion, vulnerabilityId].join(':');
        if (seenFacts.has(factKey)) continue;
        seenFacts.add(factKey);

        const inserted = await insertOsVulnerability({
          osLine: record.osLine,
          fixedVersion: record.fixedVersion,
          vulnerabilityId,
        });
        if (inserted) {
          osFacts += 1;
        }
      }

      warnMalformedCveIds('SofaClient/sync', skippedCveIds);
      // Total skips for the run: parse-boundary drops plus the (normally empty)
      // defense-in-depth re-check above. Disjoint by construction — the re-check
      // only sees ids the parse boundary already validated — but union anyway.
      const skipped = new Set([...parseSkippedCveIds, ...skippedCveIds]).size;
      warnHighSkipRatio('SofaClient/sync', skipped, skipped + vulnerabilityIds.size);
      await upsertSofaSourceSuccess(now, skipped);
      return { vulns: vulnerabilityIds.size, osFacts, skipped };
    });
  } catch (error) {
    try {
      await withSystemDbAccessContext(() => upsertSofaSourceError(errorMessage(error)));
    } catch (sourceError) {
      console.error('[SofaClient] Failed to persist SOFA sync error:', sourceError);
    }
    throw error;
  }
}
