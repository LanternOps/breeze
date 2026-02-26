import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_HUNTRESS_BASE_URL = 'https://api.huntress.io/v1';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PAGINATION_PAGES = 100;

type JsonRecord = Record<string, unknown>;

export interface HuntressAgentRecord {
  huntressAgentId: string;
  hostname: string | null;
  platform: string | null;
  status: string | null;
  lastSeenAt: Date | null;
  metadata: JsonRecord;
}

export interface HuntressIncidentRecord {
  huntressIncidentId: string;
  severity: string | null;
  category: string | null;
  title: string;
  description: string | null;
  recommendation: string | null;
  status: string;
  reportedAt: Date | null;
  resolvedAt: Date | null;
  huntressAgentId: string | null;
  hostname: string | null;
  details: JsonRecord;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function firstString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstDate(record: JsonRecord, keys: string[]): Date | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function firstNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function firstBoolean(record: JsonRecord, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
    }
    if (typeof value === 'number') {
      if (value === 1) return true;
      if (value === 0) return false;
    }
  }
  return null;
}

function normalizeSeverity(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes('crit')) return 'critical';
  if (normalized.includes('high')) return 'high';
  if (normalized.includes('med')) return 'medium';
  if (normalized.includes('low')) return 'low';
  return normalized.slice(0, 20);
}

function normalizeStatus(value: string | null): string {
  if (!value) return 'open';
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
  if (!normalized) return 'open';
  if (normalized.includes('resolv') || normalized.includes('close')) return 'resolved';
  if (normalized.includes('progress') || normalized.includes('investigat')) return 'in_progress';
  if (normalized.includes('dismiss')) return 'dismissed';
  if (normalized.includes('new') || normalized.includes('open')) return 'open';
  return normalized.slice(0, 30);
}

function normalizeAgentStatus(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');
  return normalized || null;
}

function extractArrayFromEnvelope(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  if (!root) return [];
  for (const key of keys) {
    const value = root[key];
    if (Array.isArray(value)) return value;
    const nested = asRecord(value);
    if (nested) {
      const nestedList = extractArrayFromEnvelope(nested, ['data', 'items', 'results']);
      if (nestedList.length > 0) return nestedList;
    }
  }
  return [];
}

function extractPaginationState(payload: unknown): {
  nextCursor: string | null;
  nextPage: number | null;
  hasMore: boolean;
} {
  const root = asRecord(payload);
  if (!root) {
    return { nextCursor: null, nextPage: null, hasMore: false };
  }

  const contexts = [
    root,
    asRecord(root.pagination),
    asRecord(root.page),
    asRecord(root.paging),
    asRecord(root.meta),
  ].filter((value): value is JsonRecord => value !== null);

  let nextCursor: string | null = null;
  let nextPage: number | null = null;
  let hasMore = false;

  for (const ctx of contexts) {
    nextCursor = nextCursor ?? firstString(ctx, ['nextCursor', 'next_cursor', 'after', 'next_after']);
    nextPage = nextPage ?? firstNumber(ctx, ['nextPage', 'next_page']);

    if (!nextPage) {
      const currentPage = firstNumber(ctx, ['page', 'currentPage', 'current_page']);
      const totalPages = firstNumber(ctx, ['totalPages', 'total_pages', 'pages']);
      if (currentPage && totalPages && currentPage < totalPages) {
        nextPage = currentPage + 1;
      }
    }

    const explicitHasMore = firstBoolean(ctx, ['hasMore', 'has_more', 'hasNext', 'has_next', 'more']);
    if (explicitHasMore === true) {
      hasMore = true;
    }
  }

  const linkContexts = [
    asRecord(root.links),
    asRecord(asRecord(root.pagination)?.links),
    asRecord(asRecord(root.meta)?.links),
  ].filter((value): value is JsonRecord => value !== null);

  for (const linkCtx of linkContexts) {
    const nextLink = firstString(linkCtx, ['next', 'nextUrl', 'next_url']);
    if (!nextLink) continue;

    let url: URL;
    try {
      url = new URL(nextLink, 'https://api.huntress.io');
    } catch {
      continue;
    }

    nextCursor = nextCursor
      ?? url.searchParams.get('cursor')
      ?? url.searchParams.get('next_cursor')
      ?? url.searchParams.get('after');

    if (!nextPage) {
      const pageRaw = url.searchParams.get('page');
      if (pageRaw) {
        const pageNumber = Number(pageRaw);
        if (Number.isFinite(pageNumber) && pageNumber > 0) {
          nextPage = pageNumber;
        }
      }
    }
    hasMore = true;
  }

  return { nextCursor, nextPage, hasMore };
}

