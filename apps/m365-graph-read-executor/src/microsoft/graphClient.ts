import type { CanonicalAppRoleAssignment } from '@breeze/shared/m365';
import type { OpaqueAccessToken } from './tokenClient';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_API_ROOT = `${GRAPH_ORIGIN}/v1.0`;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGE_COUNT = 20;
const DEFAULT_MAX_ITEM_COUNT = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_SYNC_REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUS = new Set([429, 503]);

export type GraphClientErrorCode =
  | 'graph_request_invalid'
  | 'graph_request_timeout'
  | 'graph_transport_failed'
  | 'graph_response_too_large'
  | 'graph_response_invalid'
  | 'graph_provider_rejected'
  | 'organization_probe_failed'
  | 'application_token_invalid'
  | 'graph_permission_missing'
  | 'graph_license_required'
  | 'graph_not_found'
  | 'graph_throttled';

export class GraphClientError extends Error {
  constructor(readonly code: GraphClientErrorCode, readonly retryAfterSeconds?: number) {
    super(code);
    this.name = 'GraphClientError';
  }
}

export interface GraphTenantObservation {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly organizationDisplayName: string;
  readonly observedGrants: readonly CanonicalAppRoleAssignment[] | null;
}

export type GraphSyncStopReason = 'complete' | 'max_pages' | 'max_items' | 'paused' | 'deadline';

export interface GraphSyncRetryPolicy {
  maxAttempts: number;        // total attempts per page, including the first
  cumulativeBudgetMs: number; // total time spent sleeping across one page set
  fixedBackoffMs?: number;    // when set, ignore Retry-After (CA policies)
}

export interface GraphSyncLimits {
  maxItems: number;
  maxPages: number;
  maxResponseBytes: number;
  deadlineAt: number;             // epoch ms — hard cancellation point
  perRequestTimeoutMs?: number;   // default 30_000
  retry?: GraphSyncRetryPolicy;   // default { maxAttempts: 3, cumulativeBudgetMs: 60_000 }
}

export interface GraphSyncPageSet {
  items: Record<string, unknown>[];
  stopReason: GraphSyncStopReason;
  nextLink?: string;              // present whenever stopReason !== 'complete' and Graph offered one
  pages: number;
}

const DEFAULT_SYNC_RETRY: GraphSyncRetryPolicy = { maxAttempts: 3, cumulativeBudgetMs: 60_000 };

export interface MicrosoftGraphClient {
  probeTenant(input: {
    tenantId: string;
    accessToken: OpaqueAccessToken;
  }): Promise<GraphTenantObservation>;
  readResource(input: {
    accessToken: OpaqueAccessToken;
    path: string;
    select: readonly string[];
  }): Promise<Record<string, unknown>>;
  readCollection(input: {
    accessToken: OpaqueAccessToken;
    path: string;
    query: Record<string, string>;
    consistencyLevelEventual?: boolean;
    maxItems: number;
    maxPages: number;
  }): Promise<{ items: Record<string, unknown>[]; truncated: boolean }>;
  readSyncCollection(input: {
    accessToken: OpaqueAccessToken;
    path: string;                   // '/users' — also the expected nextLink path
    query?: Record<string, string>;
    startUrl?: string;              // resume point from a decrypted continuation
    limits: GraphSyncLimits;
    beforePage?: () => boolean;     // false ⇒ stop now, hand back nextLink (the sign-in limiter)
  }): Promise<GraphSyncPageSet>;
}

interface GraphClientConfig {
  applicationId: string;
  timeoutMs?: number;
  maxPageCount?: number;
  maxItemCount?: number;
  maxResponseBytes?: number;
}

interface GraphClientDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface RequestBudget {
  bytes: number;
  requests: number;
  items: number;
}

interface CollectionPage {
  value: unknown[];
  nextLink?: string;
}

function failure(code: GraphClientErrorCode): GraphClientError {
  return new GraphClientError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function fixedCollectionNextLink(raw: string, expectedPath: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw failure('graph_response_invalid');
  }
  if (
    url.protocol !== 'https:'
    || url.hostname !== 'graph.microsoft.com'
    || url.port
    || url.username
    || url.password
    || url.hash
    || url.pathname !== expectedPath
    || !url.pathname.startsWith('/v1.0/')
  ) {
    throw failure('graph_response_invalid');
  }
  return url.href;
}

