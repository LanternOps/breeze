/**
 * Shared safe API client for the Workspace web contributions.
 *
 * Every request this module issues:
 * - resolves ONLY relative paths below the extension's own API namespace
 *   (`/api/v1/ext/workspace/`) — callers cannot supply origins, rooted paths,
 *   schemes, traversal, or percent-encoded segments;
 * - sends `credentials: 'same-origin'` and nothing else;
 * - caps response bodies before parsing;
 * - normalizes failures into {@link WorkspaceApiError} without ever adopting a
 *   server-supplied string as its own `message` (server text is preserved
 *   separately on `detail` for callers that render it as textContent).
 */

export const WORKSPACE_API_BASE = '/api/v1/ext/workspace/';

/** Upper bound on response text length before the body is refused. */
export const MAX_RESPONSE_LENGTH = 1_000_000;

export type WorkspaceApiErrorKind =
  | 'protocol'
  | 'invalid-request'
  | 'unauthorized'
  | 'not-found'
  | 'server'
  | 'network'
  | 'aborted';

const KIND_MESSAGES: Record<WorkspaceApiErrorKind, string> = {
  protocol: 'The Workspace API returned an unexpected response.',
  'invalid-request': 'The request was rejected as invalid.',
  unauthorized: 'You are not authorized for this Workspace resource.',
  'not-found': 'The Workspace resource was not found.',
  server: 'The Workspace API failed to process the request.',
  network: 'The Workspace API could not be reached.',
  aborted: 'The request was aborted.',
};

export class WorkspaceApiError extends Error {
  readonly kind: WorkspaceApiErrorKind;
  readonly status?: number;
  /** Server-supplied error text, if any. Render via textContent only. */
  readonly detail?: string;

  constructor(kind: WorkspaceApiErrorKind, options: { status?: number; detail?: string } = {}) {
    super(KIND_MESSAGES[kind]);
    this.name = 'WorkspaceApiError';
    this.kind = kind;
    this.status = options.status;
    this.detail = options.detail;
  }
}

/** One path segment interpolated from caller data (ids). */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A URL scheme prefix, e.g. "https:", "javascript:". */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function refuse(): never {
  throw new WorkspaceApiError('protocol');
}

function assertSegment(segment: string): string {
  if (!SEGMENT_RE.test(segment) || segment.includes('..')) refuse();
  return segment;
}

/**
 * Build a same-origin URL below {@link WORKSPACE_API_BASE} from a relative
 * path. Rejects anything that could escape the namespace: absolute URLs,
 * schemes, protocol-relative and rooted paths, backslashes, parent traversal,
 * and percent-encoding (extension API paths never legitimately contain '%').
 */
export function buildWorkspaceUrl(path: string, params?: Record<string, string>): string {
  if (
    path.length === 0
    || path.startsWith('/')
    || path.includes('\\')
    || path.includes('%')
    || path.includes('..')
    // '?' and '#' in the path would smuggle query params or truncate the
    // ones this client appends (e.g. an id of "x?orgId=other").
    || path.includes('?')
    || path.includes('#')
    || SCHEME_RE.test(path)
  ) {
    refuse();
  }
  for (const segment of path.split('/')) {
    if (segment.length === 0) refuse();
  }
  const query = params ? `?${new URLSearchParams(params).toString()}` : '';
  return `${WORKSPACE_API_BASE}${path}${query}`;
}

/** Wire shape of a source row as `publicSource` (src/routes/sources.ts) emits it. */
export interface SourceRow {
  id: string;
  orgId: string;
  kind: string;
  displayName: string;
  rootPath: string;
  crawlDeviceId: string | null;
  visibilityGroupIds: string[];
  crawlCadenceMinutes: number;
  excludeGlobs: string[];
  watch: boolean;
  status: string;
  errorReason: string | null;
  lastCompleteRunAt: string | null;
  createdAt: string;
  updatedAt: string;
  hasCredential: boolean;
}

export interface SourceInput {
  kind: string;
  displayName: string;
  rootPath: string;
  crawlDeviceId?: string | null;
  visibilityGroupIds?: string[];
  crawlCadenceMinutes?: number;
  excludeGlobs?: string[];
  watch?: boolean;
  status?: string;
}

export interface CredentialInput {
  username: string;
  password: string;
  domain?: string;
}

export interface CrawlRunRow {
  id: string;
  sourceId: string;
  deviceId: string | null;
  status: string;
  startedAt: string | null;
  lastActivityAt: string | null;
  completedAt: string | null;
  stats: Record<string, unknown> | null;
  errorReason: string | null;
}