function normalizeAgent(input: unknown): HuntressAgentRecord | null {
  const row = asRecord(input);
  if (!row) return null;

  const huntressAgentId = firstString(row, ['id', 'agentId', 'agent_id', 'uuid']);
  if (!huntressAgentId) return null;

  return {
    huntressAgentId,
    hostname: firstString(row, ['hostname', 'hostName', 'name', 'computerName']),
    platform: firstString(row, ['platform', 'os', 'operatingSystem', 'osType']),
    status: normalizeAgentStatus(firstString(row, ['status', 'state', 'agentStatus'])),
    lastSeenAt: firstDate(row, ['lastSeenAt', 'last_seen_at', 'lastSeen', 'last_seen', 'updatedAt']),
    metadata: row
  };
}

function normalizeIncident(input: unknown): HuntressIncidentRecord | null {
  const row = asRecord(input);
  if (!row) return null;

  const huntressIncidentId = firstString(row, ['id', 'incidentId', 'incident_id', 'uuid']);
  if (!huntressIncidentId) return null;

  const fallbackTitle = `Huntress incident ${huntressIncidentId}`;
  return {
    huntressIncidentId,
    severity: normalizeSeverity(firstString(row, ['severity', 'priority', 'level'])),
    category: firstString(row, ['category', 'type', 'threatType', 'incidentType']),
    title: firstString(row, ['title', 'name', 'summary']) ?? fallbackTitle,
    description: firstString(row, ['description', 'details', 'message', 'summary']),
    recommendation: firstString(row, ['recommendation', 'recommendedAction', 'remediation', 'nextSteps']),
    status: normalizeStatus(firstString(row, ['status', 'state', 'resolutionStatus', 'incidentStatus'])),
    reportedAt: firstDate(row, ['reportedAt', 'reported_at', 'createdAt', 'created_at', 'detectedAt', 'timestamp']),
    resolvedAt: firstDate(row, ['resolvedAt', 'resolved_at', 'closedAt', 'closed_at']),
    huntressAgentId: firstString(row, ['agentId', 'agent_id', 'hostAgentId', 'host_agent_id']),
    hostname: firstString(row, ['hostname', 'hostName', 'computerName', 'host']),
    details: row
  };
}

function normalizeWebhookPayload(payload: unknown): {
  accountId: string | null;
  agents: HuntressAgentRecord[];
  incidents: HuntressIncidentRecord[];
} {
  const root = asRecord(payload) ?? {};
  const accountId = firstString(root, ['accountId', 'account_id', 'organizationId', 'organization_id']);

  const incidentCandidates = [
    ...extractArrayFromEnvelope(payload, ['incidents', 'alerts', 'findings', 'data', 'results']),
    ...(asRecord(payload)?.incident ? [asRecord(payload)?.incident] : []),
    ...(asRecord(payload)?.alert ? [asRecord(payload)?.alert] : [])
  ];
  const incidents = incidentCandidates
    .map((item) => normalizeIncident(item))
    .filter((item): item is HuntressIncidentRecord => item !== null);

  const agentCandidates = [
    ...extractArrayFromEnvelope(payload, ['agents', 'endpoints', 'hosts', 'devices', 'data', 'results']),
    ...(asRecord(payload)?.agent ? [asRecord(payload)?.agent] : []),
    ...(asRecord(payload)?.device ? [asRecord(payload)?.device] : [])
  ];
  const agents = agentCandidates
    .map((item) => normalizeAgent(item))
    .filter((item): item is HuntressAgentRecord => item !== null);

  return { accountId, agents, incidents };
}