function parseCollectionPage(body: unknown): CollectionPage {
  if (!isRecord(body) || !Array.isArray(body.value)) {
    throw failure('graph_response_invalid');
  }
  const next = body['@odata.nextLink'];
  if (next !== undefined && typeof next !== 'string') {
    throw failure('graph_response_invalid');
  }
  return next === undefined ? { value: body.value } : { value: body.value, nextLink: next };
}

async function readBoundedBody(
  response: Response,
  budget: RequestBudget,
  maxResponseBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
    try {
      if (BigInt(declaredLength) > BigInt(maxResponseBytes - budget.bytes)) {
        throw failure('graph_response_too_large');
      }
    } catch (error) {
      if (error instanceof GraphClientError) throw error;
    }
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let responseBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (budget.bytes + responseBytes > maxResponseBytes) {
        await reader.cancel();
        throw failure('graph_response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  budget.bytes += responseBytes;
  const bytes = new Uint8Array(responseBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw failure('graph_response_invalid');
  }
}

function graphUrl(path: string, query?: Record<string, string>): string {
  const url = new URL(`${GRAPH_API_ROOT}${path}`);
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
  return url.href;
}

const LICENSE_ERROR_CODE = 'Authentication_RequestFromNonPremiumTenantOrB2CTenant';

function retryAfterSecondsFromHeader(response: Response): number {
  const raw = response.headers.get('retry-after');
  const parsed = raw !== null && /^[0-9]{1,4}$/.test(raw) ? Number(raw) : 60;
  return Math.min(300, Math.max(1, parsed));
}

function graphErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.code === 'string') {
      return parsed.error.code;
    }
  } catch { /* not JSON */ }
  return undefined;
}

function readFailure(response: Response, body: string): GraphClientError {
  if (response.status === 403) {
    return failure(graphErrorCode(body) === LICENSE_ERROR_CODE
      ? 'graph_license_required'
      : 'graph_permission_missing');
  }
  if (response.status === 404) return failure('graph_not_found');
  if (response.status === 429) {
    return new GraphClientError('graph_throttled', retryAfterSecondsFromHeader(response));
  }
  return failure('graph_provider_rejected');
}

