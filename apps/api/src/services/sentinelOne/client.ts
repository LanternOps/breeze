type HttpMethod = 'GET' | 'POST';

export type S1ThreatAction = 'kill' | 'quarantine' | 'rollback';

export interface S1Agent {
  id: string;
  uuid?: string | null;
  computerName?: string | null;
  machineType?: string | null;
  siteName?: string | null;
  osName?: string | null;
  networkInterfaces?: Array<{ inet?: string[] }>;
  infected?: boolean | null;
  activeThreats?: number | null;
  isActive?: boolean | null;
  policyName?: string | null;
  lastSeen?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface S1Threat {
  id: string;
  agentId?: string | null;
  threatName?: string | null;
  classification?: string | null;
  threatSeverity?: string | null;
  processName?: string | null;
  filePath?: string | null;
  mitigationStatus?: string | null;
  detectedAt?: string | null;
  resolvedAt?: string | null;
  mitreTechniques?: unknown;
  [key: string]: unknown;
}

export interface S1ActionResponse {
  activityId: string | null;
  raw: unknown;
}

export interface S1ActivityStatus {
  status: 'queued' | 'in_progress' | 'completed' | 'failed';
  details?: unknown;
}

interface S1ClientOptions {
  managementUrl: string;
  apiToken: string;
  timeoutMs?: number;
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 25;

function parseMaxPages(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function mapActivityStatus(value: unknown): 'queued' | 'in_progress' | 'completed' | 'failed' {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.includes('fail') || normalized.includes('error')) return 'failed';
  if (normalized.includes('done') || normalized.includes('success') || normalized.includes('complete')) return 'completed';
  if (normalized.includes('progress') || normalized.includes('running') || normalized.includes('active')) return 'in_progress';
  return 'queued';
}

export class SentinelOneClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly maxPages: number;

  constructor(opts: S1ClientOptions) {
    this.baseUrl = opts.managementUrl.replace(/\/+$/, '');
    this.apiToken = opts.apiToken;
    this.timeoutMs = Math.max(1_000, opts.timeoutMs ?? 30_000);
    const envMaxPages = parseMaxPages(process.env.S1_SYNC_MAX_PAGES);
    this.maxPages = Math.max(1, opts.maxPages ?? envMaxPages ?? DEFAULT_MAX_PAGES);
  }

  async listAgents(updatedSince?: Date): Promise<S1Agent[]> {
    const query: Record<string, string> = {
      limit: '200',
      sortBy: 'updatedAt',
      sortOrder: 'desc'
    };
    if (updatedSince) {
      query.updatedAt__gte = updatedSince.toISOString();
    }
    const rows = await this.fetchPaged('/web/api/v2.1/agents', query);
    return rows
      .map((row) => this.normalizeAgent(row))
      .filter((row): row is S1Agent => Boolean(row));
  }

  async listThreats(updatedSince?: Date): Promise<S1Threat[]> {
    const query: Record<string, string> = {
      limit: '200',
      sortBy: 'updatedAt',
      sortOrder: 'desc'
    };
    if (updatedSince) {
      query.updatedAt__gte = updatedSince.toISOString();
    }
    const rows = await this.fetchPaged('/web/api/v2.1/threats', query);
    return rows
      .map((row) => this.normalizeThreat(row))
      .filter((row): row is S1Threat => Boolean(row));
  }

  async isolateAgents(agentIds: string[], isolate = true): Promise<S1ActionResponse> {
    const normalizedIds = Array.from(new Set(agentIds.map((id) => id.trim()).filter((id) => id.length > 0)));
    if (normalizedIds.length === 0) {
      return { activityId: null, raw: { message: 'No agent IDs provided' } };
    }

    const endpoint = isolate
      ? '/web/api/v2.1/agents/actions/disconnect'
      : '/web/api/v2.1/agents/actions/connect';

    const raw = await this.requestJson<Record<string, unknown>>(endpoint, 'POST', {
      filter: { ids: normalizedIds }
    });

    return {
      activityId: this.extractActivityId(raw),
      raw
    };
  }

  async runThreatAction(action: S1ThreatAction, threatIds: string[]): Promise<S1ActionResponse> {
    const normalizedIds = Array.from(new Set(threatIds.map((id) => id.trim()).filter((id) => id.length > 0)));
    if (normalizedIds.length === 0) {
      return { activityId: null, raw: { message: 'No threat IDs provided' } };
    }

    const endpointByAction: Record<S1ThreatAction, string> = {
      kill: '/web/api/v2.1/threats/mitigate/kill',
      quarantine: '/web/api/v2.1/threats/mitigate/quarantine',
      rollback: '/web/api/v2.1/threats/mitigate/rollback'
    };

    const raw = await this.requestJson<Record<string, unknown>>(endpointByAction[action], 'POST', {
      filter: { ids: normalizedIds }
    });

    return {
      activityId: this.extractActivityId(raw),
      raw
    };
  }