async function fetchJson(
  url: URL,
  init: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      const preview = text.trim().slice(0, 400);
      throw new Error(`Huntress API request failed (${response.status} ${response.statusText}): ${preview || '<empty>'}`);
    }
    if (!text.trim()) return {};
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export class HuntressClient {
  private readonly apiKey: string;
  private readonly accountId: string | null;
  private readonly baseUrl: URL;

  constructor(input: { apiKey: string; accountId?: string | null; baseUrl?: string | null }) {
    this.apiKey = input.apiKey;
    this.accountId = input.accountId ?? null;
    this.baseUrl = new URL(input.baseUrl?.trim() || DEFAULT_HUNTRESS_BASE_URL);
  }

  private async request(pathname: string, query?: Record<string, string>): Promise<unknown> {
    const url = new URL(pathname.replace(/^\//, ''), this.baseUrl.toString().endsWith('/') ? this.baseUrl : new URL(`${this.baseUrl.toString()}/`));
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'X-API-Key': this.apiKey,
    };
    if (this.accountId) {
      headers['X-Account-Id'] = this.accountId;
    }
    return fetchJson(url, { method: 'GET', headers });
  }

  private async requestPaginated(pathname: string, since: Date | undefined, arrayKeys: string[]): Promise<unknown[]> {
    const items: unknown[] = [];
    let nextCursor: string | null = null;
    let nextPage: number | null = null;
    const seenPageTokens = new Set<string>();

    for (let i = 0; i < DEFAULT_MAX_PAGINATION_PAGES; i += 1) {
      const query: Record<string, string> = {};
      if (since) {
        query.since = since.toISOString();
      }
      if (nextCursor) {
        query.cursor = nextCursor;
      } else if (nextPage && nextPage > 1) {
        query.page = String(nextPage);
      }

      const payload = await this.request(pathname, query);
      const rows = extractArrayFromEnvelope(payload, arrayKeys);
      items.push(...rows);

      const pagination = extractPaginationState(payload);
      if (pagination.nextCursor) {
        const token = `cursor:${pagination.nextCursor}`;
        if (seenPageTokens.has(token)) break;
        seenPageTokens.add(token);
        nextCursor = pagination.nextCursor;
        nextPage = null;
        continue;
      }

      const candidateNextPage = pagination.nextPage
        ?? (pagination.hasMore && rows.length > 0 ? (nextPage ?? 1) + 1 : null);
      if (candidateNextPage && candidateNextPage > 1) {
        const token = `page:${candidateNextPage}`;
        if (seenPageTokens.has(token)) break;
        seenPageTokens.add(token);
        nextPage = candidateNextPage;
        nextCursor = null;
        continue;
      }

      break;
    }

    return items;
  }

  async listAgents(since?: Date): Promise<HuntressAgentRecord[]> {
    const rows = await this.requestPaginated('/agents', since, ['agents', 'data', 'items', 'results']);
    return rows
      .map((row) => normalizeAgent(row))
      .filter((row): row is HuntressAgentRecord => row !== null);
  }

  async listIncidents(since?: Date): Promise<HuntressIncidentRecord[]> {
    const rows = await this.requestPaginated('/incidents', since, ['incidents', 'alerts', 'findings', 'data', 'items', 'results']);
    return rows
      .map((row) => normalizeIncident(row))
      .filter((row): row is HuntressIncidentRecord => row !== null);
  }
}

export function parseHuntressWebhookPayload(payload: unknown): {
  accountId: string | null;
  agents: HuntressAgentRecord[];
  incidents: HuntressIncidentRecord[];
} {
  return normalizeWebhookPayload(payload);
}

export function buildHuntressWebhookSignature(secret: string, payload: string, timestamp?: string | null): string {
  const signed = timestamp ? `${timestamp}.${payload}` : payload;
  return `sha256=${createHmac('sha256', secret).update(signed).digest('hex')}`;
}

export function verifyHuntressWebhookSignature(input: {
  secret: string;
  payload: string;
  signatureHeader?: string | null;
  timestampHeader?: string | null;
  maxAgeSeconds?: number;
}): { ok: true } | { ok: false; error: string } {
  const { secret, payload, signatureHeader, timestampHeader, maxAgeSeconds = 10 * 60 } = input;
  const signature = signatureHeader?.trim();
  if (!signature) {
    return { ok: false, error: 'Missing Huntress signature header' };
  }

  const normalizedTimestamp = timestampHeader?.trim();
  if (!normalizedTimestamp) {
    return { ok: false, error: 'Missing Huntress timestamp header' };
  }

  const parsedTimestamp = Number(normalizedTimestamp);
  if (!Number.isFinite(parsedTimestamp) || parsedTimestamp <= 0) {
    return { ok: false, error: 'Invalid Huntress timestamp header' };
  }
  const timestampMs = parsedTimestamp > 1_000_000_000_000
    ? parsedTimestamp
    : parsedTimestamp * 1000;
  const ageMs = Math.abs(Date.now() - timestampMs);
  if (ageMs > maxAgeSeconds * 1000) {
    return { ok: false, error: 'Webhook signature timestamp is outside the replay window' };
  }

  const expected = buildHuntressWebhookSignature(secret, payload, normalizedTimestamp);
  const providedBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return { ok: false, error: 'Invalid Huntress webhook signature' };
  }

  const match = timingSafeEqual(providedBuffer, expectedBuffer);
  if (!match) {
    return { ok: false, error: 'Invalid Huntress webhook signature' };
  }

  return { ok: true };
}
