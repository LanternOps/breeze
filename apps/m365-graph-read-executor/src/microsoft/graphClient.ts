import type { CanonicalAppRoleAssignment } from '@breeze/shared/m365';
import type { OpaqueAccessToken } from './tokenClient';

const GRAPH_ORIGIN = 'https://graph.microsoft.com';
const GRAPH_API_ROOT = `${GRAPH_ORIGIN}/v1.0`;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PAGE_COUNT = 20;
const DEFAULT_MAX_ITEM_COUNT = 1_000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

export type GraphClientErrorCode =
  | 'graph_request_invalid'
  | 'graph_request_timeout'
  | 'graph_transport_failed'
  | 'graph_response_too_large'
  | 'graph_response_invalid'
  | 'graph_provider_rejected'
  | 'organization_probe_failed'
  | 'application_token_invalid';

export class GraphClientError extends Error {
  constructor(readonly code: GraphClientErrorCode) {
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

export interface MicrosoftGraphClient {
  probeTenant(input: {
    tenantId: string;
    accessToken: OpaqueAccessToken;
  }): Promise<GraphTenantObservation>;
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
  };
}