/** The five aggregate fields — never widened (no filenames, no paths). */
export interface DeviceSummary {
  deviceId: string;
  indexedFiles: number;
  visibleSources: number;
  lastSuccessfulCrawlAt: string | null;
  lastActivityAt: string | null;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function request(
  url: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      signal: init.signal,
      ...(init.body !== undefined
        ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(init.body),
        }
        : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new WorkspaceApiError('aborted');
    }
    // Never echo the underlying failure text — it can carry hosts/paths.
    throw new WorkspaceApiError('network');
  }

  const text = await response.text();
  if (text.length > MAX_RESPONSE_LENGTH) refuse();

  let body: unknown;
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    if (response.ok) refuse();
    body = {};
  }

  if (!response.ok) {
    const detail = isRecord(body) && typeof body.error === 'string' ? body.error : undefined;
    const kind: WorkspaceApiErrorKind = response.status === 400
      ? 'invalid-request'
      : response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 404
          ? 'not-found'
          : 'server';
    throw new WorkspaceApiError(kind, { status: response.status, detail });
  }

  return body;
}

function expectRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) refuse();
  return body;
}

function expectSourceRow(body: unknown): SourceRow {
  const record = expectRecord(body);
  if (typeof record.id !== 'string' || typeof record.displayName !== 'string') refuse();
  return record as unknown as SourceRow;
}

export function createWorkspaceApi() {
  return {
    async listSources(orgId: string, options: RequestOptions = {}): Promise<SourceRow[]> {
      const body = expectRecord(await request(
        buildWorkspaceUrl('sources', { orgId }),
        { signal: options.signal },
      ));
      if (!Array.isArray(body.sources)) refuse();
      return body.sources.map(expectSourceRow);
    },

    async createSource(orgId: string, input: SourceInput, options: RequestOptions = {}): Promise<SourceRow> {
      return expectSourceRow(await request(
        buildWorkspaceUrl('sources', { orgId }),
        { method: 'POST', body: input, signal: options.signal },
      ));
    },

    async getSource(orgId: string, id: string, options: RequestOptions = {}): Promise<SourceRow> {
      return expectSourceRow(await request(
        buildWorkspaceUrl(`sources/${assertSegment(id)}`, { orgId }),
        { signal: options.signal },
      ));
    },

    async updateSource(
      orgId: string,
      id: string,
      patch: Partial<SourceInput>,
      options: RequestOptions = {},
    ): Promise<SourceRow> {
      return expectSourceRow(await request(
        buildWorkspaceUrl(`sources/${assertSegment(id)}`, { orgId }),
        { method: 'PATCH', body: patch, signal: options.signal },
      ));
    },

    async deleteSource(orgId: string, id: string, options: RequestOptions = {}): Promise<void> {
      expectRecord(await request(
        buildWorkspaceUrl(`sources/${assertSegment(id)}`, { orgId }),
        { method: 'DELETE', signal: options.signal },
      ));
    },

    async setCredential(
      orgId: string,
      id: string,
      credential: CredentialInput,
      options: RequestOptions = {},
    ): Promise<void> {
      expectRecord(await request(
        buildWorkspaceUrl(`sources/${assertSegment(id)}/credential`, { orgId }),
        { method: 'PUT', body: credential, signal: options.signal },
      ));
    },

    async clearCredential(orgId: string, id: string, options: RequestOptions = {}): Promise<void> {
      expectRecord(await request(
        buildWorkspaceUrl(`sources/${assertSegment(id)}/credential`, { orgId }),
        { method: 'DELETE', signal: options.signal },
      ));
    },

    async listRuns(orgId: string, sourceId: string, options: RequestOptions = {}): Promise<CrawlRunRow[]> {
      const body = expectRecord(await request(
        buildWorkspaceUrl(`sources/${assertSegment(sourceId)}/runs`, { orgId, limit: '20' }),
        { signal: options.signal },
      ));
      if (!Array.isArray(body.runs)) refuse();
      return body.runs as CrawlRunRow[];
    },

    async getDeviceSummary(
      orgId: string,
      deviceId: string,
      options: RequestOptions = {},
    ): Promise<DeviceSummary> {
      const record = expectRecord(await request(
        buildWorkspaceUrl(`devices/${assertSegment(deviceId)}/summary`, { orgId }),
        { signal: options.signal },
      ));
      if (typeof record.deviceId !== 'string') refuse();
      // Explicit aggregate-only projection: extra fields in the response are
      // dropped here, mirroring the server's own projection boundary.
      return {
        deviceId: record.deviceId,
        indexedFiles: Number(record.indexedFiles ?? 0),
        visibleSources: Number(record.visibleSources ?? 0),
        lastSuccessfulCrawlAt: typeof record.lastSuccessfulCrawlAt === 'string'
          ? record.lastSuccessfulCrawlAt
          : null,
        lastActivityAt: typeof record.lastActivityAt === 'string' ? record.lastActivityAt : null,
      };
    },
  };
}

export type WorkspaceApi = ReturnType<typeof createWorkspaceApi>;
