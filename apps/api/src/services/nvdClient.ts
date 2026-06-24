import type { VersionRange } from './versionCompare';

const NVD_CVES_URL = 'https://services.nvd.nist.gov/rest/json/cves/2.0';

type JsonObject = Record<string, unknown>;

export interface NvdRecord {
  cveId: string;
  cvssVersion: string | null;
  cvssScore: number | null;
  cvssVector: string | null;
  severity: string | null;
  cpeMatches: Array<{ cpePrefix: string; range: VersionRange }>;
}

export interface FetchNvdPageParams {
  lastModStartDate: string;
  lastModEndDate: string;
  startIndex: number;
  resultsPerPage?: number;
}

export type NvdResponse = unknown;

let warnedMissingApiKey = false;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function cpePrefix(criteria: string): string {
  return criteria.split(':').slice(0, 5).join(':');
}

function selectedMetric(cve: JsonObject): JsonObject | null {
  const metrics = asObject(cve.metrics);
  const metric =
    asArray(metrics?.cvssMetricV31)[0] ?? asArray(metrics?.cvssMetricV40)[0] ?? asArray(metrics?.cvssMetricV2)[0];
  return asObject(metric);
}

function flattenNodes(configurations: unknown): JsonObject[] {
  const nodes: JsonObject[] = [];
  for (const configuration of asArray(configurations)) {
    for (const node of asArray(asObject(configuration)?.nodes)) {
      const parsedNode = asObject(node);
      if (parsedNode) nodes.push(parsedNode);
    }
  }
  return nodes;
}

export function parseNvd(doc: unknown): NvdRecord[] {
  const root = asObject(doc);
  const records: NvdRecord[] = [];

  for (const item of asArray(root?.vulnerabilities)) {
    const cve = asObject(asObject(item)?.cve);
    const cveId = asString(cve?.id);
    if (!cve || !cveId) continue;

    const metric = selectedMetric(cve);
    const cvssData = asObject(metric?.cvssData);
    const cvssScore = asNumber(cvssData?.baseScore);
    const cpeMatches: NvdRecord['cpeMatches'] = [];

    for (const node of flattenNodes(cve.configurations)) {
      for (const cpeMatch of asArray(node.cpeMatch)) {
        const match = asObject(cpeMatch);
        const criteria = asString(match?.criteria);
        if (!match || match.vulnerable === false || !criteria) continue;

        cpeMatches.push({
          cpePrefix: cpePrefix(criteria),
          range: {
            startIncluding: asString(match.versionStartIncluding),
            startExcluding: asString(match.versionStartExcluding),
            endIncluding: asString(match.versionEndIncluding),
            endExcluding: asString(match.versionEndExcluding),
          },
        });
      }
    }

    records.push({
      cveId,
      cvssVersion: asString(cvssData?.version),
      cvssScore,
      cvssVector: asString(cvssData?.vectorString),
      severity: asString(metric?.baseSeverity) ?? asString(cvssData?.baseSeverity),
      cpeMatches,
    });
  }

  return records;
}

export async function fetchNvdPage(params: FetchNvdPageParams): Promise<NvdResponse> {
  const url = new URL(NVD_CVES_URL);
  url.searchParams.set('lastModStartDate', params.lastModStartDate);
  url.searchParams.set('lastModEndDate', params.lastModEndDate);
  url.searchParams.set('startIndex', String(params.startIndex));
  url.searchParams.set('resultsPerPage', String(params.resultsPerPage ?? 2000));

  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = process.env.NVD_API_KEY?.trim();
  if (apiKey) {
    headers.apiKey = apiKey;
  } else if (!warnedMissingApiKey) {
    warnedMissingApiKey = true;
    console.warn('NVD_API_KEY is not set; NVD sync will use unauthenticated rate limits.');
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`NVD fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}