export function createMicrosoftGraphClient(
  config: GraphClientConfig,
  dependencies: GraphClientDependencies = {},
): MicrosoftGraphClient {
  const fetchImpl = dependencies.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRequestCount = config.maxPageCount ?? DEFAULT_MAX_PAGE_COUNT;
  const maxItemCount = config.maxItemCount ?? DEFAULT_MAX_ITEM_COUNT;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const configValid = CANONICAL_UUID.test(config.applicationId)
    && positiveInteger(timeoutMs)
    && positiveInteger(maxRequestCount)
    && positiveInteger(maxItemCount)
    && positiveInteger(maxResponseBytes);

  async function request(url: string, accessToken: OpaqueAccessToken, budget: RequestBudget): Promise<unknown> {
    if (budget.requests >= maxRequestCount) throw failure('graph_response_too_large');
    budget.requests += 1;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: { authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      const responseBody = await readBoundedBody(response, budget, maxResponseBytes);
      if (!response.ok) throw failure('graph_provider_rejected');
      return parseJson(responseBody);
    } catch (error) {
      if (error instanceof GraphClientError) throw error;
      if (timedOut) throw failure('graph_request_timeout');
      throw failure('graph_transport_failed');
    } finally {
      clearTimeout(timer);
    }
  }

  // Status-aware single request used only by the read methods.
  async function readRequest(
    url: string,
    accessToken: OpaqueAccessToken,
    budget: RequestBudget,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    if (budget.requests >= maxRequestCount) throw failure('graph_response_too_large');
    budget.requests += 1;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        headers: { authorization: `Bearer ${accessToken}`, ...headers },
        signal: controller.signal,
      });
      const responseBody = await readBoundedBody(response, budget, maxResponseBytes);
      if (!response.ok) throw readFailure(response, responseBody);
      return parseJson(responseBody);
    } catch (error) {
      if (error instanceof GraphClientError) throw error;
      if (timedOut) throw failure('graph_request_timeout');
      throw failure('graph_transport_failed');
    } finally {
      clearTimeout(timer);
    }
  }

  const nowMs = dependencies.now ?? (() => Date.now());
  const sleepImpl = dependencies.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(failure('graph_request_timeout')); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(failure('graph_request_timeout'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }));

  interface SyncRequestOptions {
    maxResponseBytes: number;
    perRequestTimeoutMs: number;
    retry: GraphSyncRetryPolicy;
    deadlineAt: number;
    deadlineSignal: AbortSignal;
  }

  /**
   * One page fetch under the sync profile: retries 429/503 while a policy
   * budget allows, composes the per-request timeout with the whole-call
   * deadline signal so an expiring deadline cancels the in-flight fetch, and
   * charges bytes against the caller's cumulative budget (NOT the client-wide
   * 512 KiB interactive one).
   */
  async function syncRequest(
    url: string,
    accessToken: OpaqueAccessToken,
    budget: RequestBudget,
    limits: SyncRequestOptions,
    throttleSpentMs: { value: number },
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const timeout = AbortSignal.timeout(limits.perRequestTimeoutMs);
      const signal = AbortSignal.any([timeout, limits.deadlineSignal]);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'error',
          headers: { authorization: `Bearer ${accessToken}` },
          signal,
        });
      } catch (error) {
        if (error instanceof GraphClientError) throw error;
        throw failure(signal.aborted ? 'graph_request_timeout' : 'graph_transport_failed');
      }

      if (RETRYABLE_STATUS.has(response.status)) {
        // Do not charge a throttle body against the byte budget.
        await response.body?.cancel().catch(() => {});
        const waitMs = limits.retry.fixedBackoffMs ?? retryAfterSecondsFromHeader(response) * 1_000;
        const outOfAttempts = attempt >= limits.retry.maxAttempts;
        const outOfBudget = throttleSpentMs.value + waitMs > limits.retry.cumulativeBudgetMs;
        const pastDeadline = nowMs() + waitMs + limits.perRequestTimeoutMs > limits.deadlineAt;
        if (outOfAttempts || outOfBudget || pastDeadline) {
          throw new GraphClientError('graph_throttled', Math.min(300, Math.max(1, Math.ceil(waitMs / 1_000))));
        }
        throttleSpentMs.value += waitMs;
        await sleepImpl(waitMs, limits.deadlineSignal);
        continue;
      }

      const responseBody = await readBoundedBody(response, budget, limits.maxResponseBytes);
      if (!response.ok) throw readFailure(response, responseBody);
      return parseJson(responseBody);
    }
  }

  async function collection(
    initialUrl: string,
    expectedPath: string,
    accessToken: OpaqueAccessToken,
    budget: RequestBudget,
  ): Promise<unknown[]> {
    const values: unknown[] = [];
    let url: string | undefined = initialUrl;
    while (url !== undefined) {
      const page = parseCollectionPage(await request(url, accessToken, budget));
      if (budget.items + page.value.length > maxItemCount) {
        throw failure('graph_response_too_large');
      }
      budget.items += page.value.length;
      values.push(...page.value);
      url = page.nextLink === undefined
        ? undefined
        : fixedCollectionNextLink(page.nextLink, expectedPath);
    }
    return values;
  }

  async function organizationProof(
    tenantId: string,
    accessToken: OpaqueAccessToken,
    budget: RequestBudget,
  ): Promise<string> {
    try {
      const path = '/v1.0/organization';
      const organizations = await collection(
        graphUrl('/organization', { '$select': 'id,displayName' }),
        path,
        accessToken,
        budget,
      );
      if (organizations.length !== 1 || !isRecord(organizations[0])) {
        throw failure('organization_probe_failed');
      }
      const { id, displayName } = organizations[0];
      if (id !== tenantId || typeof displayName !== 'string' || !displayName || displayName.length > 256) {
        throw failure('organization_probe_failed');
      }
      return displayName;
    } catch {
      throw failure('organization_probe_failed');
    }
  }

  async function applicationServicePrincipal(
    accessToken: OpaqueAccessToken,
    budget: RequestBudget,
  ): Promise<string> {
    try {
      const principal = await request(
        graphUrl(`/servicePrincipals(appId='${config.applicationId}')`, {
          '$select': 'id,appId',
        }),
        accessToken,
        budget,
      );
      if (budget.items + 1 > maxItemCount) {
        throw failure('application_token_invalid');
      }
      budget.items += 1;
      if (!isRecord(principal)) {
        throw failure('application_token_invalid');
      }
      const { id, appId } = principal;
      if (typeof id !== 'string' || !CANONICAL_UUID.test(id) || appId !== config.applicationId) {
        throw failure('application_token_invalid');
      }
      return id;
    } catch {
      throw failure('application_token_invalid');
    }
  }

  async function grants(
    applicationServicePrincipalId: string,
    accessToken: OpaqueAccessToken,
    budget: RequestBudget,
  ): Promise<readonly CanonicalAppRoleAssignment[] | null> {
    try {
      const assignmentPath = `/v1.0/servicePrincipals/${applicationServicePrincipalId}/appRoleAssignments`;
      const rawAssignments = await collection(
        `${GRAPH_ORIGIN}${assignmentPath}`,
        assignmentPath,
        accessToken,
        budget,
      );
      const assignments: Array<{ appRoleId: string; resourceId: string }> = [];
      for (const assignment of rawAssignments) {
        if (!isRecord(assignment)
          || typeof assignment.appRoleId !== 'string'
          || typeof assignment.resourceId !== 'string'
          || !CANONICAL_UUID.test(assignment.appRoleId)
          || !CANONICAL_UUID.test(assignment.resourceId)) {
          throw failure('graph_response_invalid');
        }
        assignments.push({ appRoleId: assignment.appRoleId, resourceId: assignment.resourceId });
      }

      const resourceIds = [...new Set(assignments.map((assignment) => assignment.resourceId))].sort();
      const resources = new Map<string, { applicationId: string; values: Map<string, string | null> }>();
      for (const resourceId of resourceIds) {
        const rawResource = await request(
          graphUrl(`/servicePrincipals/${resourceId}`, { '$select': 'appId,appRoles' }),
          accessToken,
          budget,
        );
        if (!isRecord(rawResource)
          || typeof rawResource.appId !== 'string'
          || !CANONICAL_UUID.test(rawResource.appId)
          || !Array.isArray(rawResource.appRoles)) {
          throw failure('graph_response_invalid');
        }
        if (budget.items + rawResource.appRoles.length > maxItemCount) {
          throw failure('graph_response_too_large');
        }
        budget.items += rawResource.appRoles.length;
        const values = new Map<string, string | null>();
        for (const role of rawResource.appRoles) {
          if (!isRecord(role)
            || typeof role.id !== 'string'
            || !CANONICAL_UUID.test(role.id)
            || (role.value !== null && typeof role.value !== 'string')) {
            throw failure('graph_response_invalid');
          }
          values.set(role.id, typeof role.value === 'string' && role.value ? role.value : null);
        }
        resources.set(resourceId, { applicationId: rawResource.appId, values });
      }

      const byKey = new Map<string, CanonicalAppRoleAssignment>();
      for (const assignment of assignments) {
        const resource = resources.get(assignment.resourceId);
        if (!resource) throw failure('graph_response_invalid');
        const grant: CanonicalAppRoleAssignment = {
          resourceApplicationId: resource.applicationId,
          appRoleId: assignment.appRoleId,
          value: resource.values.get(assignment.appRoleId) ?? null,
        };
        byKey.set(`${grant.resourceApplicationId}/${grant.appRoleId}`, grant);
      }
      return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, grant]) => grant);
    } catch {
      return null;
    }
  }

  return {
    async probeTenant(input) {
      if (!configValid
        || !CANONICAL_UUID.test(input.tenantId)
        || typeof input.accessToken !== 'string'
        || !input.accessToken) {
        throw failure('graph_request_invalid');
      }
      const budget = { bytes: 0, requests: 0, items: 0 };
      const organizationDisplayName = await organizationProof(input.tenantId, input.accessToken, budget);
      const applicationServicePrincipalId = await applicationServicePrincipal(input.accessToken, budget);
      const observedGrants = await grants(applicationServicePrincipalId, input.accessToken, budget);
      return {
        tenantId: input.tenantId,
        applicationId: config.applicationId,
        organizationDisplayName,
        observedGrants,
      };
    },

    async readResource(input) {
      if (!configValid
        || typeof input.accessToken !== 'string'
        || !input.accessToken
        || !input.path.startsWith('/')) {
        throw failure('graph_request_invalid');
      }
      const budget: RequestBudget = { bytes: 0, requests: 0, items: 0 };
      const body = await readRequest(
        graphUrl(input.path, { '$select': input.select.join(',') }),
        input.accessToken,
        budget,
      );
      if (!isRecord(body)) throw failure('graph_response_invalid');
      return body;
    },

    async readCollection(input) {
      if (!configValid
        || typeof input.accessToken !== 'string'
        || !input.accessToken
        || !input.path.startsWith('/')
        || !positiveInteger(input.maxItems)
        || !positiveInteger(input.maxPages)) {
        throw failure('graph_request_invalid');
      }
      const budget: RequestBudget = { bytes: 0, requests: 0, items: 0 };
      const headers = input.consistencyLevelEventual ? { ConsistencyLevel: 'eventual' } : undefined;
      const expectedPath = `/v1.0${input.path}`;
      const items: Record<string, unknown>[] = [];
      let truncated = false;
      let url: string | undefined = graphUrl(input.path, input.query);
      let pages = 0;
      while (url !== undefined) {
        pages += 1;
        const page = parseCollectionPage(await readRequest(url, input.accessToken, budget, headers));
        for (const value of page.value) {
          if (!isRecord(value)) throw failure('graph_response_invalid');
          if (items.length >= input.maxItems) {
            truncated = true;
            break;
          }
          items.push(value);
        }
        if (truncated) break;
        if (page.nextLink !== undefined && pages >= input.maxPages) {
          truncated = true;
          break;
        }
        url = page.nextLink === undefined
          ? undefined
          : fixedCollectionNextLink(page.nextLink, expectedPath);
      }
      return { items, truncated };
    },

    async readSyncCollection(input) {
      const { limits } = input;
      if (!configValid
        || typeof input.accessToken !== 'string'
        || !input.accessToken
        || !input.path.startsWith('/')
        || !positiveInteger(limits.maxItems)
        || !positiveInteger(limits.maxPages)
        || !positiveInteger(limits.maxResponseBytes)
        || !Number.isSafeInteger(limits.deadlineAt)) {
        throw failure('graph_request_invalid');
      }
      const expectedPath = `/v1.0${input.path}`;
      const perRequestTimeoutMs = limits.perRequestTimeoutMs ?? DEFAULT_SYNC_REQUEST_TIMEOUT_MS;
      const retry = limits.retry ?? DEFAULT_SYNC_RETRY;
      const budget: RequestBudget = { bytes: 0, requests: 0, items: 0 };
      const throttleSpentMs = { value: 0 };
      const deadline = new AbortController();
      // The OS timer that actually enforces the deadline against an in-flight
      // request MUST be driven by the real wall clock — setTimeout cannot take
      // an injected fake clock — even when `dependencies.now` is overridden
      // for the pre-page check below. In production the two coincide.
      const remaining = limits.deadlineAt - Date.now();
      const deadlineTimer = setTimeout(() => deadline.abort(), Math.max(0, remaining));
      const options: SyncRequestOptions = {
        maxResponseBytes: limits.maxResponseBytes,
        perRequestTimeoutMs,
        retry,
        deadlineAt: limits.deadlineAt,
        deadlineSignal: deadline.signal,
      };

      const items: Record<string, unknown>[] = [];
      let pages = 0;
      let url: string | undefined = input.startUrl === undefined
        ? graphUrl(input.path, input.query)
        : fixedCollectionNextLink(input.startUrl, expectedPath);
      let stopReason: GraphSyncStopReason = 'complete';

      try {
        while (url !== undefined) {
          if (pages >= limits.maxPages) { stopReason = 'max_pages'; break; }
          // Soft precheck only: "don't start another page once the deadline
          // has passed." The hard backstop for a request already in flight
          // when the deadline arrives is the AbortController deadlineSignal
          // threaded through syncRequest, not a margin added here.
          if (nowMs() >= limits.deadlineAt) { stopReason = 'deadline'; break; }
          if (input.beforePage !== undefined && !input.beforePage()) { stopReason = 'paused'; break; }

          const page = parseCollectionPage(await syncRequest(url, input.accessToken, budget, options, throttleSpentMs));
          pages += 1;
          let overflowed = false;
          for (const value of page.value) {
            if (!isRecord(value)) throw failure('graph_response_invalid');
            if (items.length >= limits.maxItems) { overflowed = true; break; }
            items.push(value);
          }
          if (overflowed) {
            stopReason = 'max_items';
            url = page.nextLink === undefined ? undefined : fixedCollectionNextLink(page.nextLink, expectedPath);
            break;
          }
          url = page.nextLink === undefined
            ? undefined
            : fixedCollectionNextLink(page.nextLink, expectedPath);
        }
      } finally {
        clearTimeout(deadlineTimer);
      }

      // `url` is the un-fetched resume point whenever we stopped early. In the
      // "paused before the first page" case it is the *initial* URL, not a
      // Graph-minted nextLink — omit it there so the API cannot resume a
      // page-1 URL through the continuation codec.
      if (stopReason === 'complete') return { items, stopReason, pages };
      const resumeLink = pages === 0 && input.startUrl === undefined ? undefined : url;
      return { items, stopReason, pages, ...(resumeLink === undefined ? {} : { nextLink: resumeLink }) };
    },
  };
}