  async getActivityStatus(activityId: string): Promise<S1ActivityStatus> {
    const raw = await this.requestJson<Record<string, unknown>>(
      `/web/api/v2.1/activities/${encodeURIComponent(activityId)}`,
      'GET'
    );

    const dataRecord = asRecord(raw.data) ?? raw;
    const rawStatus =
      dataRecord.status ??
      dataRecord.activityStatus ??
      dataRecord.state ??
      dataRecord.result;

    return {
      status: mapActivityStatus(rawStatus),
      details: raw
    };
  }

  private normalizeAgent(row: Record<string, unknown>): S1Agent | null {
    const id = str(row.id) ?? str(row.agentId) ?? str(row.uuid);
    if (!id) return null;

    return {
      id,
      uuid: str(row.uuid),
      computerName: str(row.computerName) ?? str(row.hostname),
      machineType: str(row.machineType),
      siteName: str(row.siteName),
      osName: str(row.osName),
      networkInterfaces: Array.isArray(row.networkInterfaces) ? row.networkInterfaces as Array<{ inet?: string[] }> : undefined,
      infected: typeof row.infected === 'boolean' ? row.infected : null,
      activeThreats: typeof row.activeThreats === 'number' ? row.activeThreats : null,
      isActive: typeof row.isActive === 'boolean' ? row.isActive : null,
      policyName: str(row.policyName),
      lastSeen: str(row.lastSeen),
      updatedAt: str(row.updatedAt),
      ...row
    };
  }

  private normalizeThreat(row: Record<string, unknown>): S1Threat | null {
    const id = str(row.id) ?? str(row.threatId);
    if (!id) return null;

    return {
      id,
      agentId: str(row.agentId),
      threatName: str(row.threatName),
      classification: str(row.classification),
      threatSeverity: str(row.threatSeverity) ?? str(row.severity),
      processName: str(row.processName),
      filePath: str(row.filePath),
      mitigationStatus: str(row.mitigationStatus) ?? str(row.status),
      detectedAt: str(row.detectedAt) ?? str(row.createdAt),
      resolvedAt: str(row.resolvedAt),
      mitreTechniques: row.mitreTechniques ?? row.mitreTactics,
      ...row
    };
  }

  private async fetchPaged(path: string, query: Record<string, string>): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    let pageCount = 0;

    while (pageCount < this.maxPages) {
      pageCount += 1;
      const params: Record<string, string> = cursor ? { ...query, cursor } : query;
      const payload: Record<string, unknown> = await this.requestJson<Record<string, unknown>>(path, 'GET', undefined, params);
      const pageData = asArray(payload.data);
      results.push(...pageData);

      const pagination = asRecord(payload.pagination);
      const nextCursor: string | null =
        str(payload.nextCursor) ??
        str(pagination?.nextCursor) ??
        str(pagination?.next) ??
        null;

      if (!nextCursor || pageData.length === 0) {
        cursor = null;
        break;
      }
      cursor = nextCursor;
    }

    if (cursor && pageCount >= this.maxPages) {
      console.warn(
        `[SentinelOneClient] Pagination limit reached for ${path}; ` +
        `maxPages=${this.maxPages}, fetched=${results.length}. Results may be truncated.`
      );
    }

    return results;
  }

  private extractActivityId(payload: Record<string, unknown>): string | null {
    const data = asRecord(payload.data);
    return (
      str(payload.activityId) ??
      str(payload.activity_id) ??
      str(data?.activityId) ??
      str(data?.id) ??
      null
    );
  }

  private async requestJson<T extends Record<string, unknown>>(
    path: string,
    method: HttpMethod,
    body?: Record<string, unknown>,
    query?: Record<string, string>
  ): Promise<T> {
    const url = new URL(path, `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value.length > 0) {
          url.searchParams.set(key, value);
        }
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `ApiToken ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`SentinelOne API ${method} ${url.pathname} failed (${response.status}): ${text.slice(0, 500)}`);
      }

      const payload = await response.json() as unknown;
      const parsed = asRecord(payload);
      if (!parsed) {
        throw new Error(`SentinelOne API ${method} ${url.pathname} returned a non-object JSON payload`);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
